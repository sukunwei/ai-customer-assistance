# AI Customer Assistance

一个基于 [Claude Code Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)（默认接入 [MiniMax](https://platform.minimaxi.com) 模型）构建的 AI 客服 Web 应用，具备意图识别、FAQ 知识库检索、向量检索（RAG）、满意度评价和管理后台等完整客服功能。

## 功能特性

- 🤖 **AI 智能对话** — 基于 Agent SDK 的流式对话，实时返回 AI 回复
- 🔍 **FAQ 知识库** — 16 条预设常见问题，支持关键词检索自动匹配答案
- 🧠 **意图识别** — 自动识别用户意图（退款、订单查询、技术支持、转人工、通用）
- 💬 **快捷提问** — 首页提供 6 个常用问题快捷入口，一键发送
- ⭐ **满意度评价** — 每轮对话支持 1-5 星评分 + 文字评价
- 📊 **管理后台** — 独立管理页面，查看会话统计、满意度分布、意图分析
- 🔀 **双 Provider** — Claude Code (MiniMax) 与 CodeBuddy 可随时切换
- 🔒 **权限控制** — 支持 4 种权限模式，工具调用可实时弹窗确认
- 💾 **数据持久化** — SQLite 本地数据库，会话和消息自动保存

## 技术栈

| 层面 | 技术 |
|------|------|
| 后端 | Node.js + Express + TypeScript |
| 前端 | React 18 + TypeScript + Vite |
| UI | TDesign React 组件库 |
| AI | Claude Code Agent SDK (`@anthropic-ai/claude-agent-sdk`)，备选 CodeBuddy Agent SDK (`@tencent-ai/agent-sdk`) |
| 模型 | MiniMax（Anthropic 兼容端点 `https://api.minimax.io/anthropic`） |
| 数据库 | SQLite (`better-sqlite3`) |

## 环境要求

- **Node.js** ≥ 18（推荐使用 22.x）
- **npm** 或 **yarn**
- **MiniMax API Key**（用于 AI 对话功能，配置见下方「配置说明」）
- 使用 CodeBuddy 作为备用 Provider 时，需 **CodeBuddy CLI** 已登录

## 快速开始

### 第一步：安装依赖

```bash
cd smart-customer-service
npm install
```

> ⚠️ **Windows 用户注意**：`better-sqlite3` 需要原生编译。如果安装失败，请参考下方「常见问题」。

### 第二步：启动开发服务器

```bash
npm run dev
```

此命令会同时启动：
- **前端**（Vite）— `http://localhost:5173`
- **后端**（Express）— `http://localhost:3001`

### 第三步：访问应用

在浏览器中打开 **http://localhost:5173** 即可使用。

## 使用说明

### 普通用户

1. 打开首页，看到「AI Customer Assistance」欢迎界面
2. 点击快捷提问按钮，或在输入框输入问题
3. AI 客服会自动识别意图并回复
4. 对话结束后可进行满意度评分

### 管理员

1. 点击侧边栏「管理后台」进入管理页面
2. 查看今日会话量、平均评分等统计数据
3. 查看满意度分布图和意图分析图
4. 浏览所有对话记录

## 项目结构

```
smart-customer-service/
├── server/                    # 后端服务
│   ├── index.ts               # Express 服务器（含意图识别、FAQ检索逻辑）
│   └── db.ts                  # 数据库操作（会话、消息、FAQ、评价）
├── src/                       # 前端源码
│   ├── components/            # React 组件
│   │   ├── ChatMessages.tsx   # 消息列表
│   │   ├── ChatInput.tsx      # 输入框
│   │   ├── SatisfactionRating.tsx  # 满意度评价组件
│   │   ├── NewChatView.tsx    # 新对话欢迎页（含快捷提问）
│   │   ├── Sidebar.tsx        # 侧边栏
│   │   └── Header.tsx         # 顶部栏
│   ├── pages/                 # 页面组件
│   │   ├── ChatPage.tsx       # 聊天页面
│   │   └── AdminPage.tsx      # 管理后台页面
│   ├── hooks/                 # 自定义 Hooks
│   ├── types.ts               # TypeScript 类型定义
│   ├── config.ts              # 应用配置
│   ├── App.tsx                # 路由入口
│   └── main.tsx               # React 入口
├── data/                      # 数据存储
│   └── chat.db                # SQLite 数据库（自动创建）
├── package.json
├── vite.config.ts
└── README.md
```

## 可用命令

```bash
# 同时启动前后端（开发模式）
npm run dev

# 仅启动后端
npm run dev:server

# 仅启动前端
npm run dev:client

# 构建生产版本
npm run build

# 预览生产版本
npm run preview

# 运行生产版本（需先 build）
npm start
```

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/providers` | GET | 获取可用的 Agent Provider 列表与当前生效的 Provider |
| `/api/check-login` | GET | 检查 Provider 鉴权状态（`?provider=claude\|codebuddy`） |
| `/api/models` | GET | 获取可用模型列表（`?provider=claude\|codebuddy`） |
| `/api/sessions` | GET | 获取所有会话 |
| `/api/sessions` | POST | 创建新会话 |
| `/api/sessions/:id` | GET | 获取单个会话详情 |
| `/api/sessions/:id` | PATCH | 更新会话 |
| `/api/sessions/:id` | DELETE | 删除会话 |
| `/api/chat` | POST | 发送消息（SSE 流式响应） |
| `/api/permission-response` | POST | 响应权限请求 |
| `/api/faq/search` | GET | 搜索 FAQ 知识库 |
| `/api/ratings` | GET/POST | 查询/提交满意度评价 |
| `/api/admin/dashboard` | GET | 管理后台统计数据 |
| `/api/admin/conversations` | GET | 管理后台对话记录 |

## 配置说明

### Provider 选择

应用支持两套 Agent SDK，可在「设置」页面或环境变量中切换：

| Provider | SDK | 说明 |
|----------|-----|------|
| `claude`（默认） | `@anthropic-ai/claude-agent-sdk` | Claude Code 运行时，通过 Anthropic 兼容端点调用 MiniMax 模型 |
| `codebuddy` | `@tencent-ai/agent-sdk` | CodeBuddy 运行时，需要 CodeBuddy CLI 登录或 API Key |

```bash
AGENT_PROVIDER=claude   # claude | codebuddy
```

### Claude Code (MiniMax) 认证

**方式一：环境变量配置（推荐）**

```bash
# .env 或启动前 export
ANTHROPIC_AUTH_TOKEN=your_minimax_api_key
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
ANTHROPIC_MODEL=MiniMax-M3.1-Flash
```

**方式二：Web UI 配置**

在应用的「设置」页面中配置环境变量（仅在当前服务器进程有效）。

> Claude Code Agent SDK 会以内置的 Claude Code 运行时启动子进程，并继承服务进程的环境变量，
> 因此设置页写入的 `ANTHROPIC_*` 会立即生效。模型列表通过 `${ANTHROPIC_BASE_URL}/v1/models` 实时拉取。

### CodeBuddy 认证（备用 Provider）

**方式一：使用 CodeBuddy CLI 登录**

```bash
codebuddy login
npm run dev
```

**方式二：环境变量配置**

```bash
CODEBUDDY_API_KEY=your_api_key
CODEBUDDY_AUTH_TOKEN=your_auth_token
CODEBUDDY_INTERNET_ENVIRONMENT=external
CODEBUDDY_BASE_URL=https://api.example.com
```

### 权限模式

应用支持四种权限模式（在设置页面切换）：

| 模式 | 说明 |
|------|------|
| `default` | 每次工具调用需要用户确认 |
| `acceptEdits` | 自动接受文件编辑类操作 |
| `plan` | 计划模式（只读，不执行操作） |
| `bypassPermissions` | 跳过所有权限检查 |

> **默认的 AI 客服 Agent 不使用任何工具。**
>
> 客服的知识来源只有 FAQ 知识库。早期版本允许客服调用 Bash/Read，它在 FAQ 没命中时会自己去翻项目文件，
> 结果把「我先查一下…数据库里没有订单表」这段工程调试过程当成了客服答复发给客户。
>
> 现在默认客服会：
>
> - 用 `tools: []` + `disallowedTools`（含 `DeferredToolPlaceholder`、`mcp__*`）禁掉工具
> - 服务端 `canUseTool` 一律拒绝，并强制 `permissionMode=default`（`bypassPermissions` 会让 SDK
>   跳过 `canUseTool`，那样工具就真执行了）
> - **丢弃所有工具事件**，不推给前端、也不入库——SDK 选项挡不干净：实测 CLI 仍会绕过
>   `disallowedTools` 直接调用占位工具，模型偶尔也会自己决定去调 MCP 工具
>
> 三层叠起来，客户看到的就只有面向客户的正文。
>
> 这个取舍也意味着客服**无法查询真实的订单/物流数据**——订单数量、金额、物流状态这类问题
> 会引导用户去「我的订单」页面查看，或转人工处理。
>
> **客服模式与自定义 Agent 模式由 `agentId` 区分**，不是靠「请求里有没有 systemPrompt」：
> 前端每次发消息都会带上当前 agent 的提示词（包括内置 `default` 那个），
> 用 systemPrompt 是否为空来判断会让客服模式在界面路径上永远不生效。
>
> **自定义 Agent**（设置页创建的编程助手、写作助手等）不受此限制，工具调用能力照旧，
> 仍然按下面的权限模式走确认流程。

### FAQ 检索

FAQ 检索不是拿整句话做 `LIKE '%整句%'`，而是**切词后按命中情况打分排序**：

- 主信号是 FAQ 的 `keywords` 字段做倒排匹配（query 包含该关键词 +5，关键词同时出现在标题里再 +3）
- 辅助信号是 query 的 2-gram 是否出现在标题/答案里（疑问词「怎么」「如何」等走停用词表，避免噪声命中）
- `category` 不再当过滤条件，降级成一个加权项——过滤会让「分类对但关键词不匹配」的情况直接落空
- 0 分的条目会被丢弃：宁可返回空让模型走「查不到就转人工」的话术，也不塞不相关的 FAQ 让它硬凑答案

繁体输入会先经 `opencc-js` 转成简体再匹配，所以「我有多少訂單？」和「我有多少订单？」效果一致。

### 向量检索（RAG）

检索层已经支持向量检索，**默认关闭**（`VECTOR_SEARCH=off`），开启后关键词与向量两路并行、用 RRF 融合：

```
用户提问 → 繁简归一化 → 意图识别
                              ↓
              ┌───────────────┴───────────────┐
        关键词检索(rankFaq)              向量检索(embedding + sqlite-vec)
              └───────────────┬───────────────┘
                        RRF 融合 → Top-K → FAQ 上下文 → LLM
```

**两种向量库后端，配置切换**（`VECTOR_STORE`）：

| 后端 | 说明 | 实测数据 |
|---|---|---|
| `sqlite`（默认） | sqlite-vec，SQLite 扩展，和现有 `better-sqlite3` 同进程同事务 | 二进制 136KB、零额外进程、查询 <1ms、**写入立即可见** |
| `vectorize` | Cloudflare Vectorize 托管向量库，REST API 直连 | 建索引即用、查询 250-700ms、**写入约 60~100 秒后才可查** |

> Chroma 实测要 551MB 磁盘 + 一个常驻的 Python 进程，对这个规模是纯负担，所以没选。
> `VectorStore` 是统一接口，加后端不用改检索层。

**向量维度不写死**：首次调用 embedding 后按返回向量的实际长度确定，维度变化会自动重建索引（Vectorize 的索引维度创建后不可改，换模型需要删索引重建）。

**任何一环出问题都自动降级为纯关键词检索**（客服始终能回答）：

| 情况 | 行为 |
|---|---|
| `sqlite-vec` 没装 / 加载失败 | 只用关键词，服务照常启动 |
| 没配 `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` | 只用关键词（默认状态） |
| embedding 请求超时 / 报错 / 限流 | 只用关键词，本次请求不失败 |
| embedding 连续失败 3 次 | **熔断 60 秒**：窗口内直接失败降级，不发任何网络请求（避免每个请求都白等一轮退避） |
| Vectorize 索引尚未生效（写入后约 60~100 秒） | 期间自动跳过向量检索，只用关键词（否则会把「还没生效」误判成「没命中」） |
| 返回的向量含 NaN / 非数字 / 长度不一致 | 判定为失败（且不进缓存），走降级 |

**开启方式**（默认用 Cloudflare Workers AI 的 embedding 模型，有免费额度且不按 RPM 限流）：

```ini
VECTOR_SEARCH=on
VECTOR_STORE=vectorize        # 向量库：sqlite（默认）| vectorize

# baseUrl 里要带上你的 Account ID（Cloudflare dashboard 右上角账号名旁可见）
EMBEDDING_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/run
EMBEDDING_MODEL=@cf/baai/bge-m3
EMBEDDING_PROTOCOL=cloudflare
EMBEDDING_API_KEY=cfut-...

# VECTOR_STORE=vectorize 时还需要
VECTORIZE_ACCOUNT_ID=<ACCOUNT_ID>
VECTORIZE_INDEX=scs-faq
```

> ⚠️ **Cloudflare token 的权限**：Workers AI 需要 API Token 带
> `Account → Workers AI → Read` 和 `Account → Account Settings → Read`，
> 且 Account Resources 里要包含目标账号。只建 token 不授权会得到 401
> （`/accounts` 返回空数组就是这个症状）。

**换用 MiniMax**（需该 key 有 embedding 配额）：

```ini
EMBEDDING_BASE_URL=https://api.minimax.io/v1
EMBEDDING_MODEL=embo-01
EMBEDDING_PROTOCOL=minimax
# EMBEDDING_API_KEY 不填则回退到 ANTHROPIC_AUTH_TOKEN
```

> 实测本项目现有的 MiniMax key 的 embedding 端点不可用：`embo-01` / `emi-embedding`
> 均返回 `status_code=1002 rate limit exceeded(RPM)`，退避重试、跨 60 秒窗口等待都过不去
> （同一个 key 的 chat 端点正常）。需要在 MiniMax 控制台确认 embedding 服务的权限与配额。

换用其他 OpenAI 兼容服务商（SiliconFlow / 阿里 / 智谱等）只需改 `EMBEDDING_BASE_URL`、
`EMBEDDING_MODEL`，并把 `EMBEDDING_PROTOCOL` 改成 `openai`。

> **API Key 的回退规则**：只有 `minimax` 协议才允许回退到 `ANTHROPIC_AUTH_TOKEN`
> （那是 MiniMax 的 key，拿去请求 Cloudflare/OpenAI 只会 401）。其他协议必须显式配
> `EMBEDDING_API_KEY`。

## FAQ 知识库

应用内置 16 条常见问题，分为四类：

| 分类 | 示例问题 |
|------|----------|
| 退款 | 如何申请退款、退款进度查询、退款被拒怎么办 |
| 订单查询 | 如何查询订单、修改订单地址、取消订单 |
| 技术支持 | 无法登录、支付失败、App 闪退 |
| 通用 | 客服工作时间、如何联系人工客服 |

可以在 `server/db.ts` 的 `initDatabase()` 函数中修改或新增 FAQ。

## 二次开发

如果你想基于本项目进行定制化开发，可以参考 [DEVELOPMENT.md](./DEVELOPMENT.md) 获取详细指南。

常见定制场景：
- 修改客服名称和头像
- 调整 FAQ 知识库内容
- 自定义意图识别规则
- 更换 AI 模型
- 对接企业微信/公众号
- 添加更多管理后台功能

## 常见问题

### Q：npm install 时 better-sqlite3 编译失败怎么办？

`better-sqlite3` 需要原生编译。Windows 用户需先安装：

```bash
npm install -g windows-build-tools
# 或安装 Visual Studio Build Tools（含 C++ 桌面开发）
```

如果仍失败，可以使用预编译二进制（参考项目根目录 `docs/prebuilt-better-sqlite3.md`）。

### Q：启动后前端白屏怎么办？

1. 检查浏览器控制台是否有报错
2. 尝试清除 Vite 缓存：`rm -rf node_modules/.vite`，然后重新 `npm run dev`
3. 确认后端（`localhost:3001`）已正常启动

### Q：AI 回复显示「未登录」？

Claude Code (MiniMax) Provider 需要配置 `ANTHROPIC_AUTH_TOKEN`（MiniMax API Key），
在应用「设置」页面填写，或通过环境变量配置后重启服务。

若使用 CodeBuddy Provider，则需要先登录 CodeBuddy CLI：

```bash
codebuddy login
```

然后在应用「设置」页面确认登录状态。

## License

MIT
