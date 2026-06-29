# 智能客服 Agent

一个基于 [CodeBuddy Agent SDK](https://www.codebuddy.cn) 构建的智能客服 Web 应用，具备意图识别、FAQ 知识库检索、满意度评价和管理后台等完整客服功能。

## 功能特性

- 🤖 **AI 智能对话** — 基于 Agent SDK 的流式对话，实时返回 AI 回复
- 🔍 **FAQ 知识库** — 16 条预设常见问题，支持关键词检索自动匹配答案
- 🧠 **意图识别** — 自动识别用户意图（退款、订单查询、技术支持、转人工、通用）
- 💬 **快捷提问** — 首页提供 6 个常用问题快捷入口，一键发送
- ⭐ **满意度评价** — 每轮对话支持 1-5 星评分 + 文字评价
- 📊 **管理后台** — 独立管理页面，查看会话统计、满意度分布、意图分析
- 🔒 **权限控制** — 支持 4 种权限模式，工具调用可实时弹窗确认
- 💾 **数据持久化** — SQLite 本地数据库，会话和消息自动保存

## 技术栈

| 层面 | 技术 |
|------|------|
| 后端 | Node.js + Express + TypeScript |
| 前端 | React 18 + TypeScript + Vite |
| UI | TDesign React 组件库 |
| AI | CodeBuddy Agent SDK (`@tencent-ai/agent-sdk`) |
| 数据库 | SQLite (`better-sqlite3`) |

## 环境要求

- **Node.js** ≥ 18（推荐使用 22.x）
- **npm** 或 **yarn**
- **CodeBuddy CLI** 已登录（用于 AI 对话功能）

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
- **后端**（Express）— `http://localhost:3000`

### 第三步：访问应用

在浏览器中打开 **http://localhost:5173** 即可使用。

## 使用说明

### 普通用户

1. 打开首页，看到「智能客服」欢迎界面
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
| `/api/check-login` | GET | 检查 CodeBuddy 登录状态 |
| `/api/models` | GET | 获取可用模型列表 |
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

### CodeBuddy 认证

应用需要 CodeBuddy 鉴权才能使用 AI 功能，有三种方式：

**方式一：使用 CodeBuddy CLI 登录（推荐）**

```bash
codebuddy login
npm run dev
```

**方式二：环境变量配置**

创建 `.env` 文件：

```bash
PORT=3000
CODEBUDDY_API_KEY=your_api_key
CODEBUDDY_AUTH_TOKEN=your_auth_token
CODEBUDDY_BASE_URL=https://api.example.com
```

**方式三：Web UI 配置**

在应用的「设置」页面中配置环境变量（仅在当前服务器进程有效）。

### 权限模式

应用支持四种权限模式（在设置页面切换）：

| 模式 | 说明 |
|------|------|
| `default` | 每次工具调用需要用户确认 |
| `acceptEdits` | 自动接受文件编辑类操作 |
| `plan` | 计划模式（只读，不执行操作） |
| `bypassPermissions` | 跳过所有权限检查 |

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
3. 确认后端（`localhost:3000`）已正常启动

### Q：AI 回复显示「未登录」？

需要先登录 CodeBuddy CLI：

```bash
codebuddy login
```

然后在应用「设置」页面确认登录状态。

## License

MIT
