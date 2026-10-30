import express from "express";
import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";
import { rankFaq } from "./faqSearch.js";
import { toSimplified } from "./text.js";
import { embedTexts } from "./embeddings.js";
import { createVectorStore, type VectorStore } from "./vectorStore.js";
import { createVectorizeStore } from "./vectorizeStore.js";
import { retrieveFaqs } from "./retriever.js";
import { getRagConfig } from "./ragConfig.js";
import { indexFaqs } from "./ragIndex.js";
import {
  CLAUDE_FALLBACK_MODELS,
  DEFAULT_PROVIDER,
  PROVIDERS,
  checkClaudeAuth,
  checkCodebuddyAuth,
  checkCodebuddyEnv,
  fetchClaudeModels,
  getClaudeConfig,
  isProviderId,
  resolveProvider,
  runAgent,
  type PermissionOutcome,
  type ProviderId,
} from "./providers.js";

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionOutcome) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

// 权限请求超时时间（5分钟）
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = PROVIDERS[DEFAULT_PROVIDER].defaultModel;

// ==================== RAG（向量检索）====================
// 默认关闭：只有 VECTOR_SEARCH=on 且配了 key 才启用。
// sqlite-vec 加载失败也只影响向量检索本身，不影响服务启动——
// 检索层会自动退化为纯关键词检索。
//
// 配置在每次请求时读取（getRagConfig），不在模块加载时快照，
// 这样在设置页改完 key 无需重启服务。向量库后端切换时会重建 store。
let vectorStoreCache: { kind: string; store: VectorStore } | null = null;

function getVectorStore(config: ReturnType<typeof getRagConfig>): VectorStore {
  if (vectorStoreCache?.kind === config.vectorStore) return vectorStoreCache.store;
  const store: VectorStore =
    config.vectorStore === 'vectorize'
      ? createVectorizeStore(config.vectorize)
      : createVectorStore(db.default);
  vectorStoreCache = { kind: config.vectorStore, store };
  return store;
}

// ==================== AI 客服核心逻辑 ====================

/** 意向分类 */
type CustomerIntent = "退款" | "订单查询" | "技术支持" | "转人工" | "通用";

/** 意图关键词规则 */
const INTENT_RULES: Array<{ intent: CustomerIntent; keywords: string[]; priority: number }> = [
  {
    intent: "退款",
    keywords: ["退款", "退货", "退钱", "退款申请", "退款进度", "退款被拒", "怎么退款", "申请退款", "退货退款", "退货地址", "退到哪里", "寄回"],
    priority: 10
  },
  {
    intent: "订单查询",
    keywords: ["订单", "物流", "快递", "发货", "签收", "查单", "取消订单", "我的订单", "运单号", "修改订单", "改地址", "订单状态"],
    priority: 10
  },
  {
    intent: "技术支持",
    keywords: ["闪退", "崩溃", "登录", "登录不上", "支付失败", "无法支付", "卡顿", "打不开", "报错", "bug", "修改密码", "忘记密码", "账号安全", "修改手机"],
    priority: 10
  },
  {
    intent: "转人工",
    keywords: ["转人工", "人工客服", "人工", "客服电话", "找客服", "真人", "联系客服", "投诉", "建议"],
    priority: 15
  },
  {
    intent: "通用",
    keywords: ["工作时间", "营业时间", "你好", "在吗", "帮助", "help"],
    priority: 5
  }
];

/** 识别用户意图 */
function detectIntent(message: string): { intent: CustomerIntent; confidence: number; matchedKeywords: string[] } {
  // 内部再归一化一次，繁体输入也要能命中简体关键词
  const normalizedMsg = toSimplified(message).toLowerCase().trim();

  let bestMatch: { intent: CustomerIntent; confidence: number; matchedKeywords: string[] } = {
    intent: "通用",
    confidence: 0.1,
    matchedKeywords: []
  };

  for (const rule of INTENT_RULES) {
    const matched: string[] = [];
    for (const kw of rule.keywords) {
      if (normalizedMsg.includes(kw.toLowerCase())) {
        matched.push(kw);
      }
    }
    if (matched.length > 0) {
      const confidence = Math.min(0.3 + matched.length * 0.15, 0.95) * (rule.priority / 15);
      if (confidence > bestMatch.confidence) {
        bestMatch = { intent: rule.intent, confidence: Math.round(confidence * 100) / 100, matchedKeywords: matched };
      }
    }
  }

  return bestMatch;
}

/** 生成客服 Agent 系统提示词 */
function buildCustomerServicePrompt(intent: CustomerIntent, faqContext: string): string {
  // 有命中时把 FAQ 当作唯一知识来源；没命中时给出兜底指令，
  // 而不是像以前那样让模型「根据通用知识回答」——那会直接诱导它自由发挥
  const knowledgeSection = faqContext
    ? `以下是当前唯一可用的知识来源，请严格基于它作答，不要补充知识之外的信息：

${faqContext}`
    : `本次没有匹配到任何 FAQ 条目。
- 不要凭猜测回答具体业务数据（订单数量、金额、时间、物流状态等）。
- 按当前意图给出「客户下一步该怎么做」的引导，或建议转人工。
- 话术要像客服，不要解释你为什么查不到。
- 如果用户提的问题不属于售后服务范围（写作、编程、翻译、闲聊等），礼貌地说明你只负责售后服务相关的问题，并邀请他提出相关问题，不要真的去完成那个请求。`;

  const basePrompt = `你是一个专业的 AI 客服助手，名为「AI Customer Assistance」，负责为用户提供高效、友好的服务。

## 服务范围
你只负责售后服务相关的问题：退款、订单查询与物流、技术支持、转人工。
不处理与售后无关的请求（写作、编程、翻译、闲聊等）——遇到这类请求，礼貌说明你只负责售后服务，并引导用户说出售后相关的问题，不要真的去完成那个请求。

## 核心规则
1. **身份与语气**：始终以「AI Customer Assistance」自称，语气亲切、专业、有耐心。开头问候，结尾确认用户是否还有其他问题。
2. **多轮对话**：记住对话历史，理解上下文。如果用户补充信息，要结合上下文理解。

## 输出边界（最重要）
- 你输出的每一句话都是直接发给客户看的，不是给同事看的汇报。
- 只输出答复本身，不要输出分析过程、检索过程、推理过程、查询步骤或思考过程。
- 不要出现「我先查一下」「根据检索结果」「系统返回」「数据显示」这类过程性表述。
- 不要提 FAQ、意图识别、数据库、表结构、接口这类内部概念——客户只关心答案。
- 不要用编号列出你做过的工作，编号只在「客户该怎么操作」时才有意义。

3. **FAQ 知识库**：回答问题前，先参考以下 FAQ 知识库内容，确保回答准确一致。

${knowledgeSection}

4. **禁止行为**：
   - 不要编造不存在的信息（如"承诺 2 小时内退款"而实际需要 1-3 个工作日）
   - 不要承诺你无法做到的事情
   - 不要透露内部系统信息

## 当前用户意图：${intent}
## 当前时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}

## 按意图处理指南：
- **退款**：先引导用户在订单详情页操作，说明退款流程和时间。FAQ 有答案时直接引用。无法解决时提供人工转接。
- **订单查询**：引导用户至「我的订单」页面，告知物流查询方法。如涉及丢件/未收到等复杂问题，协助核实后转人工。
- **技术支持**：提供逐步排查步骤。常见问题（闪退/登录/支付）按 FAQ 答案回复。复杂技术问题记录信息后转人工。
- **转人工**：直接确认用户诉求，收集必要信息（联系方式、问题描述），然后告知用户将转接人工客服。
- **通用**：友好回应，引导用户说明具体需求。若用户提出的是与售后无关的请求（写作、编程、闲聊等），说明你只负责售后服务相关的问题并邀请他提出售后问题，不要真的去完成那个请求。

## 转人工条件
以下情况必须建议转人工，并告知用户将记录问题由专员处理：
- FAQ 中没有匹配答案且无法通过引导页面操作解决
- 涉及丢件、物流纠纷、退款申诉等需要人工介入的情况
- 用户明确要求转人工
- 用户连续 3 轮对话仍无法解决问题

转人工回复模板：「我暂时无法直接为您处理这个问题，已将您的情况记录（问题摘要）。我们的客服专员会在工作时间（9:00-21:00）内优先联系您。您也可以在对话框中回复"转人工"直接转接。」

## 回答示例
❌ 错误（把工作过程发给了客户）：
「我先查一下知识库。查询结果显示数据库里没有订单表，所以我没法回答您有多少订单。检测到意图：订单查询。」

✅ 正确：
「您好，您的订单可以在登录后的『我的订单』页面查看，那里能看到全部订单和物流状态。如果您需要针对某笔订单具体处理，回复『转人工』我帮您转接专员。」

## 回复格式
- 简洁清晰，使用适当的分段
- 涉及操作步骤时使用编号列表
- 重要信息（如电话号码、时间）可加粗提示`;

  return basePrompt;
}

// ==================== 健康检查 ====================

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ==================== Provider 相关 ====================

app.get("/api/providers", (req, res) => {
  const activeProvider = resolveProvider();
  res.json({
    activeProvider,
    providers: Object.values(PROVIDERS).map(meta => ({
      ...meta,
      isActive: meta.id === activeProvider,
    })),
  });
});

// ==================== 登录相关 ====================

type LoginMethod = 'env' | 'cli' | 'none';

interface LoginStatusResponse {
  isLoggedIn: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string;
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
    model?: string;
  };
}

app.get("/api/check-login", async (req, res) => {
  const requested = req.query.provider;
  const provider = resolveProvider(typeof requested === 'string' ? requested : undefined);

  // 只有真正使用 CodeBuddy 时才探测它的 CLI 登录状态（探测会访问 CodeBuddy 认证服务）
  const [claudeStatus, codebuddyStatus] = [
    checkClaudeAuth(),
    provider === 'codebuddy' ? await checkCodebuddyAuth() : checkCodebuddyEnv(),
  ];

  const status = provider === 'codebuddy' ? codebuddyStatus : claudeStatus;

  const response: LoginStatusResponse & {
    provider: ProviderId;
    activeProvider: ProviderId;
    providers: Record<ProviderId, LoginStatusResponse>;
  } = {
    provider,
    activeProvider: provider,
    isLoggedIn: status.isLoggedIn,
    method: status.method,
    envConfigured: status.envConfigured,
    cliConfigured: status.cliConfigured,
    error: status.error,
    apiKey: status.apiKey,
    envVars: status.envVars,
    providers: {
      claude: claudeStatus as LoginStatusResponse,
      codebuddy: codebuddyStatus as LoginStatusResponse,
    },
  };

  res.json(response);
});

app.post("/api/save-env-config", (req, res) => {
  const {
    apiKey, authToken, internetEnv, baseUrl,
    anthropicAuthToken, anthropicBaseUrl, anthropicModel
  } = req.body;

  const configuredVars: string[] = [];

  // --- Claude Code (MiniMax) ---
  if (anthropicAuthToken) {
    process.env.ANTHROPIC_AUTH_TOKEN = anthropicAuthToken;
    configuredVars.push('ANTHROPIC_AUTH_TOKEN');
  }
  if (anthropicBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
    configuredVars.push('ANTHROPIC_BASE_URL');
  }
  if (anthropicModel) {
    process.env.ANTHROPIC_MODEL = anthropicModel;
    configuredVars.push('ANTHROPIC_MODEL');
  }

  // --- CodeBuddy ---
  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }

  if (configuredVars.length === 0) {
    return res.status(400).json({ error: '请至少配置一项鉴权信息' });
  }

  cachedModels = [];

  res.json({
    success: true,
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// ==================== 模型相关 ====================

app.get("/api/models", async (req, res) => {
  const requested = req.query.provider;
  const provider = resolveProvider(typeof requested === 'string' ? requested : undefined);

  try {
    if (provider === 'codebuddy') {
      const { unstable_v2_createSession } = await import('@tencent-ai/agent-sdk');
      if (cachedModels.length === 0) {
        console.log("[Models] Creating session to fetch available models...");
        const session = await unstable_v2_createSession({ cwd: process.cwd() });
        const models = await session.getAvailableModels();
        if (models && Array.isArray(models)) {
          cachedModels = models;
        }
      }

      res.json({
        provider,
        models: cachedModels.length > 0 ? cachedModels : [
          { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
        ],
        defaultModel: PROVIDERS.codebuddy.defaultModel
      });
      return;
    }

    // Claude Code：直接向 MiniMax 的 Anthropic 兼容端点拉取模型列表
    const config = getClaudeConfig();
    const models = await fetchClaudeModels(config);
    res.json({
      provider,
      models,
      defaultModel: config.model || PROVIDERS.claude.defaultModel
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      provider,
      models: provider === 'codebuddy'
        ? [
            { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
            { modelId: "claude-opus-4", name: "Claude Opus 4" }
          ]
        : CLAUDE_FALLBACK_MODELS,
      defaultModel: PROVIDERS[provider].defaultModel,
      error: error?.message || String(error)
    });
  }
});

// ==================== 会话 API ====================

app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }

    const messages = db.getMessagesBySession(sessionId);
    const rating = db.getRatingBySession(sessionId);

    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null
    }));

    res.json({ session, messages: parsedMessages, rating: rating || null });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

app.post("/api/sessions", (req, res) => {
  try {
    const { model, title = "新对话", provider } = req.body;
    const resolvedProvider = resolveProvider(provider);
    const now = new Date().toISOString();

    const session = db.createSession({
      id: uuidv4(),
      title,
      model: model || PROVIDERS[resolvedProvider].defaultModel,
      sdk_session_id: null,
      provider: resolvedProvider,
      created_at: now,
      updated_at: now
    });

    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model } = req.body;

    const success = db.updateSession(sessionId, { title, model });

    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = db.deleteSession(sessionId);

    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// ==================== FAQ API ====================

app.get("/api/faq/all", (req, res) => {
  try {
    const faqs = db.getAllFaqs();
    res.json({ faqs });
  } catch (error: any) {
    console.error("[FAQ] Error:", error);
    res.status(500).json({ error: error?.message || "获取 FAQ 失败" });
  }
});

app.get("/api/faq/search", (req, res) => {
  try {
    const { q = "", category } = req.query;

    if (!q || String(q).trim().length === 0) {
      return res.json({ faqs: [], query: q });
    }

    let faqs;
    if (category && String(category).trim()) {
      faqs = db.searchFaqByCategory(String(category).trim(), String(q).trim());
    } else {
      faqs = db.searchFaq(String(q).trim());
    }

    res.json({ faqs, query: q });
  } catch (error: any) {
    console.error("[FAQ Search] Error:", error);
    res.status(500).json({ error: error?.message || "搜索 FAQ 失败" });
  }
});

// ==================== 满意度评价 API ====================

app.post("/api/ratings", (req, res) => {
  try {
    const { sessionId, score, comment } = req.body;

    if (!sessionId || !score) {
      return res.status(400).json({ error: "缺少必要参数：sessionId, score" });
    }

    if (score < 1 || score > 5) {
      return res.status(400).json({ error: "评分必须在 1-5 之间" });
    }

    // 检查是否已评价
    const existing = db.getRatingBySession(sessionId);
    if (existing) {
      return res.status(400).json({ error: "该会话已经评价过了" });
    }

    const rating = db.createRating({
      id: uuidv4(),
      session_id: sessionId,
      score,
      comment: comment || null,
      created_at: new Date().toISOString()
    });

    res.json({ rating });
  } catch (error: any) {
    console.error("[Rating] Error:", error);
    res.status(500).json({ error: error?.message || "提交评价失败" });
  }
});

app.get("/api/ratings/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const rating = db.getRatingBySession(sessionId);
    res.json({ rating: rating || null });
  } catch (error: any) {
    console.error("[Rating] Error:", error);
    res.status(500).json({ error: error?.message || "获取评价失败" });
  }
});

// ==================== 管理后台 API ====================

app.get("/api/admin/dashboard", (req, res) => {
  try {
    const stats = db.getDashboardStats();
    res.json(stats);
  } catch (error: any) {
    console.error("[Admin Dashboard] Error:", error);
    res.status(500).json({ error: error?.message || "获取统计数据失败" });
  }
});

app.get("/api/admin/conversations", (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || "50"));
    const offset = parseInt(String(req.query.offset || "0"));
    const result = db.getAdminConversations(limit, offset);
    res.json(result);
  } catch (error: any) {
    console.error("[Admin Conversations] Error:", error);
    res.status(500).json({ error: error?.message || "获取对话列表失败" });
  }
});

// ==================== 权限响应 API ====================

app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;

  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);

  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }

  pendingPermissions.delete(requestId);

  if (behavior === 'allow') {
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input
    });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: message || '用户拒绝了此操作'
    });
  }

  res.json({ success: true });
});

// ==================== 聊天 API（核心）====================

app.post("/api/chat", async (req, res) => {
  const { sessionId, message, model, systemPrompt: customSystemPrompt, cwd, permissionMode, provider: requestedProvider, agentId } = req.body;

  const provider = resolveProvider(requestedProvider);

  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Provider: ${provider}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // ===== 意图识别 =====
  // 繁体输入先转简体，否则匹配不到简体关键词
  const normalizedMessage = toSimplified(message);
  const intentResult = detectIntent(normalizedMessage);
  console.log(`[Chat] 意图识别: ${intentResult.intent} (置信度: ${intentResult.confidence})`);
  console.log(`[Chat] 匹配关键词: ${intentResult.matchedKeywords.join(', ')}`);

  // ===== FAQ 检索 =====
  // 关键词打分 + 向量检索两路并行，RRF 融合。
  // 向量路任何一环出问题（没配 key / 没索引 / embedding 报错）都自动降级为纯关键词。
  const ragConfig = getRagConfig();
  const vectorStore = getVectorStore(ragConfig);
  let faqItems: db.DbFaq[] = [];
  try {
    const allFaqs = db.getAllFaqs();
    const faqById = new Map(allFaqs.map(f => [f.id, f]));
    const ranked = await retrieveFaqs(normalizedMessage, {
      topK: ragConfig.topK,
      keyword: (q, k) =>
        rankFaq(allFaqs, q, { limit: k, category: intentResult.intent }).map(f => ({ id: f.id })),
      vector:
        ragConfig.enabled && vectorStore.available
          ? async (q, k) => {
              try {
                if (vectorStore.dim === null) return [];
                const vectors = await embedTexts([q], ragConfig.embedding, 'query');
                const vector = vectors?.[0];
                if (!vector) return [];
                const rows = await vectorStore.query(vector, k);
                return rows.map(row => ({ id: row.id }));
              } catch (error) {
                console.warn(
                  '[Vector] 向量检索失败，降级为关键词检索:',
                  (error as Error)?.message
                );
                return [];
              }
            }
          : undefined,
    });
    faqItems = ranked.map(item => faqById.get(item.id)).filter(Boolean) as db.DbFaq[];
    console.log(`[Chat] FAQ 检索结果: ${faqItems.length} 条匹配${faqItems.length ? `：${faqItems.map(f => f.question).join(' / ')}` : ''}`);
  } catch (faqError: any) {
    console.error("[Chat] FAQ 检索失败:", faqError);
  }

  // ===== 获取或创建会话 =====
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();

  if (!session) {
    console.log(`[Chat] 创建新会话`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      model: model || PROVIDERS[provider].defaultModel,
      sdk_session_id: null,
      provider,
      created_at: now,
      updated_at: now
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}`);
  }

  const selectedModel = model || session.model;
  // 只有同一 provider 的会话才能复用 SDK session id
  const sdkSessionId = session.provider === provider ? session.sdk_session_id : null;

  // 创建用户消息 ID 和助手消息 ID
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 保存用户消息到数据库
  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: message,
      model: null,
      created_at: now,
      tool_calls: null
    });
    console.log(`[Chat] 用户消息已保存: ${userMessageId}`);
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 保存意图日志
  try {
    db.logIntent({
      session_id: session.id,
      message_id: userMessageId,
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      details: JSON.stringify({ keywords: intentResult.matchedKeywords, faqMatches: faqItems.length })
    });
  } catch (logError: any) {
    console.error(`[Chat] 保存意图日志失败:`, logError);
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 构建 FAQ 上下文（无命中时传空串，由提示词给出兜底话术指令）
  const faqContext = faqItems.length > 0
    ? faqItems.map(f => `【${f.category}】Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : "";

  // 使用自定义提示词或 AI 客服默认提示词
  //
  // 判断依据是 agentId，不是「请求里有没有 systemPrompt」：
  // 前端每次发消息都会带上当前 agent 的 systemPrompt（包括内置 default agent 的），
  // 用 systemPrompt 是否为空来判断，会让客服模式在 UI 路径上永远不生效——
  // 结果是模型不拿到 FAQ 上下文、不受输出边界约束，还会自己调 Bash 翻项目文件。
  //
  // 只有内置的 default agent 走客服模式；用户自建的 Agent（编程/写作助手等）
  // 保留自己的提示词和工具能力。
  const isCustomerService = !agentId || agentId === 'default';
  const systemPrompt = isCustomerService
    ? buildCustomerServicePrompt(intentResult.intent, faqContext)
    : (customSystemPrompt || buildCustomerServicePrompt(intentResult.intent, faqContext));

  // 工作目录
  const workingDir = cwd || process.cwd();

  // 客户端断开时中断 Agent 运行，避免往已关闭的连接写数据导致进程崩溃
  //
  // 必须监听 res 的 'close'，不能监听 req 的 'close'：
  // Node >= 16 起，req 的 'close' 表示「请求体已读完」，而不是「客户端断开」。
  // express.json() 在进入 handler 前已把 body 读完，因此 req 'close' 会在 handler
  // 刚开始的下一个 tick 就触发，此时 res.writableEnded 仍为 false，
  // 结果 Agent 刚启动就被 abort，SDK 抛出 "Claude Code process aborted by user"。
  //
  // res 的 'close' 在响应正常结束时也会触发，但那时 res.writableFinished === true，
  // 用它区分「正常结束」和「连接被提前断开」。
  const abortController = new AbortController();
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      clientGone = true;
      abortController.abort();
      console.log(`[Chat] 客户端已断开，中断 Agent 运行`);
    }
  });

  /** 安全地写 SSE 数据（客户端已断开时直接忽略） */
  const writeSse = (payload: unknown): boolean => {
    if (clientGone || res.writableEnded || res.destroyed) return false;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch (error) {
      console.warn("[Chat] SSE 写入失败:", (error as Error)?.message);
      clientGone = true;
      abortController.abort();
      return false;
    }
  };

  // 同一次失败可能被上报两次（SDK 的 result(is_error) 事件 + 抛异常），
  // 用它保证错误只推送一次
  let errorSent = false;

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Provider: ${provider}`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Intent: ${intentResult.intent}`);

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID?: string }
    ): Promise<PermissionOutcome> => {
      console.log(`[Permission] Tool request: ${toolName}`);

      // 客服 Agent 不允许使用任何工具。tools: [] 已经让模型看不到工具了，
      // 这里再一律 deny 兜底 —— CodeBuddy SDK 没有工具白名单，只能靠这道闸。
      if (isCustomerService) {
        console.warn(`[Permission] Denied (客服 Agent 不允许使用工具): ${toolName}`);
        return { behavior: 'deny', message: '客服助手不支持调用工具' };
      }

      if (permissionMode === 'bypassPermissions') {
        console.log(`[Permission] Bypassing permissions for ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      }

      const requestId = uuidv4();
      const permissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        sessionId: session.id,
        timestamp: Date.now()
      };

      if (!writeSse({
        type: "permission_request",
        ...permissionRequest
      })) {
        // 客户端已断开，不必再等待授权
        return { behavior: 'deny', message: '客户端已断开' };
      }

      return new Promise<PermissionOutcome>((resolve, reject) => {
        const pending: PendingPermission = {
          resolve,
          reject,
          toolName,
          input,
          sessionId: session.id,
          timestamp: Date.now()
        };

        pendingPermissions.set(requestId, pending);

        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            console.log(`[Permission] Request timeout: ${requestId}`);
            resolve({
              behavior: 'deny',
              message: '权限请求超时'
            });
          }
        }, PERMISSION_TIMEOUT);
      });
    };

    const stream = runAgent(provider, message, {
      cwd: workingDir,
      model: selectedModel,
      maxTurns: 10,
      systemPrompt,
      // 客服模式下强制 default：bypassPermissions 会让 SDK 直接跳过 canUseTool，
      // 那样工具就真的执行了。客服不允许执行任何工具。
      permissionMode: isCustomerService ? "default" : (permissionMode || "default"),
      resume: sdkSessionId,
      abortController,
      canUseTool,
      disableTools: isCustomerService,
    });

    let fullResponse = "";
    let toolCalls: Array<{
      id: string;
      name: string;
      input?: Record<string, unknown>;
      status: string;
      result?: string;
      isError?: boolean;
    }> = [];
    let newSdkSessionId: string | null = null;

    // 发送会话信息和意图识别结果
    writeSse({
      type: "init",
      sessionId: session.id,
      userMessageId,
      assistantMessageId,
      model: selectedModel,
      provider,
      intent: intentResult.intent,
      confidence: intentResult.confidence
    });

    for await (const event of stream) {
      if (clientGone) {
        console.log(`[Chat] 客户端已断开，停止处理事件`);
        break;
      }

      if (event.type === "init") {
        newSdkSessionId = event.sessionId;
        console.log(`[Stream] Got SDK session_id: ${newSdkSessionId}`);

        if (newSdkSessionId && newSdkSessionId !== sdkSessionId) {
          db.updateSession(session.id, { sdk_session_id: newSdkSessionId, provider });
          console.log(`[Stream] Saved SDK session_id to database`);
        }
      } else if (event.type === "text") {
        fullResponse += event.content;
        writeSse({ type: "text", content: event.content });
      } else if (event.type === "tool") {
        // 客服模式下工具事件一律丢弃：模型偶尔会自己决定去调工具
        // （实测会冒出 CLI 的 DeferredToolPlaceholder 和本机 MCP 工具，
        //   SDK 的 tools/disallowedTools 都挡不住），这些卡片对客户毫无意义。
        // 丢弃后客户看到的就只有客服的答复本身。
        if (isCustomerService) {
          console.warn(`[Chat] 客服模式丢弃工具调用: ${event.name}`);
          continue;
        }
        const toolCall = {
          id: event.id || uuidv4(),
          name: event.name,
          input: event.input || {},
          status: "running"
        };
        toolCalls.push(toolCall);
        writeSse({
          type: "tool",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          status: toolCall.status
        });
      } else if (event.type === "tool_result") {
        if (isCustomerService) continue;
        const tool = toolCalls.find(t => t.id === event.toolId) || toolCalls[toolCalls.length - 1];
        if (tool) {
          tool.status = event.isError ? "error" : "completed";
          tool.isError = event.isError;
          tool.result = event.content;
          writeSse({
            type: "tool_result",
            toolId: tool.id,
            content: tool.result,
            isError: event.isError
          });
        }
      } else if (event.type === "done") {
        toolCalls.forEach(tool => {
          if (tool.status === "running") {
            tool.status = "completed";
            writeSse({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" });
          }
        });
        writeSse({
          type: "done",
          duration: event.durationMs,
          cost: event.costUsd
        });
      } else if (event.type === "error") {
        errorSent = true;
        writeSse({ type: "error", message: event.message });
      }
    }

    // 保存助手消息
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
    });

    // 更新会话标题
    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, {
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel
      });
    }

    console.log(`[Chat] 请求完成 ✓`);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Message:`, error?.message);

    const errorMessage = error?.message || "处理请求时发生错误";
    // 同一次失败会先由 SDK 的 result(is_error) 事件报一次，再由这里的异常报一次，
    // 只推送一次，避免客户端显示两个一模一样的错误
    if (!errorSent) {
      writeSse({ type: "error", message: errorMessage });
    }
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
});

// ==================== 启动服务器 ====================

// 单个请求的异常不应该拖垮整个服务（例如客户端中途断开）
process.on("unhandledRejection", (reason) => {
  console.error("[Server] 未处理的 Promise 拒绝:", reason);
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║   🤖 AI Customer Assistance 服务已启动     ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据库: SQLite (data/chat.db)          ║
║     功能: FAQ检索 | 意图识别 | 满意度评价   ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
});

// ==================== FAQ 向量索引（异步，不阻塞启动）====================
// 索引失败只记日志：知识库没索引好，客服仍能靠关键词检索正常回答。
{
  const ragConfig = getRagConfig();
  if (ragConfig.enabled) {
    void (async () => {
      try {
        const written = await indexFaqs(
          getVectorStore(ragConfig),
          // 索引是后台任务，可以多退避几次（限流时多试几轮）
          (texts, type) => embedTexts(texts, ragConfig.embedding, type, 5),
          db.getAllFaqs(),
          { model: ragConfig.embedding.model }
        );
        if (written > 0) {
          console.log(`[Vector] 已索引 ${written} 条 FAQ`);
        } else {
          console.warn('[Vector] FAQ 索引未完成，向量检索将退化为关键词检索');
        }
      } catch (error) {
        console.warn('[Vector] FAQ 索引异常:', (error as Error)?.message);
      }
    })();
  } else {
    console.log('[Vector] 向量检索未启用（VECTOR_SEARCH 未开启或未配置 key），使用关键词检索');
  }
}
