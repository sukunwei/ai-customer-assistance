/**
 * FAQ 关键词检索回归测试
 *
 * 用数据库里的真实 FAQ 数据，确保关键词检索的行为不会因为
 * 引入向量检索层而改变（关键词路是向量不可用时的降级路径，必须可靠）。
 *
 * 运行: npx tsx scripts/test-faq-search.mts
 */
import * as db from '../server/db.js';
import { rankFaq } from '../server/faqSearch.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const FAQS = db.getAllFaqs();
console.log(`（数据库中的 FAQ 共 ${FAQS.length} 条）\n`);

console.log('1. 自然语言问句能命中');
{
  const out = rankFaq(FAQS, '我有多少订单', { limit: 3, category: '订单查询' });
  check('有命中', out.length > 0, String(out.length));
  check('Top1 是订单查询类', out[0]?.question.includes('查询我的订单'), out[0]?.question);
}

console.log('2. 繁体问句命中一致');
{
  const simple = rankFaq(FAQS, '我有多少订单', { limit: 3, category: '订单查询' });
  const traditional = rankFaq(FAQS, '我有多少訂單', { limit: 3, category: '订单查询' });
  check('命中条数一致', simple.length === traditional.length, `${simple.length} vs ${traditional.length}`);
  check(
    'Top1 一致',
    simple[0]?.id === traditional[0]?.id,
    `${simple[0]?.question} vs ${traditional[0]?.question}`
  );
}

console.log('3. 停用词过滤：无关问句不误命中');
{
  const out = rankFaq(FAQS, '今天天气怎么样');
  check('返回空', out.length === 0, out.map(f => f.question).join(' / '));
}

console.log('4. 短词也能召回多条');
{
  const out = rankFaq(FAQS, '退款', { limit: 5 });
  check('命中多条退款相关', out.length >= 2, String(out.length));
  check('Top1 是退款类', out[0]?.category === '退款', out[0]?.category);
  // 答案里提到「退款」的订单类条目也会被召回（如「如何修改或取消订单？」的答案含「退货退款」），
  // 那是合理命中，所以只要求退款类占多数
  const refundCount = out.filter(f => f.category === '退款').length;
  check('退款类占多数', refundCount >= out.length - 1, `${refundCount}/${out.length}`);
}

console.log('5. 意图分类加权生效');
{
  const out = rankFaq(FAQS, '发货', { limit: 3, category: '订单查询' });
  check('Top1 是物流类', out[0]?.question.includes('查物流'), out[0]?.question);
}

console.log('6. limit 生效');
{
  const out = rankFaq(FAQS, '退款', { limit: 1 });
  check('只返回 1 条', out.length === 1, String(out.length));
}

console.log('7. 边界输入不崩');
{
  check('空字符串返回空', rankFaq(FAQS, '').length === 0);
  check('单个字符不崩', Array.isArray(rankFaq(FAQS, '订')));
  check('超长字符串不崩', Array.isArray(rankFaq(FAQS, '订'.repeat(500))));
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
process.exit(failures === 0 ? 0 : 1);
