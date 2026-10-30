/**
 * server/retriever.ts 单元测试
 *
 * 运行: npx tsx scripts/test-retriever.mts
 */
import assert from 'node:assert/strict';
import { fuseRankings, retrieveFaqs } from '../server/retriever.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const EPS = 1e-9;

console.log('1. RRF 公式');
{
  const out = fuseRankings([{ source: 'keyword', items: [{ id: 1 }, { id: 2 }] }]);
  check('返回 2 条', out.length === 2, String(out.length));
  check('第 1 名分数 = 1/(60+1)', Math.abs(out[0].score - 1 / 61) < EPS, String(out[0].score));
  check('第 2 名分数 = 1/(60+2)', Math.abs(out[1].score - 1 / 62) < EPS, String(out[1].score));
  check('降序排列', out[0].score > out[1].score);
  check('sources 记录来源', out[0].sources.join(',') === 'keyword', out[0].sources.join(','));
}

console.log('2. 两路命中同一文档分数相加');
{
  const out = fuseRankings([
    { source: 'keyword', items: [{ id: 1 }] },
    { source: 'vector', items: [{ id: 1 }] },
  ]);
  check('只有 1 条', out.length === 1, String(out.length));
  check('分数 = 2/61', Math.abs(out[0].score - (1 / 61 + 1 / 61)) < EPS, String(out[0].score));
  check('sources 含两个来源', out[0].sources.length === 2, out[0].sources.join(','));
}

console.log('3. 跨路去重');
{
  const out = fuseRankings([
    { source: 'keyword', items: [{ id: 1 }] },
    { source: 'vector', items: [{ id: 1 }] },
  ]);
  check('去重后 1 条', out.length === 1);
}

console.log('4. 一路为空');
{
  const out = fuseRankings([
    { source: 'keyword', items: [{ id: 7 }, { id: 8 }] },
    { source: 'vector', items: [] },
  ]);
  check('保留 keyword 结果', out.length === 2, String(out.length));
  check('顺序不变', out[0].id === 7 && out[1].id === 8, JSON.stringify(out.map(o => o.id)));
  check('sources 只有 keyword', out[0].sources.join(',') === 'keyword', out[0].sources.join(','));
}

console.log('5. 两路都空');
{
  const out = fuseRankings([
    { source: 'keyword', items: [] },
    { source: 'vector', items: [] },
  ]);
  check('返回空数组', out.length === 0);
  check('传入空列表也返回空', fuseRankings([]).length === 0);
}

console.log('6. 同分保持输入顺序');
{
  const out = fuseRankings([
    { source: 'keyword', items: [{ id: 10 }] },
    { source: 'vector', items: [{ id: 20 }] },
  ]);
  check('同分时 keyword 在前', out[0].id === 10, JSON.stringify(out.map(o => o.id)));
}

console.log('7. retrieveFaqs 只用关键词');
{
  const out = await retrieveFaqs('查询', {
    topK: 3,
    keyword: () => [{ id: 1 }, { id: 2 }],
  });
  check('返回 keyword 结果', out.length === 2, String(out.length));
  check('sources 全是 keyword', out.every(o => o.sources.join(',') === 'keyword'));
}

console.log('8. retrieveFaqs 向量失败时降级');
{
  const out = await retrieveFaqs('查询', {
    topK: 3,
    keyword: () => [{ id: 1 }],
    vector: async () => { throw new Error('embedding 挂了'); },
  });
  check('不抛错', true);
  check('退回关键词结果', out.length === 1, String(out.length));
  check('sources 只有 keyword', out[0].sources.join(',') === 'keyword', out[0].sources.join(','));
}

console.log('9. retrieveFaqs 融合两路');
{
  const out = await retrieveFaqs('查询', {
    topK: 5,
    keyword: () => [{ id: 1 }, { id: 2 }],
    vector: async () => [{ id: 2 }, { id: 3 }],
  });
  check('返回 3 条', out.length === 3, String(out.length));
  const two = out.find(o => o.id === 2);
  check('id=2 两路都命中', two?.sources.length === 2, two?.sources.join(','));
  check('id=2 排在第一（两路命中分最高）', out[0].id === 2, JSON.stringify(out.map(o => o.id)));
}

console.log('10. retrieveFaqs 截断到 topK');
{
  const out = await retrieveFaqs('查询', {
    topK: 3,
    keyword: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    vector: async () => [{ id: 4 }, { id: 5 }],
  });
  check('只返回 3 条', out.length === 3, String(out.length));
}

console.log('11. keyword 回调收到 query 与候选数（topK * 3）');
{
  let seen: any = null;
  await retrieveFaqs('我有多少订单', {
    topK: 7,
    keyword: (q, k) => { seen = { q, k }; return []; },
  });
  check('query 透传', seen?.q === '我有多少订单', String(seen?.q));
  // 两路各取 topK*3 个候选再融合，避免向量路挤掉关键词命中
  check('候选数为 topK*3', seen?.k === 21, String(seen?.k));
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
process.exit(failures === 0 ? 0 : 1);
