# AI Customer Assistance 二次开发指南

这是一个基于 Claude Code Agent SDK（默认接入 MiniMax 模型，同时保留 CodeBuddy Provider）的完整 Web Agent 应用模板。本指南将帮助你理解项目结构并进行二次开发。

## 目录

- [项目架构](#项目架构)
- [核心功能](#核心功能)
- [二次开发指南](#二次开发指南)
- [API 参考](#api-参考)
- [常见定制需求](#常见定制需求)

---

## 项目架构

### 技术栈

**后端**
- Node.js + Express (RESTful API)
- TypeScript
- @anthropic-ai/claude-agent-sdk (Claude Code Agent SDK，默认接入 MiniMax)
- @tencent-ai/agent-sdk (CodeBuddy Agent SDK，备用 Provider)
- better-sqlite3 (SQLite 数据库)

**前端**
- React 18 + TypeScript
- React Router (路由管理)
- TDesign React (UI 组件库)
- Vite (构建工具)

### 目录结构

```
web-agent/
├── server/                     # 后端服务
│   ├── index.ts               # Express 服务器入口
│   ├── db.ts                  # 数据库操作
│   ├── providers.ts           # Provider 抽象层（Claude Code / CodeBuddy）
│   ├── faqSearch.ts           # FAQ 关键词打分排序
│   ├── text.ts                # 繁简归一化
│   ├── embeddings.ts          # 远程 embedding 客户端（MiniMax / OpenAI / Cloudflare 三协议）
│   ├── vectorStore.ts         # sqlite-vec 向量存储
│   ├── vectorizeStore.ts      # Cloudflare Vectorize 向量存储
│   ├── retriever.ts           # 检索层：关键词 + 向量混合，RRF 融合
│   ├── ragConfig.ts           # 向量检索配置
│   ├── ragIndex.ts            # FAQ 向量索引
│   └── index.d.ts             # 类型定义
├── scripts/                   # 测试脚本（纯 tsx + assert，无测试框架）
│   ├── test-embeddings.mts    # embedding 客户端单测
│   ├── test-vector-store.mts  # 向量存储单测
│   ├── test-retriever.mts     # RRF 融合单测
│   ├── test-rag-config.mts    # 配置单测
│   ├── test-rag-index.mts     # 索引单测
│   ├── test-faq-search.mts    # 关键词检索回归（用数据库真实 FAQ）
│   └── test-e2e-rag.mts       # 端到端（起真实服务 + 真实 embedding）
├── src/                       # 前端源码
│   ├── components/            # React 组件
│   │   ├── ChatMessages.tsx   # 消息列表
│   │   ├── ChatInput.tsx      # 输入框
│   │   ├── ToolCallsCollapse.tsx  # 工具调用展示
│   │   ├── PermissionDialog.tsx   # 权限弹窗
│   │   ├── AgentConfigDialog.tsx  # Agent 配置
│   │   ├── Sidebar.tsx        # 侧边栏
│   │   ├── Header.tsx         # 顶部栏
│   │   └── ...
│   ├── hooks/                 # 自定义 Hooks
│   │   ├── useChat.ts         # 聊天逻辑
│   │   ├── useSessions.ts     # 会话管理
│   │   ├── useModels.ts       # 模型管理
│   │   ├── useAgents.ts       # Agent 管理
│   │   └── useTheme.ts        # 主题管理
│   ├── utils/                 # 纯工具函数
│   │   ├── sseParser.ts       # SSE 增量解析（处理跨 chunk 事件与中文乱码）
│   │   └── chatContent.ts     # 内容块构造（错误去重）
│   ├── pages/                 # 页面
│   │   └── ChatPage.tsx       # 聊天页面
│   ├── types.ts               # TypeScript 类型定义
│   ├── config.ts              # 应用配置
│   ├── App.tsx                # 应用入口
│   └── main.tsx               # React 入口
├── data/                      # 数据存储目录
│   └── chat.db               # SQLite 数据库
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 核心功能

### 1. Agent SDK 集成

**核心文件**: `server/providers.ts`（Provider 抽象层）、`server/index.ts`（HTTP 层）

应用支持两套 Agent SDK，通过 `server/providers.ts` 统一封装：

| Provider | SDK | 说明 |
|----------|-----|------|
| `claude`（默认） | `@anthropic-ai/claude-agent-sdk` | Claude Code 运行时，通过 Anthropic 兼容端点调用 MiniMax |
| `codebuddy` | `@tencent-ai/agent-sdk` | CodeBuddy 运行时 |

两个 SDK 的 `query()` 签名一致，差异（工具结果的投递方式、结果字段命名等）在 provider 层归一化为统一的 `AgentEvent` 事件流。

#### runAgent() - 统一的调用入口

```typescript
import { runAgent } from "./providers.js";

const stream = runAgent("claude", "用户的问题", {
  cwd: process.cwd(),           // 工作目录
  model: "MiniMax-M3.1-Flash", // 模型选择
  maxTurns: 10,                // 最大对话轮数
  systemPrompt: "系统提示词",   // 自定义系统提示
  permissionMode: "default",   // 权限模式
  resume: sessionId,           // 恢复对话上下文（同 provider 才可复用）
  canUseTool: async (toolName, input, options) => {
    // 工具权限控制
    return { behavior: 'allow', updatedInput: input };
  }
});

// 归一化后的事件流
for await (const event of stream) {
  // event.type: 'init' | 'text' | 'tool' | 'tool_result' | 'done' | 'error'
}
```

> 注意：两套 SDK 都把工具结果放在 `user` 消息的 `tool_result` block 里，而不是独立的
> `tool_result` 消息类型。provider 层已统一处理，业务代码只需消费 `AgentEvent`。

#### MiniMax 模型列表

```typescript
import { fetchClaudeModels } from "./providers.js";

// 实时拉取账号下可用的模型（失败时回退到内置列表）
const models = await fetchClaudeModels();
// → [{ modelId: "MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash" }, ...]
```

#### CodeBuddy 身份认证（仅 CodeBuddy Provider 使用）

```typescript
import { unstable_v2_authenticate } from "@tencent-ai/agent-sdk";

const result = await unstable_v2_authenticate({
  environment: 'external',
  onAuthUrl: async (authState) => {
    console.log('需要登录:', authState.authUrl);
  }
});
```

> 该调用会访问 CodeBuddy 认证服务，可能长时间无响应，因此 provider 层只在真正使用
> CodeBuddy 时才调用，并带 5 秒超时保护。

### 2. 数据库设计

**核心文件**: `server/db.ts`

使用 SQLite 存储会话和消息：

**sessions 表**
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  sdk_session_id TEXT,         -- Agent SDK 返回的 session_id
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**messages 表**
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL,
  tool_calls TEXT,             -- JSON 格式存储工具调用
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 3. 流式响应机制

**核心文件**: `server/index.ts` (POST /api/chat)

使用 Server-Sent Events (SSE) 实现流式响应：

```typescript
// 设置 SSE 响应头
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");

// 发送不同类型的事件
res.write(`data: ${JSON.stringify({ type: "init", sessionId, ... })}\n\n`);
res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
res.write(`data: ${JSON.stringify({ type: "tool", name, input, ... })}\n\n`);
res.write(`data: ${JSON.stringify({ type: "tool_result", ... })}\n\n`);
res.write(`data: ${JSON.stringify({ type: "permission_request", ... })}\n\n`);
res.write(`data: ${JSON.stringify({ type: "done", ... })}\n\n`);
```

**前端处理**: `src/hooks/useChat.ts`

```typescript
const reader = response.body?.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      
      switch (data.type) {
        case 'text':
          // 更新消息内容
          break;
        case 'tool':
          // 显示工具调用
          break;
        case 'permission_request':
          // 弹出权限请求弹窗
          break;
      }
    }
  }
}
```

### 4. 客服 Agent 的行为约束

**核心文件**: `server/index.ts`（提示词与工具禁用）、`server/providers.ts`（SDK 选项）、`server/faqSearch.ts`（检索）

默认的 AI 客服 Agent 有一条硬约束：**它输出的每一句话都是直接发给客户看的正文**。

早期版本没有这条约束，后果是——FAQ 没命中时客服会自己去跑 `Bash`/`Read` 翻项目文件，
然后把「我先查一下知识库…查询结果显示数据库里没有订单表…检测到意图：订单查询」
这段工程调试过程当成答复发给了客户。

三层约束叠在一起解决这个问题：

**① 禁用工具**（`server/providers.ts`）

```typescript
if (options.disableTools) {
  // tools: [] 清空可用工具白名单 —— 模型根本看不到工具，不会去尝试调用
  claudeOptions.tools = [];
  // disallowedTools 再兜一层，因为 SDK 自己也说了 BUILTIN_TOOL_NAMES 并不完整
  claudeOptions.disallowedTools = [...BUILTIN_TOOL_NAMES];
}
```

服务端 `canUseTool` 里对客服一律 `deny`，作为 CodeBuddy 侧的兜底
（CodeBuddy SDK 没有 `tools` 白名单选项，只有 `allowedTools`/`disallowedTools`）。
客服模式还会强制 `permissionMode=default`——`bypassPermissions` 会让 SDK 直接跳过
`canUseTool`，那样工具就真的执行了。

光靠 SDK 选项**挡不干净**，实测：

- CLI 会绕过 `disallowedTools` 直接调用它的占位工具 `DeferredToolPlaceholder`
  （`BUILTIN_TOOL_NAMES` 里没有这个名字，得手写）
- `tools: []` 只清空内置工具，管不到从本机 MCP 配置加载进来的工具
  （实测会冒出 `mcp__plugin_figma_figma__whoami`），要用 `mcp__*` 通配符单独禁
- 模型偶尔会自己决定去调工具，即使工具列表是空的

所以服务端还有第三层：**客服模式下丢弃所有 tool / tool_result 事件**，
既不推给前端也不入库，界面上就不会出现工具卡片。

**模式判定依据是 `agentId`，不是 systemPrompt**：

```typescript
// server/index.ts
const isCustomerService = !agentId || agentId === 'default';
```

前端每次发消息都会带上当前 agent 的提示词（包括内置 `default` 那个），
所以用「请求里有没有 systemPrompt」来判断会让客服模式在界面路径上永远不生效——
结果是模型拿不到 FAQ 上下文、不受输出边界约束，还会自己调 Bash 翻项目文件。

**② 提示词约束**（`buildCustomerServicePrompt`）

- 「输出边界」章节：禁止输出分析/检索/推理过程，禁止提 FAQ、意图识别、数据库、表结构
- 正反例 few-shot：给出「把工作过程发给客户」的错误示例和正确写法
- 「服务范围」章节：只负责售后问题，写作/编程/闲聊类请求要礼貌拒绝
- FAQ 为空时给的是**兜底话术指令**，不是「请根据通用知识回答」——后者会直接诱导模型自由发挥

**③ 检索质量**（`server/faqSearch.ts`）

FAQ 检索从「整句 `LIKE`」改成「切词 + 打分排序」，详见 README 的「FAQ 检索」一节。
检索不到就返回空，让模型走「查不到就转人工」的话术，而不是拿不相关的 FAQ 硬凑答案。

> **默认客服与自定义 Agent 的区别**：由 `agentId` 区分——内置的 `default` agent 走客服模式
> （用客服话术 + 注入 FAQ 上下文 + 禁用工具），用户自建的 Agent（编程助手、写作助手等）
> 保留自己的提示词和工具能力。

### 5. 权限控制机制

**核心文件**: `server/index.ts`, `src/hooks/useChat.ts`

支持四种权限模式（在 `src/types.ts` 中定义）：

```typescript
export type PermissionMode = 
  | 'default'              // 每次工具调用都需要确认
  | 'acceptEdits'          // 自动接受编辑类操作
  | 'plan'                 // 计划模式，只读
  | 'bypassPermissions';   // 跳过所有权限检查
```

**后端实现权限回调**:

```typescript
const canUseTool: CanUseTool = async (toolName, input, options) => {
  // bypassPermissions 模式直接放行
  if (permissionMode === 'bypassPermissions') {
    return { behavior: 'allow', updatedInput: input };
  }
  
  // 创建权限请求
  const requestId = uuidv4();
  
  // 发送权限请求到前端
  res.write(`data: ${JSON.stringify({ 
    type: "permission_request", 
    requestId,
    toolName,
    input,
    ...
  })}\n\n`);
  
  // 等待用户响应
  return new Promise((resolve) => {
    pendingPermissions.set(requestId, { resolve, ... });
  });
};
```

**前端显示权限弹窗**:

```typescript
// useChat.ts 接收权限请求
if (data.type === 'permission_request') {
  setPermissionRequest({
    requestId: data.requestId,
    toolName: data.toolName,
    input: data.input,
    ...
  });
}

// PermissionDialog.tsx 用户操作
const handleAllow = async () => {
  await fetch('/api/permission-response', {
    method: 'POST',
    body: JSON.stringify({
      requestId: permissionRequest.requestId,
      behavior: 'allow'
    })
  });
};
```

### 6. 会话恢复机制

**核心文件**: `server/index.ts`, `server/db.ts`

Agent SDK 支持使用 `resume` 参数恢复对话上下文：

```typescript
// 1. 从数据库获取 SDK 返回的 session_id
const session = db.getSession(sessionId);
const sdkSessionId = session.sdk_session_id;

// 2. 使用 resume 参数恢复对话
const stream = query({
  prompt: message,
  options: {
    ...(sdkSessionId ? { resume: sdkSessionId } : {})
  }
});

// 3. 从流中获取新的 session_id
for await (const msg of stream) {
  if (msg.type === "system" && msg.subtype === "init") {
    const newSdkSessionId = msg.session_id;
    
    // 4. 保存到数据库
    db.updateSession(sessionId, { sdk_session_id: newSdkSessionId });
  }
}
```

### 7. 自定义 Agent 管理

**核心文件**: `src/hooks/useAgents.ts`, `src/types.ts`

支持创建多个 Agent 配置：

```typescript
export interface CustomAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;        // 自定义系统提示词
  icon?: string;               // 图标
  color?: string;              // 颜色
  permissionMode?: PermissionMode;  // 默认权限模式
  createdAt: Date;
  updatedAt: Date;
}

// 使用 localStorage 持久化存储
const STORAGE_KEY = 'custom_agents';
localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
```

---

### 8. 向量检索层（RAG）

**核心文件**: `server/embeddings.ts`, `server/vectorStore.ts`, `server/retriever.ts`, `server/ragConfig.ts`, `server/ragIndex.ts`

关键词与向量两路并行检索，用 RRF（Reciprocal Rank Fusion）融合：

```
提问 → toSimplified → detectIntent
                        ↓
        ┌───────────────┴───────────────┐
   KeywordRetriever              VectorRetriever
   （rankFaq 打分，纯本地）      （embedding + sqlite-vec）
        └───────────────┬───────────────┘
                 RRF 融合 → Top-K → faqContext → LLM
```

**为什么用 RRF**：只看排名不看分数，因此不需要把「关键词打分」和「余弦距离」
归一化到同一量纲，也不用调融合权重。`score(doc) = Σ 1/(60 + rank)`。

**两种向量库后端**（`VECTOR_STORE` 配置切换，实现同一个 `VectorStore` 接口）：

| 后端 | 实测数据 | 注意 |
|---|---|---|
| `sqlite`（sqlite-vec，默认） | 136KB 二进制、查询 <1ms、写入立即可见 | 维度变化自动重建表 |
| `vectorize`（Cloudflare 托管） | 查询 250-700ms、**写入约 60~100 秒后才可查** | 索引维度创建后不可改；写入后有一段「索引未生效」窗口，期间自动降级为关键词检索 |

**Vectorize 的三个坑**（实测踩过）：

1. **写入是异步的** —— 向量先写 WAL，异步 job 重建索引。刚 upsert 就查会返回 0 条，
   所以 VectorizeStore 会记住最近一次写入时间，这段时间内查询直接降级，
   而不是把「还没生效」误判成「没有相似文档」
2. **索引维度创建后不可改** —— 换 embedding 模型（维度变了）必须删索引重建
3. **REST API 不是 OpenAI 格式** —— 查询是 `POST .../vectorize/v2/indexes/{name}/query`，
   写入是 `.../upsert`（NDJSON），响应是 `result.matches[].score`（相似度），
   与 OpenAI 的 `data[].embedding` 完全不同
4. **维度准备必须异步** —— Vectorize 要先查/建索引才知道维度，
   所以 `VectorStore.prepare(dim)` 是 async；否则随后的写入会因「维度未知」全部失败

**嵌入服务的坑**（实测踩过）：

- MiniMax 用 **HTTP 200 + `base_resp.status_code != 0`** 表达错误，
  只看 HTTP 状态码会把限流当成成功、拿到空向量
- Cloudflare Workers AI 用 **HTTP 200 + `success: false` + `errors[]`** 表达错误
- `vectors: null` / `result.data: []` 也是 HTTP 200，必须当作失败处理
- 限流码是 `1002`，触发指数退避重试；查询路径最多重试 2 次（约 3 秒），
  **不能为了向量检索让用户等 31 秒**，超时就降级
- **熔断**：连续失败 3 次后冷却 60 秒，期间直接失败降级、不发任何网络请求——
  否则 embedding 长期不可用时，每个用户请求都要白等一轮退避
- **维度必须与实际写入的向量同源**：不能拿 `type='query'` 的向量探维度、
  再用 `type='db'` 的向量写入（两者维度若不同，所有向量都会被拒且错维度被持久化，
  向量检索会**永久失效且几乎无日志**）。现在只发一次批量请求，维度取自那批向量
- **坏向量必须在校验后才进缓存**：含 NaN / 非数字 / 长度不一致的向量一旦入缓存，
  后续每次查询都会被向量库拒绝，表现为「向量检索开着、日志正常，但永远召回不到东西」

**降级矩阵**（任何一环坏掉都只损失该路召回，客服始终能回答）：

| 情况 | 行为 |
|---|---|
| sqlite-vec 未安装 / 加载失败 | `available=false`，仅关键词 |
| 未配 `EMBEDDING_API_KEY` | 向量检索不启用，仅关键词（默认） |
| embedding 超时 / 报错 / 限流 | 本次跳过向量，仅关键词 |
| 部分 FAQ 还没有向量 | 这些条目只参与关键词召回 |
| 两条路都失败 | 返回空，走提示词的「查不到就转人工」话术 |

**测试**：

```bash
npm test        # 6 个单测脚本，132 个断言
npm run test:e2e  # 起真实服务 + 真实 embedding 的端到端测试
```

e2e **不使用 mock embedding 服务**——配额不通就是不通，测试如实反映当前状态，
断言的是「无论 embedding 通不通，客服都必须正常回答」。

---

## 二次开发指南

### 场景 1: 修改应用名称和样式

**修改应用名称**

编辑 `src/config.ts`:

```typescript
export const APP_CONFIG = {
  name: '我的 AI 助手',           // 修改应用名称
  nameInitial: 'A',              // 修改首字母
  description: '你的智能助理',    // 修改描述
  version: '1.0.0',
};
```

**修改主题颜色**

编辑 `src/index.css`:

```css
:root {
  --primary-color: #0052d9;     /* 主色调 */
  --success-color: #00a870;     /* 成功色 */
  --warning-color: #ed7b2f;     /* 警告色 */
  --error-color: #e34d59;       /* 错误色 */
}
```

### 场景 2: 添加自定义 Agent 预设

编辑 `src/hooks/useAgents.ts` 的默认 Agent：

```typescript
const defaultAgent: CustomAgent = {
  id: 'default',
  name: '通用助手',
  description: '我是你的 AI 助手',
  systemPrompt: '你是一个专业的 AI 助手，擅长编程、写作和问答。',
  icon: 'MessageIcon',
  color: '#0052d9',
  permissionMode: 'default',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// 添加新的预设 Agent
const codeAgent: CustomAgent = {
  id: 'code-assistant',
  name: '代码助手',
  description: '专注于代码开发和调试',
  systemPrompt: '你是一个专业的代码助手，精通多种编程语言，善于代码审查、调试和优化。',
  icon: 'CodeIcon',
  color: '#00a870',
  permissionMode: 'acceptEdits',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DEFAULT_AGENTS = [defaultAgent, codeAgent];
```

### 场景 3: 添加自定义 API 端点

在 `server/index.ts` 中添加新的路由：

```typescript
// 获取会话统计信息
app.get("/api/stats", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const totalMessages = sessions.reduce((sum, session) => {
      const messages = db.getMessagesBySession(session.id);
      return sum + messages.length;
    }, 0);
    
    res.json({
      totalSessions: sessions.length,
      totalMessages,
      avgMessagesPerSession: totalMessages / sessions.length || 0
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 导出会话记录
app.get("/api/sessions/:sessionId/export", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    const messages = db.getMessagesBySession(sessionId);
    
    const exportData = {
      session,
      messages: messages.map(msg => ({
        ...msg,
        tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null
      }))
    };
    
    res.json(exportData);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

### 场景 4: 自定义工具调用展示

编辑 `src/components/ToolCallsCollapse.tsx`，修改工具调用的显示方式：

```typescript
const renderToolInput = (input: Record<string, unknown>) => {
  // 自定义显示逻辑
  if (input.command) {
    return (
      <div className="command-block">
        <code>{input.command}</code>
      </div>
    );
  }
  
  if (input.path) {
    return (
      <div className="file-path">
        📄 {input.path}
      </div>
    );
  }
  
  // 默认 JSON 显示
  return <pre>{JSON.stringify(input, null, 2)}</pre>;
};
```

### 场景 5: 添加消息导出功能

**后端**: 在 `server/index.ts` 中添加导出端点（见场景 3）

**前端**: 在 `src/components/ChatMessages.tsx` 中添加导出按钮：

```typescript
const handleExport = async () => {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/export`);
    const data = await response.json();
    
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json'
    });
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export failed:', error);
  }
};

// 在组件中添加按钮
<Button onClick={handleExport}>
  导出对话
</Button>
```

### 场景 6: 修改数据库结构

在 `server/db.ts` 中添加新字段或表：

```typescript
// 添加新字段到 sessions 表
db.exec(`
  ALTER TABLE sessions ADD COLUMN tags TEXT;
`);

// 创建新表
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    preferences TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// 添加操作函数
export function updateSessionTags(id: string, tags: string[]): boolean {
  const stmt = db.prepare('UPDATE sessions SET tags = ? WHERE id = ?');
  const result = stmt.run(JSON.stringify(tags), id);
  return result.changes > 0;
}
```

### 场景 7: 添加文件上传功能

**后端**: 在 `server/index.ts` 中添加上传端点：

```typescript
import multer from 'multer';
import path from 'path';

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

// 文件上传端点
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' });
  }
  
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    path: req.file.path,
    size: req.file.size
  });
});
```

**前端**: 在 `src/components/ChatInput.tsx` 中添加文件选择：

```typescript
const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;
  
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData
  });
  
  const data = await response.json();
  
  // 在消息中引用文件
  setInputValue(prev => prev + `\n[文件: ${data.originalName}]`);
};
```

### 场景 8: 添加代码高亮显示

安装依赖:

```bash
npm install react-syntax-highlighter @types/react-syntax-highlighter
```

在 `src/components/ChatMessages.tsx` 中使用：

```typescript
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

const renderMessageContent = (content: string) => {
  // 检测代码块
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  
  return content.split(codeBlockRegex).map((part, index) => {
    if (index % 3 === 1) {
      // 语言标识
      const language = part || 'text';
      const code = content.split(codeBlockRegex)[index + 1];
      
      return (
        <SyntaxHighlighter
          key={index}
          language={language}
          style={oneDark}
        >
          {code}
        </SyntaxHighlighter>
      );
    }
    
    if (index % 3 === 0) {
      return <span key={index}>{part}</span>;
    }
    
    return null;
  });
};
```

### 场景 9: 添加语音输入

使用 Web Speech API：

```typescript
// src/hooks/useSpeechRecognition.ts
import { useState, useEffect } from 'react';

export function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  
  useEffect(() => {
    if (!('webkitSpeechRecognition' in window)) {
      return;
    }
    
    const recognition = new (window as any).webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    
    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        }
      }
      
      if (finalTranscript) {
        setTranscript(prev => prev + finalTranscript);
      }
    };
    
    if (isListening) {
      recognition.start();
    } else {
      recognition.stop();
    }
    
    return () => recognition.stop();
  }, [isListening]);
  
  return {
    isListening,
    transcript,
    startListening: () => setIsListening(true),
    stopListening: () => setIsListening(false),
    resetTranscript: () => setTranscript('')
  };
}

// 在 ChatInput.tsx 中使用
const { isListening, transcript, startListening, stopListening, resetTranscript } = useSpeechRecognition();

useEffect(() => {
  if (transcript) {
    setInputValue(prev => prev + transcript);
    resetTranscript();
  }
}, [transcript]);
```

### 场景 10: 实现多标签页会话

**前端状态管理**: 在 `src/hooks/useSessions.ts` 中添加：

```typescript
const [openTabs, setOpenTabs] = useState<string[]>([]);

const openTab = useCallback((sessionId: string) => {
  setOpenTabs(prev => {
    if (!prev.includes(sessionId)) {
      return [...prev, sessionId];
    }
    return prev;
  });
}, []);

const closeTab = useCallback((sessionId: string) => {
  setOpenTabs(prev => prev.filter(id => id !== sessionId));
}, []);
```

**UI 实现**: 在 `src/components/Header.tsx` 中添加标签栏：

```typescript
<div className="tabs-container">
  {openTabs.map(tabId => {
    const session = sessions.find(s => s.id === tabId);
    return (
      <div 
        key={tabId}
        className={`tab ${currentSessionId === tabId ? 'active' : ''}`}
        onClick={() => navigate(`/chat/${tabId}`)}
      >
        <span>{session?.title}</span>
        <button onClick={(e) => {
          e.stopPropagation();
          closeTab(tabId);
        }}>×</button>
      </div>
    );
  })}
</div>
```

---

## API 参考

### 后端 API 端点

#### 健康检查
```
GET /api/health
响应: { status: "ok", timestamp: string }
```

#### Provider 列表
```
GET /api/providers
响应: {
  activeProvider: 'claude' | 'codebuddy',
  providers: Array<{
    id: 'claude' | 'codebuddy',
    name: string,
    description: string,
    defaultModel: string,
    isActive: boolean
  }>
}
```

#### 登录状态
```
GET /api/check-login?provider=claude
响应: {
  provider: 'claude' | 'codebuddy',
  isLoggedIn: boolean,
  method?: 'env' | 'cli' | 'none',
  envConfigured?: boolean,
  cliConfigured?: boolean,
  apiKey?: string,
  envVars?: { authToken?: string, baseUrl?: string, model?: string },
  providers: {
    claude: { ... },   // 各 provider 的鉴权状态
    codebuddy: { ... }
  }
}
```

#### 保存环境变量配置
```
POST /api/save-env-config
请求体: {
  // Claude Code (MiniMax)
  anthropicAuthToken?: string,
  anthropicBaseUrl?: string,
  anthropicModel?: string,
  // CodeBuddy
  apiKey?: string,
  authToken?: string,
  internetEnv?: string,
  baseUrl?: string
}
响应: { success: boolean, message: string }
```

#### 获取模型列表
```
GET /api/models?provider=claude
响应: {
  provider: 'claude' | 'codebuddy',
  models: Array<{ modelId: string, name: string, description?: string }>,
  defaultModel: string
}
```

#### 获取所有会话
```
GET /api/sessions
响应: {
  sessions: Array<{
    id: string,
    title: string,
    model: string,
    created_at: string,
    updated_at: string,
    messageCount: number
  }>
}
```

#### 获取单个会话
```
GET /api/sessions/:sessionId
响应: {
  session: DbSession,
  messages: Array<DbMessage>
}
```

#### 创建会话
```
POST /api/sessions
请求体: {
  model?: string,
  title?: string
}
响应: { session: DbSession }
```

#### 更新会话
```
PATCH /api/sessions/:sessionId
请求体: {
  title?: string,
  model?: string
}
响应: { success: boolean }
```

#### 删除会话
```
DELETE /api/sessions/:sessionId
响应: { success: boolean }
```

#### 发送消息 (SSE 流式响应)
```
POST /api/chat
请求体: {
  sessionId?: string,
  message: string,
  model?: string,
  systemPrompt?: string,
  cwd?: string,
  permissionMode?: PermissionMode
}
响应: Server-Sent Events
  - type: "init" - 初始化
  - type: "text" - 文本内容
  - type: "tool" - 工具调用
  - type: "tool_result" - 工具结果
  - type: "permission_request" - 权限请求
  - type: "done" - 完成
  - type: "error" - 错误
```

#### 权限响应
```
POST /api/permission-response
请求体: {
  requestId: string,
  behavior: 'allow' | 'deny',
  message?: string
}
响应: { success: boolean }
```

---

## 常见定制需求

### 1. 修改默认模型

编辑 `server/index.ts`:

```typescript
const defaultModel = "claude-opus-4";  // 修改默认模型
```

### 2. 修改最大对话轮数

编辑 `server/index.ts` 的聊天处理函数:

```typescript
const stream = query({
  prompt: message,
  options: {
    maxTurns: 20,  // 从 10 改为 20
    ...
  }
});
```

### 3. 添加环境变量支持

创建 `.env` 文件:

```bash
PORT=3001
# Claude Code (MiniMax)
AGENT_PROVIDER=claude
ANTHROPIC_AUTH_TOKEN=your_minimax_api_key
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
ANTHROPIC_MODEL=MiniMax-M3.1-Flash
# CodeBuddy（备用 Provider）
CODEBUDDY_API_KEY=your_api_key
CODEBUDDY_AUTH_TOKEN=your_auth_token
CODEBUDDY_BASE_URL=https://api.example.com
CODEBUDDY_INTERNET_ENVIRONMENT=external
```

在 `server/index.ts` 中使用:

```typescript
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3001;
```

### 4. 自定义消息格式

编辑 `src/types.ts`，扩展 Message 类型:

```typescript
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  timestamp: Date;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  contentBlocks?: ContentBlock[];
  // 自定义字段
  metadata?: {
    userId?: string;
    source?: string;
    tags?: string[];
  };
}
```

### 5. 添加用户认证

安装依赖:

```bash
npm install express-session passport passport-local bcrypt
```

在 `server/index.ts` 中添加认证中间件:

```typescript
import session from 'express-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';

app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// 配置认证策略
passport.use(new LocalStrategy(
  async (username, password, done) => {
    // 验证用户逻辑
    const user = await db.findUser(username);
    if (!user || !await bcrypt.compare(password, user.password)) {
      return done(null, false);
    }
    return done(null, user);
  }
));

// 保护路由
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: '需要登录' });
};

app.post('/api/chat', requireAuth, async (req, res) => {
  // 聊天逻辑
});
```

### 6. 添加消息搜索功能

在 `server/db.ts` 中添加:

```typescript
export function searchMessages(query: string): DbMessage[] {
  const stmt = db.prepare(`
    SELECT * FROM messages 
    WHERE content LIKE ? 
    ORDER BY created_at DESC 
    LIMIT 100
  `);
  return stmt.all(`%${query}%`) as DbMessage[];
}
```

在 `server/index.ts` 中添加端点:

```typescript
app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q || typeof q !== 'string') {
    return res.status(400).json({ error: '缺少查询参数' });
  }
  
  const messages = db.searchMessages(q);
  res.json({ messages });
});
```

### 7. 添加 Markdown 渲染

安装依赖:

```bash
npm install react-markdown remark-gfm
```

在 `src/components/ChatMessages.tsx` 中使用:

```typescript
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MessageContent = ({ content }: { content: string }) => (
  <ReactMarkdown 
    remarkPlugins={[remarkGfm]}
    components={{
      code: ({ node, inline, className, children, ...props }) => {
        const match = /language-(\w+)/.exec(className || '');
        return !inline && match ? (
          <SyntaxHighlighter
            language={match[1]}
            style={oneDark}
            {...props}
          >
            {String(children).replace(/\n$/, '')}
          </SyntaxHighlighter>
        ) : (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
    }}
  >
    {content}
  </ReactMarkdown>
);
```

### 8. 添加快捷键支持

在 `src/components/ChatInput.tsx` 中添加:

```typescript
const handleKeyDown = (e: React.KeyboardEvent) => {
  // Ctrl/Cmd + Enter 发送消息
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    handleSend();
  }
  
  // Esc 清空输入
  if (e.key === 'Escape') {
    setInputValue('');
  }
};

<textarea
  onKeyDown={handleKeyDown}
  ...
/>
```

### 9. 添加消息重新生成

在 `src/components/ChatMessages.tsx` 中添加:

```typescript
const handleRegenerate = async (messageId: string) => {
  // 找到该消息及其之前的用户消息
  const messageIndex = messages.findIndex(m => m.id === messageId);
  if (messageIndex < 0) return;
  
  const userMessage = messages[messageIndex - 1];
  if (!userMessage || userMessage.role !== 'user') return;
  
  // 删除该消息
  setSessions(prev => prev.map(s => {
    if (s.id === sessionId) {
      return {
        ...s,
        messages: s.messages.filter(m => m.id !== messageId)
      };
    }
    return s;
  }));
  
  // 重新发送用户消息
  await sendMessage(userMessage.content);
};
```

### 10. 添加会话分享功能

**后端**: 在 `server/index.ts` 中添加:

```typescript
app.post('/api/sessions/:sessionId/share', (req, res) => {
  const { sessionId } = req.params;
  const session = db.getSession(sessionId);
  const messages = db.getMessagesBySession(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: '会话不存在' });
  }
  
  // 生成分享 token
  const shareToken = uuidv4();
  
  // 保存分享信息到数据库
  db.createShare({
    token: shareToken,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()  // 7天后过期
  });
  
  res.json({ 
    shareUrl: `${req.protocol}://${req.get('host')}/share/${shareToken}` 
  });
});

app.get('/api/share/:token', (req, res) => {
  const { token } = req.params;
  const share = db.getShare(token);
  
  if (!share || new Date(share.expires_at) < new Date()) {
    return res.status(404).json({ error: '分享链接不存在或已过期' });
  }
  
  const session = db.getSession(share.session_id);
  const messages = db.getMessagesBySession(share.session_id);
  
  res.json({ session, messages });
});
```

---

## 调试技巧

### 1. 查看 Agent SDK 日志

在 `server/index.ts` 中添加详细日志:

```typescript
for await (const msg of stream) {
  console.log("[Stream] Message:", JSON.stringify(msg, null, 2));
  // 处理消息...
}
```

### 2. 查看数据库内容

使用 SQLite 命令行工具:

```bash
sqlite3 data/chat.db

.tables                           # 查看所有表
SELECT * FROM sessions;           # 查看所有会话
SELECT * FROM messages LIMIT 10;  # 查看最近 10 条消息
```

### 3. 前端调试

在浏览器控制台中查看状态:

```typescript
// 在 useChat.ts 中添加
useEffect(() => {
  console.log('[useChat] State:', {
    isLoading,
    currentSessionId,
    messagesCount: currentSession?.messages.length
  });
}, [isLoading, currentSessionId, currentSession]);
```

### 4. 网络请求调试

在 Chrome DevTools 的 Network 标签中:
- 筛选 `Fetch/XHR`
- 查看 `EventStream` 类型的请求（SSE）
- 查看请求和响应的详细内容

---

## 常见问题

### Q: 如何修改端口号？

A: 在 `server/index.ts` 中修改:

```typescript
const PORT = process.env.PORT || 3001;  // 改为 3001
```

同时更新 `package.json` 中的开发命令:

```json
{
  "scripts": {
    "dev:server": "PORT=3001 tsx watch server/index.ts"
  }
}
```

### Q: 如何禁用权限检查？

A: 在创建会话时设置 `permissionMode` 为 `bypassPermissions`:

```typescript
const newSession: Session = {
  ...
  permissionMode: 'bypassPermissions'
};
```

或者在 Agent 配置中设置默认权限模式。

### Q: 如何清空所有数据？

A: 执行以下操作:

```typescript
// 使用数据库函数
db.clearAllData();

// 或直接删除数据库文件
rm data/chat.db
```

### Q: 消息没有显示怎么办？

A: 检查以下几点:

1. 后端是否正常接收到消息
2. SSE 流是否正常发送（查看 Network 标签）
3. 前端是否正确解析 SSE 事件
4. 状态是否正确更新

添加日志进行调试:

```typescript
console.log('[SSE] Received data:', data);
console.log('[State] Messages:', currentSession?.messages);
```

### Q: 如何添加新的工具？

A: Agent SDK 的工具是由 SDK 内部管理的，无需在应用层添加。如果需要自定义工具行为，可以通过 `canUseTool` 回调进行控制。

---

## 生产部署

### 1. 构建生产版本

```bash
# 构建前端
npm run build

# 生成的文件在 dist/ 目录
```

### 2. 使用 PM2 部署

```bash
# 安装 PM2
npm install -g pm2

# 启动应用
pm2 start server/index.ts --name web-agent --interpreter tsx

# 查看状态
pm2 status

# 查看日志
pm2 logs web-agent
```

### 3. 使用 Docker 部署

创建 `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["npm", "start"]
```

构建和运行:

```bash
docker build -t web-agent .
docker run -p 3001:3001 -v $(pwd)/data:/app/data web-agent
```

### 4. 环境变量配置

在生产环境中使用环境变量:

```bash
# .env.production
PORT=3001
NODE_ENV=production
AGENT_PROVIDER=claude
ANTHROPIC_AUTH_TOKEN=your_minimax_api_key
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
ANTHROPIC_MODEL=MiniMax-M3.1-Flash
CODEBUDDY_API_KEY=your_api_key
CODEBUDDY_AUTH_TOKEN=your_auth_token
```

---

## 性能优化

### 1. 数据库优化

```typescript
// 添加索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
`);

// 定期清理旧数据
export function cleanOldSessions(daysOld: number = 30): void {
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM sessions WHERE updated_at < ?')
    .run(cutoffDate.toISOString());
}
```

### 2. 前端优化

```typescript
// 使用 React.memo 避免不必要的重渲染
export const ChatMessage = React.memo(({ message }: { message: Message }) => {
  // 组件内容
});

// 使用虚拟滚动处理大量消息
import { FixedSizeList } from 'react-window';

<FixedSizeList
  height={600}
  itemCount={messages.length}
  itemSize={100}
  width="100%"
>
  {({ index, style }) => (
    <div style={style}>
      <ChatMessage message={messages[index]} />
    </div>
  )}
</FixedSizeList>
```

### 3. 缓存优化

```typescript
// 缓存模型列表
let cachedModels: Model[] = [];
let cacheTime: number = 0;
const CACHE_DURATION = 5 * 60 * 1000;  // 5 分钟

app.get('/api/models', async (req, res) => {
  const now = Date.now();
  if (cachedModels.length > 0 && now - cacheTime < CACHE_DURATION) {
    return res.json({ models: cachedModels });
  }
  
  // 获取新数据
  const models = await fetchModels();
  cachedModels = models;
  cacheTime = now;
  
  res.json({ models });
});
```

---

## 扩展阅读

- [Claude Code Agent SDK 文档](https://code.claude.com/docs/en/agent-sdk/overview)
- [MiniMax 开放平台](https://platform.minimaxi.com)
- [CodeBuddy Agent SDK 文档](https://codebuddy.tencent.com)
- [Express.js 官方文档](https://expressjs.com/)
- [React Router 文档](https://reactrouter.com/)
- [TDesign React 组件库](https://tdesign.tencent.com/react/)
- [better-sqlite3 文档](https://github.com/WiseLibs/better-sqlite3)
- [Server-Sent Events (SSE) 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)

---

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个模板。

## License

MIT
