# 轻量 RAG 向量检索层 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给智能客服接入向量检索层——sqlite-vec 存向量、MiniMax `embo-01` 算向量、RRF 与现有关键词检索融合，任何一环故障都自动降级到纯关键词。

**Architecture:** 新增三个独立模块（`server/embeddings.ts` 远程 embedding 客户端、`server/vectorStore.ts` sqlite-vec 封装、`server/retriever.ts` 检索与融合），`server/index.ts` 的检索入口从 `rankFaq()` 换成 `retrieveFaqs()`。关键词与向量两路并行，任一路失败只损失该路召回。

**Tech Stack:** Node 24 / TypeScript / ESM / better-sqlite3（已有）+ sqlite-vec（新依赖，136KB 预编译二进制）/ tsx（测试运行器，无测试框架）

**Spec:** `docs/superpowers/specs/2026-10-30-rag-vector-search-design.md`

## Global Constraints

- **不改动**现有提示词、工具禁用、繁简归一化、意图识别的任何实现——本次只加检索层。
- **检索层永不向调用方抛错**：任何失败一律降级为「少一路召回」，客服必须始终能回答。
- **默认 `VECTOR_SEARCH=off`**：未开启时系统行为与今天完全一致，不发起任何 embedding 请求。
- **向量维度运行时探测**，不写死任何数字；维度记录在 `meta` 表，变化时自动重建索引。
- embedding 请求的 `type` 参数：入库文档用 `'db'`，用户问句用 `'query'`。
- MiniMax 的错误用 **HTTP 200 + `base_resp.status_code != 0`** 表达，**不能只看 HTTP 状态码**。
- **限流退避重试**：`status_code=1002` 或 HTTP 429 触发指数退避（1s → 2s → 4s → …），
  查询路径默认最多重试 **2 次**（总等待约 3 秒），超出即失败降级——绝不能让客服为向量检索等 31 秒。
  索引路径（后台任务）可传更大的重试次数。
- 服务端模块之间用 ESM 相对导入，`.js` 后缀（与 `server/index.ts` 现有风格一致）。
- 测试用纯 `tsx` 脚本 + `node:assert`，不引入测试框架；脚本放 `scripts/`，用 `.ts` 后缀（项目 `"type": "module"`）。
- 日志统一前缀 `[Vector]` / `[Embedding]`。

## Review Focus

以下失败模式 spec 提到了但没有明确规定行为，实现时必须钉死（各自的测试落在对应 Task）：

1. **HTTP 200 但业务失败**——MiniMax 出错时返回 200 + `base_resp.status_code=1002`。只看 HTTP 状态会把限流当成功，拿到空向量。→ Task 1
2. **向量含 NaN / Infinity**——写进 sqlite-vec 会污染 KNN 排序，且不报错。→ Task 2
3. **embedding 返回 200 但 `vectors` 为空数组**——实测踩过（`vectors: null`）。视为失败降级，不能当成「无相似结果」。→ Task 1
4. **换模型导致维度变化**——旧索引维度与新向量不符，查询会报错或静默返回空。必须自动重建而不是抛错。→ Task 2
5. **sqlite-vec 未安装 / 加载失败**——`available=false`，服务照常启动，检索退化为关键词。→ Task 2

---

### Task 1: 远程 embedding 客户端

**Files:**
- Create: `server/embeddings.ts`
- Create: `scripts/test-embeddings.mts`

**Interfaces:**
- Consumes: 无（纯 HTTP 客户端，无项目内依赖）
- Produces:
  ```ts
  export type EmbeddingProtocol = 'minimax' | 'openai';
  export interface EmbeddingConfig {
    baseUrl: string;      // 例 'https://api.minimax.io/v1'
    apiKey: string;
    model: string;        // 例 'embo-01'
    protocol: EmbeddingProtocol;
    timeoutMs: number;    // 默认 5000
  }
  export class EmbeddingError extends Error {
    constructor(message: string, readonly code: string);
  }
  export async function embedTexts(
    texts: string[],
    config: EmbeddingConfig,
    type?: 'db' | 'query',   // 默认 'query'
    maxRetries?: number       // 默认 2；限流重试次数
  ): Promise<number[][]>
  ```
  后续任务依赖：`embedTexts` 的签名、`EmbeddingConfig` 的字段名。

- [ ] **Step 1: 写失败测试** `scripts/test-embeddings.mts`

  用 `globalThis.fetch` 打桩（保存原实现，测试结束还原）。断言：

  - **minimax 协议请求体**：发到 `${baseUrl}/embeddings`，body 为 `{model, type, texts}`，`Authorization: Bearer <key>`；响应 `{vectors: [[1,2],[3,4]], base_resp:{status_code:0}}` → 返回 `[[1,2],[3,4]]`
  - **openai 协议请求体**：body 为 `{model, input: texts}`；响应 `{data:[{embedding:[1,2]}]}` → 返回 `[[1,2]]`
  - **业务错误码**：HTTP 200 + `base_resp.status_code: 1002` → 抛 `EmbeddingError`，`code === '1002'`，message 含 `rate limit`
  - **openai 协议的错误**：HTTP 4xx → 抛 `EmbeddingError`
  - **空向量**：HTTP 200 + `{vectors: null}` → 抛 `EmbeddingError`（不能返回空数组当成功）
  - **超时**：fetch 抛 `AbortError` → 抛 `EmbeddingError`，message 含 `timeout`
  - **缓存**：同一 `texts` + 同一 `type` 连续调两次 → fetch 只被调用一次；`type` 不同则各调一次
  - **缓存上限**：连续调用 300 个不同文本后，第 1 个文本再次调用会再次发起请求（LRU 淘汰生效）
  - **限流退避重试**：连续 2 次返回 `status_code: 1002`、第 3 次返回成功 → 最终返回向量，且 fetch 被调用 3 次
  - **退避上限**：连续 5 次返回 1002、`maxRetries = 2` → 抛 `EmbeddingError`，fetch 被调用 **3 次**（首次 + 2 次重试），不多试
  - **HTTP 429 同样触发退避**：429 → 重试 → 成功
  - **退避不影响非限流错误**：HTTP 500 → 立即抛错，不重试

- [ ] **Step 2: 运行测试确认失败**

  Run: `npx tsx scripts/test-embeddings.mts`
  Expected: FAIL —— 报 `Cannot find module '.../server/embeddings'`

- [ ] **Step 3: 实现 `server/embeddings.ts`**

  要点：
  - 端点拼接：`${baseUrl.replace(/\/+$/, '')}/embeddings`
  - 超时：`AbortSignal.timeout(config.timeoutMs)`，捕获 `AbortError` 转成 `EmbeddingError('embedding request timeout', 'timeout')`
  - minimax 响应解析：`base_resp.status_code !== 0` → 抛 `EmbeddingError(base_resp.status_msg, String(status_code))`；`vectors` 不是非空数组 → 抛 `EmbeddingError('empty embedding response', 'empty_response')`
  - openai 响应解析：`data` 必须是数组且每项有 `embedding` 数组，否则抛 `EmbeddingError`
  - 缓存：模块级 `Map<string, number[]>`，key = `${protocol}:${model}:${type}:${text}`；容量上限 256，超出时删除最早插入的（`Map` 保持插入序，先 `keys().next().value`）
  - `embedTexts` 接受数组，逐条查缓存，未命中的批量发一次请求；部分命中则合并结果
  - **限流退避重试**（MiniMax 的 `status_code=1002` 与 HTTP 429 都触发）：
    初始延迟 1 秒、每次翻倍（1s → 2s → 4s → …），最多重试 `maxRetries` 次（默认 2）。
    退避总时长上限约 3 秒——**查询路径不能为了向量检索让用户等 31 秒**，
    超出就直接抛错，由检索层降级到关键词。
    索引路径（后台任务）可以传更大的 `maxRetries`。

- [ ] **Step 4: 运行测试确认通过**

  Run: `npx tsx scripts/test-embeddings.mts`
  Expected: PASS，全部断言通过

- [ ] **Step 5: 提交**

  ```bash
  git add server/embeddings.ts scripts/test-embeddings.mts
  git commit -m "feat(rag): add remote embedding client with dual protocol support"
  ```

---

### Task 2: sqlite-vec 向量存储

**Files:**
- Create: `server/vectorStore.ts`
- Create: `scripts/test-vector-store.mts`
- Modify: `package.json`（加 `sqlite-vec` 依赖）

**Interfaces:**
- Consumes: `better-sqlite3` 的 `Database` 实例（测试里用 `:memory:`，生产用 `server/db.ts` 的默认导出）
- Produces:
  ```ts
  export interface VectorStore {
    readonly available: boolean;      // sqlite-vec 是否加载成功
    readonly dim: number | null;      // 当前索引维度，未建立为 null
    ensureDim(dim: number): void;     // 维度变化时重建表
    upsert(id: number, vector: number[]): boolean;  // 成功返回 true
    remove(id: number): void;
    query(vector: number[], topK: number): Array<{ id: number; distance: number }>;
    count(): number;
  }
  export function createVectorStore(db: Database.Database): VectorStore
  ```
  后续任务依赖：`createVectorStore(db)`、`VectorStore` 的方法签名。

- [ ] **Step 1: 安装依赖**

  Run: `npm i sqlite-vec`
  Expected: 安装成功；`node_modules/sqlite-vec-darwin-x64/vec0.dylib` 存在（本机是 x86_64 macOS，该平台有预编译二进制）

- [ ] **Step 2: 写失败测试** `scripts/test-vector-store.mts`

  断言：

  - **建表与写入**：`ensureDim(4)` 后 `upsert(1, [1,0,0,0])`、`upsert(2, [0,1,0,0])`，`count() === 2`
  - **topK 排序**：`query([0.9,0.1,0,0], 2)` 返回的第一条 `id === 1`，且 `distance` 升序
  - **upsert 覆盖**：`upsert(1, [0,0,1,0])` 后 `count()` 仍为 2，`query([0,0,1,0], 1)` 首条是 `id === 1`
  - **remove**：`remove(1)` 后 `count() === 1`
  - **维度变化自动重建**：`ensureDim(4)` → 写入 → `ensureDim(8)` → `dim === 8` 且 `count() === 0`（旧索引清空重建，不抛错）
  - **拒绝非法向量**：`upsert(3, [1, NaN, 0, 0])` 返回 `false` 且 `count()` 不变；`upsert(4, [Infinity,0,0,0])` 同样返回 `false`
  - **维度不匹配的向量被拒绝**：`ensureDim(4)` 下 `upsert(5, [1,2,3])` 返回 `false`
  - **未 ensureDim 时写入无效**：`upsert(1, [1,0])` 返回 `false`
  - **available 为 true**：`createVectorStore(new Database(':memory:'))` 的 `available === true`

- [ ] **Step 3: 运行测试确认失败**

  Run: `npx tsx scripts/test-vector-store.mts`
  Expected: FAIL —— 报 `Cannot find module '.../server/vectorStore'`

- [ ] **Step 4: 实现 `server/vectorStore.ts`**

  要点：
  - `sqliteVec.load(db)` 包在 try/catch 里：失败则返回 `available: false` 的 store，所有方法安全返回空值，**不抛错**
  - 虚拟表名 `faq_vec`，建表语句 `CREATE VIRTUAL TABLE faq_vec USING vec0(faq_id INTEGER PRIMARY KEY, embedding FLOAT[<dim>])`
  - 维度存在普通表 `rag_meta(key TEXT PRIMARY KEY, value TEXT)` 里（`CREATE TABLE IF NOT EXISTS`）；`ensureDim(dim)` 时对比已存维度，不同则 `DROP TABLE IF EXISTS faq_vec` 并重建，同时更新 `rag_meta`
  - 向量合法性：长度必须等于当前 `dim`，且每个分量必须是有限数（`Number.isFinite`），否则拒绝并 `console.warn('[Vector] 拒绝非法向量')`
  - `upsert` 用 `INSERT OR REPLACE`
  - `query` 用 `SELECT faq_id, distance FROM faq_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`，向量以 JSON 字符串传入
  - `count()` 用 `SELECT COUNT(*) AS c FROM faq_vec`

- [ ] **Step 5: 运行测试确认通过**

  Run: `npx tsx scripts/test-vector-store.mts`
  Expected: PASS

- [ ] **Step 6: 提交**

  ```bash
  git add server/vectorStore.ts scripts/test-vector-store.mts package.json package-lock.json
  git commit -m "feat(rag): add sqlite-vec vector store with dynamic dimension"
  ```

---

### Task 3: 检索层与 RRF 融合

**Files:**
- Create: `server/retriever.ts`
- Create: `scripts/test-retriever.mts`

**Interfaces:**
- Consumes: Task 1 的 `embedTexts`、Task 2 的 `VectorStore`、现有的 `rankFaq`（`server/faqSearch.ts`）
- Produces:
  ```ts
  export interface RankedItem {
    id: number;
    score: number;       // RRF 融合分
    sources: string[];   // 命中的检索器名，如 ['keyword', 'vector']
  }
  export function fuseRankings(
    lists: Array<{ source: string; items: Array<{ id: number }> }>,
    k?: number           // 默认 60
  ): RankedItem[]
  export async function retrieveFaqs(
    query: string,
    options: {
      topK: number;
      category?: string;
      keyword: (query: string, topK: number) => Array<{ id: number }>;
      vector?: (query: string, topK: number) => Promise<Array<{ id: number }>>;
    }
  ): Promise<RankedItem[]>
  ```
  后续任务依赖：`retrieveFaqs` 的签名与 `RankedItem` 形状。

- [ ] **Step 1: 写失败测试** `scripts/test-retriever.mts`

  断言：

  - **RRF 公式**：单个来源 items 为 `[{id:1},{id:2}]` → `fuseRankings([{source:'keyword', items:[{id:1},{id:2}]}])` 的第 1 名 `score === 1/(60+1)`，第 2 名 `score === 1/(60+2)`
  - **两路都命中同一文档分数相加**：`fuseRankings([{source:'keyword',items:[{id:1}]},{source:'vector',items:[{id:1}]}])` → `score === 1/61 + 1/61`，`sources` 含 `keyword` 和 `vector`
  - **跨路去重**：两路各有 `{id:1}` → 结果长度 1
  - **一路为空**：只有 keyword 有结果 → 结果与 keyword 原顺序一致（`sources` 只有 `keyword`）
  - **两路都空**：返回 `[]`
  - **同分保持输入顺序**（先 keyword 后 vector 的传入顺序）
  - **`retrieveFaqs` 只用关键词**：`options.vector` 不传 → 返回 keyword 的结果，`sources` 全是 `keyword`
  - **`retrieveFaqs` 向量失败时降级**：`options.vector` 抛异常 → 不抛出去，返回关键词结果
  - **`retrieveFaqs` 融合两路**：keyword 返回 `[{id:1},{id:2}]`、vector 返回 `[{id:2},{id:3}]` → 返回 3 条且 `id:2` 的 `sources` 含两个来源
  - **`retrieveFaqs` 截断到 topK**：两路共 5 条不同 id，`topK: 3` → 返回 3 条

- [ ] **Step 2: 运行测试确认失败**

  Run: `npx tsx scripts/test-retriever.mts`
  Expected: FAIL —— 报 `Cannot find module '.../server/retriever'`

- [ ] **Step 3: 实现 `server/retriever.ts`**

  要点：
  - `fuseRankings`：对每个来源的 items 按下标排名（rank 从 1 开始），`score += 1/(k + rank)`；用 `Map<id, {score, sources:Set}>` 聚合，最后按 score 降序、首次出现顺序升序排列
  - `retrieveFaqs`：先跑 keyword（同步），再跑 vector（`await`，但包 try/catch，失败返回 `[]`）；两路结果交给 `fuseRankings`，截断到 `topK`
  - `options.keyword` 的类型是 `(query: string, topK: number) => Array<{id:number}>`——**category 由闭包捕获**，不额外加参数

- [ ] **Step 4: 运行测试确认通过**

  Run: `npx tsx scripts/test-retriever.mts`
  Expected: PASS

- [ ] **Step 5: 提交**

  ```bash
  git add server/retriever.ts scripts/test-retriever.mts
  git commit -m "feat(rag): add retriever layer with RRF fusion and keyword fallback"
  ```

---

### Task 4: 配置、接线与索引

**Files:**
- Create: `server/ragConfig.ts`
- Create: `server/ragIndex.ts`
- Create: `scripts/test-e2e-rag.mts`
- Modify: `server/index.ts`（检索入口 + 启动索引）
- Modify: `.env.example`（新增配置项）
- Modify: `package.json`（加 `test` / `test:e2e` 脚本）

**Interfaces:**
- Consumes: Task 1 的 `embedTexts`/`EmbeddingConfig`、Task 2 的 `createVectorStore`、Task 3 的 `retrieveFaqs`
- Produces:
  ```ts
  // server/ragConfig.ts
  export interface RagConfig {
    enabled: boolean;
    topK: number;
    embedding: EmbeddingConfig;
  }
  export function getRagConfig(): RagConfig

  // server/ragIndex.ts
  export async function indexFaqs(
    store: VectorStore,
    embedder: (texts: string[], type: 'db' | 'query') => Promise<number[][]>,
    faqs: Array<{ id: number; question: string; answer: string }>
  ): Promise<number>   // 返回成功写入的条数
  ```

- [ ] **Step 1: 写失败测试** `scripts/test-rag-config.mts`

  断言（通过 `process.env` 直接设置再调用 `getRagConfig()`）：
  - `VECTOR_SEARCH` 未设置 → `enabled === false`
  - `VECTOR_SEARCH=off` → `enabled === false`
  - `VECTOR_SEARCH=on` 且有 `EMBEDDING_API_KEY` → `enabled === true`
  - `VECTOR_SEARCH=on` 但没有任何 key（清空 `EMBEDDING_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`）→ `enabled === false`
  - 默认值：`model === 'embo-01'`、`protocol === 'minimax'`、`baseUrl === 'https://api.minimax.io/v1'`、`timeoutMs === 5000`
    （端点说明：官方参考示例用 `https://minimaxi.chat`，但实测该域名在本机网络**不可达**（fetch failed）；
    `https://api.minimax.io/v1` 可达并能正确解析 `texts`/`type` 参数，只是当前 key 的 embedding 配额返回
    `status_code=1002`。因此默认用后者，端点仍可由 `EMBEDDING_BASE_URL` 覆盖）
  - `EMBEDDING_API_KEY` 未设时回退到 `ANTHROPIC_AUTH_TOKEN`
  - `topK` 默认 3，可由 `RAG_TOP_K` 覆盖

- [ ] **Step 2: 写失败测试** `scripts/test-rag-index.mts`

  断言（用假 embedder 返回固定长度向量）：
  - `indexFaqs` 对 3 条 FAQ 返回 3，且 `store.count() === 3`
  - 索引文本包含 question 和 answer（假 embedder 记录收到的 texts，断言包含该 FAQ 的 question 与 answer 拼接结果）
  - embedder 抛错时 `indexFaqs` 不抛错，返回 0

- [ ] **Step 3: 运行两个测试确认失败**

  Run: `npx tsx scripts/test-rag-config.mts && npx tsx scripts/test-rag-index.mts`
  Expected: FAIL —— 报 `Cannot find module '.../server/ragConfig'` / `.../server/ragIndex'`

- [ ] **Step 4: 实现 `server/ragConfig.ts`**

  要点：
  - `enabled` = `process.env.VECTOR_SEARCH === 'on'` **且** key 非空
  - key 优先级：`EMBEDDING_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY`
  - `baseUrl` 默认 `https://api.minimax.io/v1`；`model` 默认 `embo-01`；`protocol` 默认 `minimax`（只接受 `minimax`/`openai`，其他值回退 `minimax`）；`timeoutMs` 默认 5000
  - `topK` 默认 3，`RAG_TOP_K` 可覆盖

- [ ] **Step 5: 实现 `server/ragIndex.ts`**

  要点：
  - 索引文本 = `` `${question}\n${answer}` ``
  - 先调一次 embedder 拿第一条向量确定维度 → `store.ensureDim(vec.length)` → 再批量 embed 全部 → 逐条 `store.upsert`
  - 整个流程包 try/catch，失败 `console.warn('[Vector] FAQ 索引失败:', ...)` 并返回 0，**不抛出**
  - 若 `store.available === false` 直接返回 0

- [ ] **Step 6: 接线 `server/index.ts`**

  要点：
  - 新增 import：`getRagConfig`、`createVectorStore`、`retrieveFaqs`、`indexFaqs`、`db`（已有）
  - 文件级创建一次：`const ragConfig = getRagConfig();` 与 `const vectorStore = createVectorStore(db.default);`
  - 检索入口替换：原来调用 `rankFaq(db.getAllFaqs(), normalizedMessage, {limit:3, category})` 的那段改成——
    ```ts
    const faqItems = await retrieveFaqs(normalizedMessage, {
      topK: ragConfig.topK,
      keyword: (q, k) => rankFaq(db.getAllFaqs(), q, { limit: k, category: intentResult.intent }).map(f => ({ id: f.id })),
      vector: ragConfig.enabled && vectorStore.available
        ? async (q, k) => {
            const vecs = await embedTexts([q], ragConfig.embedding, 'query');
            if (!vecs[0]) return [];
            return vectorStore.query(vecs[0], k).map(r => ({ id: r.id }));
          }
        : undefined,
    }).then(items => items.map(i => faqById.get(i.id)).filter(Boolean));
    ```
    其中 `faqById` 是 `new Map(db.getAllFaqs().map(f => [f.id, f]))`
  - **vector 回调内部必须 try/catch**：embedding 失败或 store 未就绪时返回 `[]`（`retrieveFaqs` 也会兜一层，但双保险）
  - 启动后异步索引（不阻塞 `app.listen`）：
    ```ts
    if (ragConfig.enabled) {
      void indexFaqs(vectorStore, (texts, type) => embedTexts(texts, ragConfig.embedding, type), db.getAllFaqs())
        .then(n => console.log(`[Vector] 已索引 ${n} 条 FAQ`));
    }
    ```
  - `faqItems` 的类型仍是 `db.DbFaq[]`，供后面的 `faqContext` 拼接使用

- [ ] **Step 7: 加配置项与 npm 脚本**

  `.env.example` 追加（注释写清用途）：
  ```ini
  # ===== 向量检索（RAG）=====
  # off 时完全不发起 embedding 请求，系统退化为纯关键词检索
  VECTOR_SEARCH=off
  # MiniMax（复用 ANTHROPIC_AUTH_TOKEN，零新增 key）；换服务商只改这三项
  EMBEDDING_BASE_URL=https://api.minimax.io/v1
  EMBEDDING_MODEL=embo-01
  EMBEDDING_PROTOCOL=minimax
  EMBEDDING_TIMEOUT_MS=5000
  # EMBEDDING_API_KEY 不填则回退到 ANTHROPIC_AUTH_TOKEN
  ```

  `package.json` scripts 加：
  ```json
  "test": "tsx scripts/test-embeddings.mts && tsx scripts/test-vector-store.mts && tsx scripts/test-retriever.mts && tsx scripts/test-rag-config.mts && tsx scripts/test-rag-index.mts",
  "test:e2e": "tsx scripts/test-e2e-rag.mts"
  ```

- [ ] **Step 8: 写端到端测试** `scripts/test-e2e-rag.mts`

  脚本自己起服务（用 `PORT` 环境变量避免和开发实例冲突），覆盖三种场景：
  - **未开启向量检索**（`VECTOR_SEARCH=off`）：请求 `/api/chat`，断言 HTTP 200、有 `text` 事件、无 `tool` 事件、答复非空
  - **开启但 embedding 不可用**（`VECTOR_SEARCH=on` + 一个必然失败的 `EMBEDDING_BASE_URL`）：断言请求仍 200、仍有 `text` 事件（**降级生效，不是 500**）
  - **开启且 embedding 可用**（`VECTOR_SEARCH=on` + 脚本内起的 **mock embedding 服务**）：
    mock 端点实现 MiniMax 协议（`POST /v1/embeddings`，收 `{model, texts, type}`，回 `{vectors: [[...]], base_resp:{status_code:0}}`），
    向量用确定性的伪随机数（按文本哈希生成，保证同一文本每次向量相同，不同文本不同）。
    断言：HTTP 200、有 `text` 事件、服务端日志出现 `[Vector] 已索引 N 条 FAQ`、
    且 FAQ 命中数 ≥ 关键词单独命中数
  - 脚本结尾打印 `[E2E] 服务端日志中的 FAQ 检索行`，便于人工确认命中数

  > 这一条是**唯一能在 MiniMax 配额开通前验证完整链路**的办法：
  > mock 端点冒充 embedding 服务，走的是和真实 MiniMax 完全相同的协议与代码路径。

- [ ] **Step 9: 跑全部测试**

  Run: `npm test`
  Expected: 5 个脚本依次 PASS

  Run: `npm run test:e2e`
  Expected: PASS

- [ ] **Step 10: 回归确认——现有关键词检索行为未变**

  Run: `npx tsx scripts/test-faq-search.mts`（把本轮 `/tmp/faq-text.test.mts` 固化进 `scripts/`，断言 16 条真实 FAQ 的检索结果与今天一致）
  Expected: PASS

- [ ] **Step 11: 类型检查**

  Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(server|scripts)/"`
  Expected: 无输出（`src/` 下既有的 lucide-react 类型错误与本次无关，不在过滤范围内）

- [ ] **Step 12: 提交**

  ```bash
  git add server/ragConfig.ts server/ragIndex.ts server/index.ts scripts/ .env.example package.json
  git commit -m "feat(rag): wire vector retrieval into chat pipeline with graceful degradation"
  ```

---

## 收尾（不属于任何 Task）

- [ ] 在 `README.md` 的 FAQ 检索一节补一段：说明向量检索已就位、默认关闭、开启方式、三种降级情形。
- [ ] 在 `DEVELOPMENT.md` 的核心功能一节补 `server/embeddings.ts` / `vectorStore.ts` / `retriever.ts` 三个模块的职责说明与目录结构条目。
- [ ] 提醒用户：MiniMax embedding 配额未开通前，向量检索会一直处于降级状态（`[Embedding]` 日志里能看到 `1002 rate limit`），需到控制台确认后再把 `VECTOR_SEARCH` 改成 `on`。
