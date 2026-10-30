# 轻量 RAG 向量检索层 —— 设计文档

日期：2026-10-30
状态：待评审

## 1. 背景与目标

当前客服 Agent 的知识来源是 `faq` 表（16 条）加一个基于关键词打分的检索器
（`server/faqSearch.ts`）。这套逻辑能处理"我有多少订单"这类自然语言问句，
但它是词法匹配：用户说法一旦和 FAQ 的人工词表差得较远就命中不了。

目标是把**向量检索层接进架构**，让知识库以后扩充到文档级别时不用重写检索层。
当前 FAQ 只有 16 条，**向量检索当下没有精度收益**——这次做的是架构就位，
不是效果优化。

非目标（YAGNI）：不引入独立的向量数据库进程，不做文档解析/切片流水线，
不追求召回率指标，不改提示词与工具禁用的既有行为。

## 2. 关键决策与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 向量存储 | **sqlite-vec**（SQLite 扩展） | 实测：二进制 136KB、零额外进程、零额外内存，与现有 `better-sqlite3` 同进程同事务。Chroma 实测磁盘 551MB + 常驻 85MB + 多一个 Python 进程；本机磁盘仅剩 9.9GB，且双进程会让这个单进程 Express 应用变成运维负担 |
| embedding 来源 | **可配置，默认 Cloudflare Workers AI** | 实测 MiniMax 的 embedding 端点对现有 key 持续返回 `status_code=1002`（跨 60 秒窗口等待仍失败，配额为 0 或未开通）。Cloudflare Workers AI 有免费额度且不按 RPM 限流，是更可靠的默认选择 |
| 协议 | **MiniMax / OpenAI / Cloudflare 三协议** | 三家的请求体与响应结构都不同：MiniMax 用 `texts`+`type` → `vectors`；OpenAI 用 `input` → `data[].embedding`；Cloudflare Workers AI 用 `text` → `result.data[][]`，且端点是 `{base}/accounts/{id}/ai/run/{模型名}`。换服务商只改配置 |
| 融合方式 | **RRF（Reciprocal Rank Fusion）** | 只用排名不用分数，天然规避"关键词分数量纲"与"余弦距离量纲"不可比的问题，无需归一化或调权重 |
| 关键词检索 | **保留，与向量并存** | FAQ 的 `keywords` 字段是人工整理的高质量词表，精确匹配上比向量更准；向量负责兜住"说法和词表不一致"的情况 |

### 2.1 被排除的方案

| 方案 | 排除原因 |
|---|---|
| Chroma | 551MB 磁盘 + Python 常驻进程 + 独立端口；本机磁盘/内存都紧张，且收益为零 |
| 本地 transformers.js (ONNX) | 实测装不上：`onnxruntime-node` 1.30 仅预编译 `darwin/arm64`，本机为 x86_64；node 端无法切 WASM 后端 |
| 本地 Python onnxruntime | Python 生态有 macOS x64 wheel，技术上可行，但需引入 Python 胶水层，复杂度接近 Chroma |
| LanceDB / FAISS | native 编译或重型依赖，本机不适合 |
| 纯 JS 余弦（不装 sqlite-vec） | 技术上够用（几千条 × 768 维 < 10ms），但 sqlite-vec 只要 136KB 且带 KNN 索引，没必要手写 |

## 3. 架构

```
用户提问
   ↓  toSimplified()            繁→简（已有，server/text.ts）
detectIntent()                  意图识别（已有）
   ↓
retrieve()                      新增：server/retriever.ts
   ├── KeywordRetriever         现有 rankFaq 打分逻辑，纯本地零延迟
   └── VectorRetriever          远程 embedding + sqlite-vec topK
   ↓  RRF 融合（1/(k+rank) 求和），去重后取 Top-K
faqContext → systemPrompt → LLM → 答复
```

关键词与向量**两条路并行执行**，任一路失败不影响另一条。

## 4. 组件设计

### 4.1 `server/embeddings.ts`

远程 embedding 客户端。职责单一：把一段文本变成一个向量。

```ts
export interface EmbeddingConfig {
  baseUrl: string;      // 例如 https://api.minimax.io/v1
  apiKey: string;
  model: string;        // embo-01 / BAAI/bge-m3 / ...
  dim: number;          // 向量维度，建表时用
  protocol: 'minimax' | 'openai';
  timeoutMs: number;
}

export async function embed(texts: string[], config: EmbeddingConfig): Promise<number[][]>
```

- **协议差异**：`minimax` 发 `{model, type, texts}` 解 `vectors`；`openai` 发 `{model, input}` 解 `data[].embedding`。
  `type` 按用途传 `'query'`（问句）或 `'db'`（入库文档）。
- **超时**：默认 5s，超时抛错，由调用方降级。
- **缓存**：进程内 LRU（默认 256 条），key 为 `protocol:model:text`。
  同一问句重复问不重复调用。
- **失败即抛错**，不做内部重试——降级逻辑在检索层统一处理。

### 4.2 `server/vectorStore.ts`

sqlite-vec 封装。职责单一：存向量、查 topK。

```ts
export interface VectorStore {
  readonly available: boolean;
  ensureSchema(dim: number): void;
  upsert(id: number, vector: number[]): void;
  query(vector: number[], topK: number): Array<{ id: number; distance: number }>;
}
```

- 加载：`sqliteVec.load(db)`。**加载失败不抛异常**，而是让 `available = false`，
  并打印一行提示（这是降级矩阵的第一环）。
- 建表：`CREATE VIRTUAL TABLE faq_vec USING vec0(faq_id INTEGER PRIMARY KEY, embedding FLOAT[dim])`。
  维度变化时需要重建（提供 `npm run reindex`）。
- 查询：`WHERE embedding MATCH ? AND k = ? ORDER BY distance`。

### 4.3 `server/retriever.ts`

检索层。定义接口与融合。

```ts
export interface Retriever {
  name: string;
  retrieve(query: string, topK: number): Promise<RankedItem[]>;
}
export interface RankedItem { id: number; rank: number; source: string }
```

- `KeywordRetriever`：包装现有 `rankFaq`，返回带 rank 的结果。
- `VectorRetriever`：调 `embed()` 拿 query 向量 → `vectorStore.query()` → 映射回 faq 行。
  embedding 失败或 store 不可用 → 返回空数组（不抛错）。
- `retrieveHybrid()`：两路都跑 → RRF 融合 → 去重 → 取 Top-K。

**RRF 融合**：`score(doc) = Σ 1/(k + rank_i(doc))`，`k = 60`（标准取值）。
同一文档在两路都命中时分数相加，自然排到前面。

## 5. 数据结构

```sql
-- FAQ 向量索引（sqlite-vec 虚拟表）
CREATE VIRTUAL TABLE faq_vec USING vec0(
  faq_id    INTEGER PRIMARY KEY,
  embedding FLOAT[<dim>]
);
```

`faq` 表本身不动。`faq_vec` 与 `faq` 通过 `faq_id` 关联，
索引可随时 `DELETE FROM faq_vec` 后重建。

**维度必须与实际写入的向量同源**：早先的实现先拿一条 `'query'` 向量探维度、再用
`'db'` 向量写入，若两者维度不同，所有向量都会被拒且错维度被持久化，导致向量检索
**永久失效且几乎无日志**。现在只发一次批量请求，维度直接取自这批向量，必然一致。

**维度运行时探测，不写死**：`vec0` 的向量维度在建表时就固定了，
而不同 embedding 模型的维度不同（MiniMax `embo-01` 的真实维度目前无法从公开资料确认——
实测请求被限流挡住，官方文档页也被本机网络策略拦住）。因此：

- 首次调用 embedding 成功后，用返回向量的实际长度作为维度
- 维度记在 `meta` 表里（`key = 'embedding_dim'`），后续启动复用
- 探测不到（embedding 不可用）→ 向量检索整体不可用，降级到关键词
- 不提供 `EMBEDDING_DIM` 配置项：运行时探测已经覆盖，换模型无需改代码或改配置

这样换 embedding 模型不需要改代码，只需让索引重建（维度变了会自动重建）。

**预留**（本次不建）：`doc_chunks` 表，用于将来导入 Markdown/PDF 切片。
设计上向量存储层已按"表 + 向量"抽象，届时只需加一张表和一个 ChunkRetriever。

## 6. 降级矩阵

这是本设计最重要的部分——"架构就位"的前提是**任何一环坏了都不能影响客服可用**。

| 故障 | 行为 | 用户可见影响 |
|---|---|---|
| `sqlite-vec` 未安装 / 加载失败 | `available=false`，仅关键词检索 | 无（回答质量回到今天） |
| 未配置 `EMBEDDING_API_KEY` | 向量检索不启用，仅关键词 | 无 |
| embedding 请求超时 / 报错 / 限流 | 本次跳过向量检索，仅关键词 | 无 |
| MiniMax 配额不足（当前的实测状态） | 同上 | 无（需在控制台开通） |
| embedding 连续失败 3 次 | **熔断 60 秒**：窗口内直接失败降级，不发任何网络请求 | 无（避免每个请求都白等一轮退避） |
| 返回的向量含 NaN / 非数字 / 长度不一致 | 判定为失败（不进缓存），走降级 | 无 |
| 部分 FAQ 尚无向量 | 这些条目只参与关键词召回 | 轻微 |
| 两条路都失败 | 返回空，走提示词的"查不到就转人工"话术 | 转人工 |

**默认配置下（没配 key）系统行为与今天完全一致**——这是刻意的：
让新代码在没有外部依赖的情况下也能完整启动和通过测试。

## 7. 配置

新增环境变量（`.env.example` 同步）：

```ini
# 向量检索开关：off 时完全不调用 embedding
VECTOR_SEARCH=off

# 默认：Cloudflare Workers AI（免费额度，不按 RPM 限流）
# baseUrl 里要带 Account ID（Cloudflare dashboard 右上角可见）
EMBEDDING_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/run
EMBEDDING_MODEL=@cf/multilingual/e5-large
EMBEDDING_PROTOCOL=cloudflare
EMBEDDING_API_KEY=cfut-...

# 换成 MiniMax（需要该 key 有 embedding 配额）
# EMBEDDING_BASE_URL=https://api.minimax.io/v1
# EMBEDDING_MODEL=embo-01
# EMBEDDING_PROTOCOL=minimax
# EMBEDDING_API_KEY 不填则回退到 ANTHROPIC_AUTH_TOKEN

EMBEDDING_TIMEOUT_MS=5000
```

**API Key 的回退规则**：只有 `minimax` 协议才允许回退到 `ANTHROPIC_AUTH_TOKEN`——
那是 MiniMax 的 key，拿去请求 Cloudflare/OpenAI 只会得到 401。其他协议必须显式配
`EMBEDDING_API_KEY`。

维度见第 5 节：默认**运行时探测**，不写死。

## 8. 数据流

**查询**（`POST /api/chat`）：

1. `toSimplified(message)` → `detectIntent()`
2. `retrieveHybrid(query, topK=3, category=intent)`：
   - 并行执行 KeywordRetriever 与 VectorRetriever
   - VectorRetriever 内部：embedding（失败→空）→ sqlite-vec topK → 映射 faq 行
   - RRF 融合去重 → Top-3
3. 命中项拼成 `faqContext` → 现有 `buildCustomerServicePrompt()` → 现有 LLM 调用
4. **提示词、禁工具、繁简归一化等既有行为一律不动**

**索引**（服务启动时）：

1. 服务启动后异步触发：读取全部 FAQ → 批量 embedding → 写入 `faq_vec`
   （不阻塞 `app.listen`，索引失败只记日志）
2. **当前没有 update/delete 路径**——`db.ts` 只导出了 `getAllFaqs` 和 `addFaq`，
   管理后台也只有查询 API（`/api/faq/all`、`/api/faq/search`），没有增删改接口。
   将来若加了 FAQ 编辑功能，在那里补上向量更新即可，本次不预先造这些接口。
   （`addFaq` 的向量同步追加因此也一并推迟到那时实现。）

## 9. 错误处理原则

- **检索层永不抛错给调用方**：所有失败降级为"少一路召回"。
- **索引层失败只记日志**：知识库没索引好，客服还能靠关键词工作。
- 日志统一前缀 `[Vector]` / `[Embedding]`，便于排查。

## 10. 测试计划

| 层 | 测试 | 断言要点 |
|---|---|---|
| 单元 | `embeddings.ts`（mock fetch） | 两种协议的请求体/响应解析、超时抛错、缓存命中不重复请求、错误透传 |
| 单元 | `vectorStore.ts`（临时 SQLite） | 建表→写入→topK 排序正确；未加载时 `available=false` 且不抛错 |
| 单元 | `retriever.ts` RRF | 两路结果融合顺序、跨路去重、一路为空时另一路原样返回、两路都空返回空 |
| 单元 | 回归 | 现有 `rankFaq` 行为不变（16 条 FAQ 的检索结果与今天一致） |
| 端到端 | 未配 key | 请求成功、答复正常、检索退化为关键词 |
| 端到端 | 配了 key 且可用 | FAQ 命中数 ≥ 关键词命中数；答复正常 |
| 端到端 | embedding 故意报错 | 请求仍成功，答复仍正常（不 500） |

单测沿用本项目已有的做法：纯 `tsx` 脚本 + `assert`，不引入测试框架。

## 11. 开放问题与行动项

1. **【阻塞真实向量检索】MiniMax embedding 配额**：实测 `embo-01` 与 `emi-embedding`
   对当前 key 均持续返回 `status_code=1002 rate limit exceeded(RPM)`，同一 key 的 chat
   端点正常。需用户到 MiniMax 控制台确认 embedding 服务是否开通、RPM 配额是多少。
   未解决前，向量检索会一直处于降级状态（不影响系统可用）。
2. **【需确认】向量维度**：不阻塞——已改为运行时探测（第 5 节）。
   唯一影响是 `EMBEDDING_DIM` 配置项在探测成功前不生效。
3. **【待定】`VECTOR_SEARCH` 的默认值**：建议默认 `off`，等 MiniMax 配额确认、
   端到端跑通后再开启。

## 12. 不做的事（明确排除）

- 不做文档上传/解析/切片（`doc_chunks` 表只是预留）
- 不做重排序（cross-encoder rerank）——数据量上来再说
- 不做向量库的元数据过滤语法——sqlite-vec 层面用 SQL 表达
- 不改现有的关键词打分算法——它是降级路径，必须保持可靠
- 不动提示词、工具禁用、繁简归一化的既有实现
