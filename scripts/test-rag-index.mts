/**
 * server/ragIndex.ts 单元测试
 *
 * 运行: npx tsx scripts/test-rag-index.mts
 */
import Database from 'better-sqlite3';
import { createVectorStore } from '../server/vectorStore.js';
import { indexFaqs } from '../server/ragIndex.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const FAQS = [
  { id: 1, question: '如何查询我的订单？', answer: '登录后进入我的订单页面查看' },
  { id: 2, question: '退款需要多长时间到账？', answer: '一般1-3个工作日' },
  { id: 3, question: 'App 闪退怎么办？', answer: '尝试清理缓存或重新安装' },
];

console.log('1. 索引写入');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  const calls: Array<{ texts: string[]; type: string }> = [];
  const embedder = async (texts: string[], type: 'db' | 'query') => {
    calls.push({ texts, type });
    return texts.map((_, i) => Array.from({ length: 8 }, (_, j) => (i + j) / 100));
  };
  const n = await indexFaqs(store, embedder, FAQS);
  check('返回 3', n === 3, String(n));
  check('store.count 为 3', store.count() === 3, String(store.count()));
  check('维度被建立', store.dim === 8, String(store.dim));
}

console.log('2. 索引文本包含 question 与 answer');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  const calls: Array<{ texts: string[]; type: string }> = [];
  const embedder = async (texts: string[], type: 'db' | 'query') => {
    calls.push({ texts, type });
    return texts.map(() => new Array(4).fill(0.5));
  };
  await indexFaqs(store, embedder, FAQS);
  const bulk = calls[calls.length - 1];
  check('批量调用用 type=db', bulk.type === 'db', bulk.type);
  check('条数正确', bulk.texts.length === 3, String(bulk.texts.length));
  check('文本含 question 与 answer', bulk.texts[0].includes('如何查询我的订单？') && bulk.texts[0].includes('登录后进入我的订单页面查看'), bulk.texts[0]);
}

console.log('3. embedder 抛错时安全返回');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  const embedder = async () => { throw new Error('embedding 服务不可用'); };
  let threw = false;
  let n = -1;
  try { n = await indexFaqs(store, embedder, FAQS); } catch { threw = true; }
  check('不抛错', threw === false);
  check('返回 0', n === 0, String(n));
  check('没有写入任何数据', store.count() === 0, String(store.count()));
}

console.log('4. 空 FAQ 列表');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  let called = false;
  const embedder = async () => { called = true; return []; };
  const n = await indexFaqs(store, embedder, []);
  check('返回 0', n === 0, String(n));
  check('不调用 embedder', called === false);
}

console.log('5. store 不可用时安全返回');
{
  const store = createVectorStore({} as any);
  const n = await indexFaqs(store, async () => [[1, 2, 3]], FAQS);
  check('返回 0', n === 0, String(n));
}

console.log('6. 探测与入库用同一个 type，且只发一次请求');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  const calls: Array<{ texts: string[]; type: string }> = [];
  const embedder = async (texts: string[], type: 'db' | 'query') => {
    calls.push({ texts, type });
    return texts.map(() => new Array(8).fill(0.5));
  };
  await indexFaqs(store, embedder, FAQS, { model: 'embo-01' });
  check('只发了一次远端请求', calls.length === 1, `实际 ${calls.length} 次`);
  check('请求用 type=db（与入库一致）', calls[0]?.type === 'db', calls[0]?.type);
  check('一次请求就带上全部 FAQ', calls[0]?.texts.length === 3, String(calls[0]?.texts.length));
}

console.log('7. 各条向量长度不一致时索引必须失败（不能静默拒绝）');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  const embedder = async (texts: string[]) => {
    if (texts.length === 1) return [new Array(4).fill(0.5)];
    return [new Array(4).fill(0.5), new Array(8).fill(0.5), new Array(4).fill(0.5)];
  };
  const n = await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01' });
  check('返回 0', n === 0, String(n));
  check('没有写入任何数据', store.count() === 0, String(store.count()));
}

console.log('8. FAQ 未变且模型未变时跳过重新索引');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  let calls = 0;
  const embedder = async (texts: string[]) => {
    calls++;
    return texts.map(() => new Array(8).fill(0.5));
  };
  await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01' });
  check('首次建立索引', store.count() === 3, String(store.count()));
  const n = await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01' });
  check('第二次跳过重建（没有再调 embedder）', calls === 1, `embedder 被调用 ${calls} 次`);
  check('返回已有条数', n === 3, String(n));
}

console.log('9. 模型变了必须重新索引');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  let calls = 0;
  const embedder = async (texts: string[]) => {
    calls++;
    return texts.map(() => new Array(8).fill(0.5));
  };
  await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01' });
  await indexFaqs(store, embedder as any, FAQS, { model: 'other-model' });
  check('模型变化触发重建', calls === 2, `embedder 被调用 ${calls} 次`);
}

console.log('10. FAQ 条数变了必须重新索引');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  let calls = 0;
  const embedder = async (texts: string[]) => {
    calls++;
    return texts.map(() => new Array(8).fill(0.5));
  };
  await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01' });
  await indexFaqs(store, embedder as any, [...FAQS, { id: 4, question: '新问题？', answer: '新答案' }], { model: 'embo-01' });
  check('FAQ 变化触发重建', calls === 2, `embedder 被调用 ${calls} 次`);
  check('索引条数更新', store.count() === 4, String(store.count()));
}

console.log('11. force 参数强制重建');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  let calls = 0;
  const embedder = async (texts: string[]) => {
    calls++;
    return texts.map(() => new Array(8).fill(0.5));
  };
  await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01' });
  await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01', force: true });
  check('force 触发重建', calls === 2, `embedder 被调用 ${calls} 次`);
}

console.log('12. FAQ 内容变化（条数不变）触发重建');
{
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  let calls = 0;
  const embedder = async (texts: string[]) => {
    calls++;
    return texts.map(() => new Array(8).fill(0.5));
  };
  await indexFaqs(store, embedder as any, FAQS, { model: 'embo-01' });
  check('首次建立索引', calls === 1, String(calls));
  check('内容哈希已写入元数据', typeof store.getMeta('faq_hash') === 'string' && (store.getMeta('faq_hash') as string).length > 0);

  // 条数不变，但第 1 条的答案文字改了
  const changed = FAQS.map(f => (f.id === 1 ? { ...f, answer: '答案改过了' } : f));
  await indexFaqs(store, embedder as any, changed, { model: 'embo-01' });
  check('内容变化触发重建', calls === 2, `embedder 被调用 ${calls} 次`);

  // 内容没变 → 不重建
  await indexFaqs(store, embedder as any, changed, { model: 'embo-01' });
  check('内容未变不重复重建', calls === 2, `embedder 被调用 ${calls} 次`);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
process.exit(failures === 0 ? 0 : 1);
