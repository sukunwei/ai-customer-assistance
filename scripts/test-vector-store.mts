/**
 * server/vectorStore.ts 单元测试
 *
 * 运行: npx tsx scripts/test-vector-store.mts
 */
import Database from 'better-sqlite3';
import { createVectorStore } from '../server/vectorStore.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function freshStore(dim?: number) {
  const db = new Database(':memory:');
  const store = createVectorStore(db);
  if (dim !== undefined) await store.prepare(dim);
  return { db, store };
}

async function run() {
  console.log('1. 可用性');
  {
    const { store } = await freshStore();
    check('available 为 true', store.available === true);
  }

  console.log('2. sqlite-vec 加载失败时安全降级');
  {
    const store = createVectorStore({} as any);
    check('available 为 false', store.available === false);
    let threw = false;
    try { await store.count(); } catch { threw = true; }
    check('count() 不抛错', threw === false);
    check('dim 为 null', store.dim === null);
    check('upsert 返回 false', store.upsert(1, [1, 2]) === false);
    check('query 返回空数组', JSON.stringify(await store.query([1, 2], 3)) === '[]');
  }

  console.log('3. 建表与写入');
  {
    const { store } = await freshStore(4);
    check('ensureDim 后 dim 正确', store.dim === 4);
    check('upsert 返回 true', store.upsert(1, [1, 0, 0, 0]) === true);
    check('upsert 第二条返回 true', store.upsert(2, [0, 1, 0, 0]) === true);
    check('count 为 2', store.count() === 2, String(store.count()));
  }

  console.log('4. topK 排序');
  {
    const { store } = await freshStore(4);
    store.upsert(1, [1, 0, 0, 0]);
    store.upsert(2, [0, 1, 0, 0]);
    store.upsert(3, [0, 0, 1, 0]);
    const rows = await store.query([0.9, 0.1, 0, 0], 2);
    check('返回 2 条', rows.length === 2, String(rows.length));
    check('最相似的排第一', rows[0]?.id === 1, JSON.stringify(rows));
    check('distance 升序', rows[0].distance <= rows[1].distance, JSON.stringify(rows));
  }

  console.log('5. upsert 覆盖');
  {
    const { store } = await freshStore(4);
    store.upsert(1, [1, 0, 0, 0]);
    store.upsert(2, [0, 1, 0, 0]);
    store.upsert(1, [0, 0, 1, 0]);
    check('count 仍为 2', store.count() === 2, String(store.count()));
    const rows = await store.query([0, 0, 1, 0], 1);
    check('更新后命中新向量', rows[0]?.id === 1, JSON.stringify(rows));
  }

  console.log('6. remove');
  {
    const { store } = await freshStore(4);
    store.upsert(1, [1, 0, 0, 0]);
    store.upsert(2, [0, 1, 0, 0]);
    store.remove(1);
    check('count 减为 1', store.count() === 1, String(store.count()));
  }

  console.log('7. 维度变化自动重建');
  {
    const { store } = await freshStore(4);
    store.upsert(1, [1, 0, 0, 0]);
    check('重建前 count 为 1', store.count() === 1);
    await store.prepare(8);
    check('dim 更新为 8', store.dim === 8);
    check('旧索引被清空', store.count() === 0, String(store.count()));
    check('新维度可以写入', store.upsert(9, [1, 0, 0, 0, 0, 0, 0, 0]) === true);
  }

  console.log('8. 拒绝非法向量');
  {
    const { store } = await freshStore(4);
    store.upsert(1, [1, 0, 0, 0]);
    check('NaN 被拒绝', store.upsert(2, [1, NaN, 0, 0]) === false);
    check('Infinity 被拒绝', store.upsert(3, [Infinity, 0, 0, 0]) === false);
    check('-Infinity 被拒绝', store.upsert(4, [-Infinity, 0, 0, 0]) === false);
    check('count 未变', store.count() === 1, String(store.count()));
  }

  console.log('9. 维度不匹配的向量被拒绝');
  {
    const { store } = await freshStore(4);
    check('长度不足被拒绝', store.upsert(1, [1, 2, 3]) === false);
    check('长度超出的被拒绝', store.upsert(2, [1, 2, 3, 4, 5]) === false);
    check('count 为 0', store.count() === 0);
  }

  console.log('10. 未 ensureDim 时写入无效');
  {
    const { store } = await freshStore();
    check('upsert 返回 false', store.upsert(1, [1, 0, 0, 0]) === false);
    check('count 为 0', store.count() === 0);
  }

  console.log('11. 重复 ensureDim 同一维度不清空数据');
  {
    const { store } = await freshStore(4);
    store.upsert(1, [1, 0, 0, 0]);
    await store.prepare(4);
    check('数据仍在', store.count() === 1, String(store.count()));
  }

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
