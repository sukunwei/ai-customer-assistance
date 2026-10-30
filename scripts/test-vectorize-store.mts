/**
 * server/vectorizeStore.ts 单元测试
 *
 * 运行: npx tsx scripts/test-vectorize-store.mts
 */
import Database from 'better-sqlite3';
import { createVectorizeStore } from '../server/vectorizeStore.js';
import { createDbMetaStore, createMemoryMetaStore } from '../server/ragMeta.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const realFetch = globalThis.fetch;
interface Call { url: string; init: any; }
function stubFetch(handler: (call: Call, index: number) => any) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { url: String(url), init };
    calls.push(call);
    const r = handler(call, calls.length - 1);
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  }) as any;
  return calls;
}
function restoreFetch() { globalThis.fetch = realFetch; }

const CONFIG = {
  accountId: 'acct123',
  indexName: 'scs-faq',
  apiKey: 'cfut-test',
  readyDelayMs: 0,
};

const VECTOR = [0.1, 0.2, 0.3, 0.4];

async function run() {
console.log('1. 配置不全时不可用');
{
  const store = createVectorizeStore({ ...CONFIG, accountId: '' });
  check('available 为 false', store.available === false);
  check('query 返回空', JSON.stringify(await store.query(VECTOR, 3)) === '[]');
  check('upsert 返回 false', store.upsert(1, VECTOR) === false);
}

console.log('2. ensureDim：索引不存在时创建');
{
  const calls = stubFetch((c) => {
    if (c.url.endsWith('/indexes/scs-faq')) return { status: 404, body: { success: false, errors: [{ code: 1000, message: 'not found' }] } };
    return { status: 201, body: { success: true, result: { name: 'scs-faq', config: { dimensions: 4, metric: 'cosine' } } } };
  });
  const store = createVectorizeStore(CONFIG);
  await store.prepare(4);
  await new Promise(r => setTimeout(r, 5));
  const create = calls.find(c => c.url.endsWith('/indexes') && c.init.method === 'POST');
  check('发出了创建索引的请求', Boolean(create), JSON.stringify(calls.map(c => c.url)));
  const body = JSON.parse(create!.init.body);
  check('维度正确', body.config.dimensions === 4, JSON.stringify(body));
  check('度量是 cosine', body.config.metric === 'cosine', JSON.stringify(body));
  check('dim 变为 4', store.dim === 4, String(store.dim));
  restoreFetch();
}

console.log('3. ensureDim：索引已存在且维度相同则不重建');
{
  const calls = stubFetch(() => ({
    status: 200,
    body: { success: true, result: { name: 'scs-faq', config: { dimensions: 4, metric: 'cosine' } } },
  }));
  const store = createVectorizeStore(CONFIG);
  await store.prepare(4);
  await new Promise(r => setTimeout(r, 5));
  const create = calls.find(c => c.url.endsWith('/indexes') && c.init.method === 'POST');
  check('没有创建索引', !create, JSON.stringify(calls.map(c => `${c.init.method} ${c.url}`)));
  check('dim 为 4', store.dim === 4, String(store.dim));
  restoreFetch();
}

console.log('4. ensureDim：索引维度不同不能改（Vectorize 维度固定）');
{
  stubFetch(() => ({
    status: 200,
    body: { success: true, result: { name: 'scs-faq', config: { dimensions: 1024, metric: 'cosine' } } },
  }));
  const store = createVectorizeStore(CONFIG);
  await store.prepare(4);
  await new Promise(r => setTimeout(r, 5));
  check('dim 保持索引的真实维度 1024', store.dim === 1024, String(store.dim));
  restoreFetch();
}

console.log('5. upsert 走 NDJSON 格式');
{
  const calls = stubFetch((c) => {
    if (c.url.endsWith('/indexes/scs-faq')) {
      return { status: 200, body: { success: true, result: { config: { dimensions: 4, metric: 'cosine' } } } };
    }
    return { status: 200, body: { success: true, result: { inserted: 1 } } };
  });
  const store = createVectorizeStore(CONFIG);
  await store.prepare(4);
  await new Promise(r => setTimeout(r, 5));
  const ok = store.upsert(7, VECTOR);
  check('upsert 返回 true', ok === true);
  const up = calls.find(c => c.url.includes('/upsert'));
  check('发到了 upsert 端点', Boolean(up), JSON.stringify(calls.map(c => c.url)));
  check('Content-Type 是 ndjson', up!.init.headers['Content-Type'] === 'application/x-ndjson', String(up!.init.headers['Content-Type']));
  const line = JSON.parse(up!.init.body.split('\n')[0]);
  check('id 是字符串', line.id === '7', String(line.id));
  check('values 是向量', Array.isArray(line.values) && line.values.length === 4, JSON.stringify(line).slice(0, 120));
  restoreFetch();
}

console.log('6. query 返回按相似度降序，distance = 1 - score');
{
  stubFetch(() => ({
    status: 200,
    body: {
      success: true,
      result: {
        count: 2,
        matches: [
          { id: '2', score: 0.9 },
          { id: '1', score: 0.5 },
        ],
      },
    },
  }));
  const store = createVectorizeStore(CONFIG);
  await store.prepare(4);
  await new Promise(r => setTimeout(r, 5));
  const rows = await store.query(VECTOR, 3);
  check('返回 2 条', rows.length === 2, String(rows.length));
  check('最相似排第一', rows[0]?.id === 2, JSON.stringify(rows));
  check('distance = 1 - score', Math.abs(rows[0].distance - 0.1) < 1e-6, String(rows[0].distance));
  restoreFetch();
}

console.log('7. 维度不匹配的查询向量被拒绝');
{
  const calls = stubFetch(() => ({ status: 200, body: { success: true, result: { count: 0, matches: [] } } }));
  const store = createVectorizeStore(CONFIG);
  await store.prepare(4);
  await new Promise(r => setTimeout(r, 5));
  const before = calls.length;
  const rows = await store.query([0.1, 0.2], 3);
  check('返回空', rows.length === 0);
  check('没有发请求', calls.length === before, `新增 ${calls.length - before} 次`);
  restoreFetch();
}

console.log('8. HTTP 错误不抛错');
{
  stubFetch(() => ({ status: 500, body: { success: false, errors: [{ message: 'boom' }] } }));
  const store = createVectorizeStore(CONFIG);
  await store.prepare(4);
  await new Promise(r => setTimeout(r, 5));
  let threw = false;
  let rows: any[] = [];
  try { rows = await store.query(VECTOR, 3); } catch { threw = true; }
  check('query 不抛错', threw === false);
  check('返回空', rows.length === 0);
  restoreFetch();
}

console.log('9. 元数据读写');
{
  stubFetch(() => ({ status: 200, body: { success: true, result: { config: { dimensions: 4 } } } }));
  const store = createVectorizeStore(CONFIG);
  check('初始为 null', store.getMeta('embedding_model') === null);
  store.setMeta('embedding_model', 'bge-m3');
  check('写入后能读回', store.getMeta('embedding_model') === 'bge-m3');
  restoreFetch();
}

console.log('10. 注入持久化 MetaStore 后数据跨实例保留');
{
  const db = new Database(':memory:');
  const meta = createDbMetaStore(db);
  const store1 = createVectorizeStore(CONFIG, meta);
  store1.setMeta('faq_count', '16');
  store1.setMeta('embedding_model', 'bge-m3');

  // 模拟进程重启：新建 store 实例，但共用持久化的 meta
  const store2 = createVectorizeStore(CONFIG, meta);
  check('新实例仍能读到 faq_count', store2.getMeta('faq_count') === '16', String(store2.getMeta('faq_count')));
  check('新实例仍能读到模型名', store2.getMeta('embedding_model') === 'bge-m3', String(store2.getMeta('embedding_model')));
  check('count 也能读到', store2.count() === 16, String(store2.count()));
}

console.log('11. 默认使用进程内 MetaStore（测试可独立运行）');
{
  const store = createVectorizeStore(CONFIG);
  store.setMeta('k', 'v');
  check('写入后可读回', store.getMeta('k') === 'v', String(store.getMeta('k')));
  const mem = createMemoryMetaStore();
  mem.set('a', '1');
  check('内存 store 独立', mem.get('a') === '1' && mem.get('b') === null);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
