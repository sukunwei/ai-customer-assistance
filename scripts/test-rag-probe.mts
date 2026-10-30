/**
 * RAG 检索对比：关键词 vs 向量 vs 融合
 *
 * 用真实的 FAQ 库 + 真实的 Cloudflare embedding + 真实的 Vectorize 索引，
 * 对一批问句跑三条检索路径，打印对比表。
 *
 * 需要真实的 Cloudflare key（.env 里配好），因此不属于 npm test 的一部分：
 *   set -a; . ./.env; set +a; npx tsx scripts/test-rag-probe.mts
 *
 * 运行: npx tsx scripts/test-rag-probe.mts
 */
import * as db from '../server/db.js';
import { rankFaq } from '../server/faqSearch.js';
import { embedTexts, type EmbeddingConfig } from '../server/embeddings.js';
import { createVectorizeStore } from '../server/vectorizeStore.js';
import { retrieveFaqs } from '../server/retriever.js';

const ACCOUNT = process.env.VECTORIZE_ACCOUNT_ID || '';
const INDEX = process.env.VECTORIZE_INDEX || 'scs-faq';
const API_KEY = process.env.EMBEDDING_API_KEY || '';
const BASE_URL =
  process.env.EMBEDDING_BASE_URL ||
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`;

const EMBED_CONFIG: EmbeddingConfig = {
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  model: process.env.EMBEDDING_MODEL || '@cf/baai/bge-m3',
  protocol: 'cloudflare',
  timeoutMs: 15000,
};

// 刻意包含三类问句：
//  A 关键词能命中        —— 验证关键词路仍然可靠
//  B 关键词命中不了      —— 向量检索的舞台
//  C 完全无关            —— 负例，两路都不该命中
const QUESTIONS: Array<{ q: string; expect: string; kind: 'A' | 'B' | 'C' }> = [
  { q: '我有多少订单', expect: '如何查询我的订单？', kind: 'A' },
  { q: '怎么申请退款', expect: '如何申请退款？', kind: 'A' },
  { q: 'App 一打开就闪退', expect: 'App 闪退怎么办？', kind: 'A' },
  { q: '付款的时候付不了', expect: '支付失败怎么办？', kind: 'A' },
  { q: '我要找真人客服', expect: '如何联系人工客服？', kind: 'A' },
  { q: '你们几点上班', expect: '工作时间是什么时候？', kind: 'A' },
  { q: '钱什么时候能回来', expect: '退款需要多长时间到账？', kind: 'B' },
  { q: '东西寄到哪了', expect: '订单发货后如何查物流？', kind: 'B' },
  { q: '买的东西没收到', expect: '订单显示已签收但我没收到货？', kind: 'B' },
  { q: '东西要退回去寄哪里', expect: '你们的退货地址是什么？', kind: 'B' },
  { q: '买了还能不要了吗', expect: '如何修改或取消订单？', kind: 'B' },
  { q: '手机号能不能换', expect: '如何修改账号密码/手机号？', kind: 'B' },
  { q: '我的包裹到哪儿了', expect: '订单发货后如何查物流？', kind: 'B' },
  { q: '快递到哪了', expect: '订单发货后如何查物流？', kind: 'B' },
  { q: '订单能取消吗', expect: '如何修改或取消订单？', kind: 'B' },
  { q: '不想要了', expect: '如何修改或取消订单？', kind: 'B' },
  { q: '东西送到了吗', expect: '订单显示已签收但我没收到货？', kind: 'B' },   // 问的正是签收情况
  { q: '我要退货', expect: '如何申请退款？', kind: 'B' },
  { q: '密码忘了', expect: '无法登录账号怎么办？', kind: 'B' },   // 密码忘了 → 登录不了
  { q: '怎么取消退款', expect: '如何申请退款？', kind: 'B' },
  { q: '今天天气怎么样', expect: '（不该命中任何 FAQ）', kind: 'C' },
  { q: '帮我写首诗', expect: '（不该命中任何 FAQ）', kind: 'C' },
];

async function run() {
  const faqs = db.getAllFaqs();
  console.log(`FAQ 库：${faqs.length} 条\n`);

  const store = createVectorizeStore({
    accountId: ACCOUNT,
    indexName: INDEX,
    apiKey: API_KEY,
    // 已经写入过就不要再等 120 秒
    readyDelayMs: 0,
  });
  await store.prepare(1024);
  console.log(`向量库：${INDEX}（维度 ${store.dim}）\n`);

  // 一次性算出所有问句的向量
  const vectors = await embedTexts(QUESTIONS.map(q => q.q), EMBED_CONFIG, 'query');

  const rows: any[] = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const { q, expect, kind } = QUESTIONS[i];
    const keyword = rankFaq(faqs, q, { limit: 3 }).map(f => f.question);
    const vectorRows = await store.query(vectors[i], 3);
    const vector = vectorRows.map(r => faqs.find(f => f.id === r.id)?.question).filter(Boolean);
    const fused = await retrieveFaqs(q, {
      topK: 3,
      keyword: (query, k) => rankFaq(faqs, query, { limit: k }).map(f => ({ id: f.id })),
      vector: async (query, k) => {
        const v = (await embedTexts([query], EMBED_CONFIG, 'query'))[0];
        return (await store.query(v, k)).map(r => ({ id: r.id }));
      },
    });
    rows.push({ kind, q, expect, keyword, vector, fused: fused.map(f => faqs.find(x => x.id === f.id)?.question).filter(Boolean) });
  }

  /** 期望与实际是否指同一条 FAQ（去掉问号后取前 5 字做双向包含判断） */
  const matches = (list: string[], expect: string): boolean => {
    if (expect.startsWith('（')) return false;
    const key = expect.replace('？', '').slice(0, 5);
    return list.some(x => {
      if (!x) return false;
      const other = x.replace('？', '').slice(0, 5);
      return x.includes(key) || other.includes(expect.replace('？', '').slice(0, 5));
    });
  };
  const hit = (list: string[], expect: string) => (expect.startsWith('（') ? '—' : matches(list, expect) ? '✓' : '✗');

  console.log('类型 | 问句 | 期望命中 | 关键词 | 向量 | 融合');
  console.log('─'.repeat(100));
  for (const r of rows) {
    console.log(`  ${r.kind}  | ${r.q.padEnd(12)} | ${r.expect.padEnd(20)} | ${hit(r.keyword, r.expect)} ${r.keyword[0]?.slice(0, 14) || '(无)'} | ${hit(r.vector, r.expect)} ${r.vector[0]?.slice(0, 14) || '(无)'} | ${hit(r.fused, r.expect)} ${r.fused[0]?.slice(0, 14) || '(无)'}`);
  }

  // 负例（期望「不该命中」）不计入准确率
  const positives = rows.filter(r => !r.expect.startsWith('（'));
  const top3Ok = positives.filter(r => matches(r.fused, r.expect)).length;
  const top1Ok = positives.filter(r => r.fused[0] === r.expect).length;
  console.log(`\n正例 Top1 命中 ${top1Ok}/${positives.length}，Top3 覆盖 ${top3Ok}/${positives.length}`);
  const uncovered = positives.filter(r => !matches(r.fused, r.expect));
  if (uncovered.length) {
    console.log('Top3 未覆盖：');
    uncovered.forEach(r => console.log(`   「${r.q}」期望 ${r.expect}，实得 ${r.fused.join(' | ') || '(空)'}`));
  }

  console.log('\n\n完整命中列表：');
  for (const r of rows) {
    console.log(`\n【${r.kind}】${r.q}  → 期望: ${r.expect}`);
    console.log(`   关键词: ${r.keyword.join(' / ') || '(无)'}`);
    console.log(`   向量  : ${r.vector.join(' / ') || '(无)'}`);
    console.log(`   融合后: ${r.fused.join(' / ') || '(无)'}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
