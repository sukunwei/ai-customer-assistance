import express from "express";
import { query, unstable_v2_createSession, unstable_v2_authenticate, PermissionResult, CanUseTool } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import * as db from "./db.js";

const execAsync = promisify(exec);

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
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
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = "claude-sonnet-4";

// ==================== 智能客服核心逻辑 ====================

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
  const normalizedMsg = message.toLowerCase().trim();

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
  const basePrompt = `你是一个专业的智能客服助手，名为「小智」，负责为用户提供高效、友好的服务。

## 核心规则
1. **身份与语气**：始终以「小智」自称，语气亲切、专业、有耐心。开头问候，结尾确认用户是否还有其他问题。
2. **多轮对话**：记住对话历史，理解上下文。如果用户补充信息，要结合上下文理解。
3. **FAQ 知识库**：回答问题前，先参考以下 FAQ 知识库内容，确保回答准确一致：

${faqContext || "（暂无匹配的 FAQ 条目）"}

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
- **通用**：友好回应，引导用户说明具体需求。

## 转人工条件
以下情况必须建议转人工，并告知用户将记录问题由专员处理：
- FAQ 中没有匹配答案且无法通过引导页面操作解决
- 涉及丢件、物流纠纷、退款申诉等需要人工介入的情况
- 用户明确要求转人工
- 用户连续 3 轮对话仍无法解决问题

转人工回复模板：「我暂时无法直接为您处理这个问题，已将您的情况记录（问题摘要）。我们的客服专员会在工作时间（9:00-21:00）内优先联系您。您也可以在对话框中回复"转人工"直接转接。」

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
  };
}

app.get("/api/check-login", async (req, res) => {
  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };

  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;

  if (apiKey || authToken) {
    response.envConfigured = true;
    if (apiKey) {
      response.envVars!.apiKey = apiKey.slice(0, 8) + '****' + apiKey.slice(-4);
      response.apiKey = response.envVars!.apiKey;
    }
    if (authToken) {
      response.envVars!.authToken = authToken.slice(0, 8) + '****' + authToken.slice(-4);
    }
    if (internetEnv) {
      response.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      response.envVars!.baseUrl = baseUrl;
    }
  }

  try {
    let needsLogin = false;
    const result = await unstable_v2_authenticate({
      environment: 'external',
      onAuthUrl: async (authState) => {
        needsLogin = true;
        console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
        response.error = '未登录，请先登录 CodeBuddy CLI';
      }
    });

    if (!needsLogin && result?.userinfo) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      if (response.envConfigured) {
        response.method = 'env';
      } else {
        response.method = 'cli';
      }
      console.log('[Check Login] 已登录用户:', result.userinfo.userName);
    } else if (!needsLogin) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    console.error("[Check Login] SDK Error:", error);
    if (response.envConfigured) {
      response.isLoggedIn = true;
      response.method = 'env';
    } else {
      response.error = error?.message || String(error);
      response.method = 'none';
    }
  }

  res.json(response);
});

app.post("/api/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;

  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }

  const configuredVars: string[] = [];

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

  cachedModels = [];

  res.json({
    success: true,
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// ==================== 模型相关 ====================

app.get("/api/models", async (req, res) => {
  try {
    if (cachedModels.length === 0) {
      console.log("[Models] Creating session to fetch available models...");
      const session = await unstable_v2_createSession({ cwd: process.cwd() });
      console.log("[Models] Session created, calling getAvailableModels()...");
      const models = await session.getAvailableModels();
      console.log("[Models] Got", models.length, "models");
      if (models && Array.isArray(models)) {
        cachedModels = models;
      }
    }

    res.json({
      models: cachedModels.length > 0 ? cachedModels : [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
      ],
      defaultModel
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel,
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
    const { model = defaultModel, title = "新对话" } = req.body;
    const now = new Date().toISOString();

    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
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
  const { sessionId, message, model, systemPrompt: customSystemPrompt, cwd, permissionMode } = req.body;

  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // ===== 意图识别 =====
  const intentResult = detectIntent(message);
  console.log(`[Chat] 意图识别: ${intentResult.intent} (置信度: ${intentResult.confidence})`);
  console.log(`[Chat] 匹配关键词: ${intentResult.matchedKeywords.join(', ')}`);

  // ===== FAQ 检索 =====
  let faqItems: db.DbFaq[] = [];
  try {
    if (intentResult.intent !== "通用" && intentResult.intent !== "转人工") {
      faqItems = db.searchFaqByCategory(intentResult.intent, message);
    }
    if (faqItems.length === 0) {
      faqItems = db.searchFaq(message);
    }
    console.log(`[Chat] FAQ 检索结果: ${faqItems.length} 条匹配`);
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
      model: model || defaultModel,
      sdk_session_id: null,
      created_at: now,
      updated_at: now
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}`);
  }

  const selectedModel = model || session.model;
  const sdkSessionId = session.sdk_session_id;

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

  // 构建 FAQ 上下文
  const faqContext = faqItems.length > 0
    ? faqItems.map(f => `【${f.category}】Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    : "（暂无匹配的 FAQ 条目，请根据通用知识回答）";

  // 使用自定义提示词或智能客服默认提示词
  const systemPrompt = customSystemPrompt || buildCustomerServicePrompt(intentResult.intent, faqContext);

  // 工作目录
  const workingDir = cwd || process.cwd();

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Intent: ${intentResult.intent}`);

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.log(`[Permission] Tool request: ${toolName}`);

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

      res.write(`data: ${JSON.stringify({
        type: "permission_request",
        ...permissionRequest
      })}\n\n`);

      return new Promise<PermissionResult>((resolve, reject) => {
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

    const stream = query({
      prompt: message,
      options: {
        cwd: workingDir,
        model: selectedModel,
        maxTurns: 10,
        systemPrompt,
        permissionMode: permissionMode || 'default',
        canUseTool,
        ...(sdkSessionId ? { resume: sdkSessionId } : {})
      }
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
    res.write(`data: ${JSON.stringify({
      type: "init",
      sessionId: session.id,
      userMessageId,
      assistantMessageId,
      model: selectedModel,
      intent: intentResult.intent,
      confidence: intentResult.confidence
    })}\n\n`);

    let currentToolId: string | null = null;

    for await (const msg of stream) {
      if (msg.type === "system" && (msg as any).subtype === "init") {
        newSdkSessionId = (msg as any).session_id;
        console.log(`[Stream] Got SDK session_id: ${newSdkSessionId}`);

        if (newSdkSessionId && newSdkSessionId !== sdkSessionId) {
          db.updateSession(session.id, { sdk_session_id: newSdkSessionId });
          console.log(`[Stream] Saved SDK session_id to database`);
        }
      } else if (msg.type === "assistant") {
        const content = msg.message.content;

        if (typeof content === "string") {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              fullResponse += block.text;
              res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
            } else if (block.type === "tool_use") {
              currentToolId = block.id || uuidv4();
              const toolInput = (block as any).input || {};

              const toolCall = {
                id: currentToolId,
                name: block.name,
                input: toolInput,
                status: "running"
              };
              toolCalls.push(toolCall);
              res.write(`data: ${JSON.stringify({
                type: "tool",
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
                status: toolCall.status
              })}\n\n`);
            }
          }
        }
      } else if (msg.type === "tool_result") {
        const msgAny = msg as any;
        const toolId = msgAny.tool_use_id || currentToolId;
        const isError = msgAny.is_error || false;
        const content = msgAny.content;

        const tool = toolCalls.find(t => t.id === toolId) || toolCalls[toolCalls.length - 1];
        if (tool) {
          tool.status = isError ? "error" : "completed";
          tool.isError = isError;
          tool.result = typeof content === 'string'
            ? content
            : JSON.stringify(content);
          res.write(`data: ${JSON.stringify({
            type: "tool_result",
            toolId: tool.id,
            content: tool.result,
            isError: isError
          })}\n\n`);
        }
        currentToolId = null;
      } else if (msg.type === "result") {
        toolCalls.forEach(tool => {
          if (tool.status === "running") {
            tool.status = "completed";
            res.write(`data: ${JSON.stringify({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ type: "done", duration: msg.duration, cost: msg.cost })}\n\n`);
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
    res.end();
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Message:`, error?.message);

    const errorMessage = error?.message || "处理请求时发生错误";
    res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
    res.end();
  }
});

// ==================== 启动服务器 ====================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     🤖 智能客服 Agent 服务已启动            ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据库: SQLite (data/chat.db)          ║
║     功能: FAQ检索 | 意图识别 | 满意度评价   ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
});
