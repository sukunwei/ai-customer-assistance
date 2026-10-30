/**
 * RAG 集成测试：embedTexts → indexFaqs → vectorStore → retrieveFaqs
 *
 * 补的是三个单测各自覆盖不到的**跨模块契约**：
 * 单测里 embedTexts 用手写的 [[1,2],[3,4]]、vectorStore 用手写的 [1,0,0,0]，
 * 各测一段；契约不一致时（比如探测用的 type 与入库用的 type 维度不同）
 * 单测全绿也发现不了。
 *
 * 这里用 globalThis.fetch 打桩（单元测试的正常手段，**不是**起 mock 服务），
 * 返回按「词袋」模型构造的确定性向量：共享 2-gram 越多，向量越相似。
 * 不依赖 MiniMax 配额，也不影响 e2e 的诚实性。
 *
 * 运行: npx tsx scripts/test-rag-integration.mts
 */
import Database from 'better-sqlite3';
import { embedTexts, clearEmbeddingCache, type EmbeddingConfig } from '../server/embeddings.js';
import { createVectorStore } from '../server/vectorStore.js';
import { indexFaqs } from '../server/ragIndex.js';
import { retrieveFaqs } from '../server/retriever.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const DIM = 64;

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function gramsOf(text: string): string[] {
  const out: string[] = [];
  const re = /[一-鿿]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const seg = m[0];
    for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/** 词袋向量：共享词越多越相似 */
function bagVector(text: string, dim = DIM): number[] {
  const v = new Array(dim).fill(0);
  for (const gram of gramsOf(text)) v[hash32(gram) % dim] += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
}

const CONFIG: EmbeddingConfig = {
  baseUrl: 'https://api.test.local/v1',
  apiKey: 'sk-cp-integration-test',
  model: 'test-embedding-model',
  protocol: 'minimax',
  timeoutMs: 1000,
  retryBaseDelayMs: 1,
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: any, init: any) => {
  const body = JSON.parse(init?.body || '{}');
  const texts: string[] = Array.isArray(body.texts) ? body.texts : (body.input ?? []);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      vectors: texts.map((t: string) => bagVector(t)),
      base_resp: { status_code: 0, status_msg: 'success' },
    }),
    text: async () => JSON.stringify({ vectors: texts.map((t: string) => bagVector(t)) }),
  };
}) as any;

const FAQS = [
  { id: 1, question: '如何查询我的订单？', answer: '登录后进入我的订单页面查看全部订单' },
  { id: 2, question: '退款需要多长时间到账？', answer: '退款一般1-3个工作日到账' },
  { id: 3, question: 'App 闪退怎么办？', answer: '尝试清理缓存或重新安装 App' },
];

async function run() {
  console.log('1. embedTexts → indexFaqs → vectorStore 打通');
  clearEmbeddingCache();
  const db = new Database(':memory:');
  const store = createVectorStore(db);

  const written = await indexFaqs(
    store,
    (texts, type) => embedTexts(texts, CONFIG, type),
    FAQS,
    { model: CONFIG.model }
  );
  check('索引写入 3 条', written === 3, String(written));
  check('store.count 为 3', store.count() === 3, String(store.count()));
  check('维度已建立', store.dim === DIM, String(store.dim));

  console.log('\n2. 查询向量能召回语义相关的条目');
  const queryVector = (await embedTexts(['我有多少订单'], CONFIG, 'query'))[0];
  check('查询向量维度一致', queryVector.length === DIM, String(queryVector.length));
  const rows = await store.query(queryVector, 3);
  check('召回了 3 条', rows.length === 3, String(rows.length));
  check('Top1 是订单类 FAQ', rows[0]?.id === 1, JSON.stringify(rows.map(r => r.id)));

  console.log('\n3. retrieveFaqs 融合两路');
  const ranked = await retrieveFaqs('我有多少订单', {
    topK: 3,
    keyword: () => [{ id: 2 }, { id: 3 }],
    vector: async () => rows.map(r => ({ id: r.id })),
  });
  check('返回 3 条', ranked.length === 3, String(ranked.length));
  const orderFaq = ranked.find(r => r.id === 1);
  check('向量召回的订单条目在结果里', Boolean(orderFaq), JSON.stringify(ranked.map(r => r.id)));
  check('它的 sources 含 vector', orderFaq?.sources.includes('vector') === true, orderFaq?.sources.join(','));
  const keywordHit = ranked.find(r => r.id === 2);
  check('关键词召回的条目 sources 含 keyword', keywordHit?.sources.includes('keyword') === true, keywordHit?.sources.join(','));

  console.log('\n4. 向量路失败时融合仍返回关键词结果');
  const degraded = await retrieveFaqs('我有多少订单', {
    topK: 3,
    keyword: () => [{ id: 2 }],
    vector: async () => { throw new Error('embedding 挂了'); },
  });
  check('返回关键词结果', degraded.length === 1, String(degraded.length));
  check('sources 只有 keyword', degraded[0].sources.join(',') === 'keyword', degraded[0].sources.join(','));

  console.log('\n5. 换模型会重建索引（维度或元数据变化时不能沿用旧索引）');
  const otherModel: EmbeddingConfig = { ...CONFIG, model: 'other-model' };
  const written2 = await indexFaqs(
    store,
    (texts, type) => embedTexts(texts, otherModel, type),
    FAQS,
    { model: otherModel.model }
  );
  check('重建后仍是 3 条', written2 === 3, String(written2));
  check('记录了新的模型名', store.getMeta('embedding_model') === otherModel.model, String(store.getMeta('embedding_model')));

  console.log('\n6. 真实向量（负数小数）能正常存取');
  clearEmbeddingCache();
  const negativeConfig: EmbeddingConfig = { ...CONFIG, model: 'neg-model' };
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init?.body || '{}');
    const texts: string[] = Array.isArray(body.texts) ? body.texts : (body.input ?? []);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        vectors: texts.map(() => [-0.1234, 0.5678, -0.9012, 0.3456]),
        base_resp: { status_code: 0 },
      }),
      text: async () => '{}',
    };
  }) as any;
  const db2 = new Database(':memory:');
  const store2 = createVectorStore(db2);
  const n2 = await indexFaqs(store2, (texts, type) => embedTexts(texts, negativeConfig, type), FAQS, { model: 'neg-model' });
  check('负数向量写入成功', n2 === 3, String(n2));
  const q2 = (await embedTexts(['查询'], negativeConfig, 'query'))[0];
  check('负数向量能查询到结果', (await store2.query(q2, 1)).length === 1);

  globalThis.fetch = realFetch;
  clearEmbeddingCache();
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  globalThis.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
