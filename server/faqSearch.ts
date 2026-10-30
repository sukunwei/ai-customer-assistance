/**
 * FAQ 检索与排序
 *
 * 原来的做法是拿整句话做 `LIKE '%整句%'`，只有当用户输入恰好是 FAQ 原文的子串时才命中，
 * 自然语言问句（"我有多少订单"）几乎永远命中不了。
 *
 * 这里改成先切词、再按命中情况打分排序：
 *  - 主要信号是 FAQ 的 keywords 字段（逗号分隔的关键词组），做倒排匹配
 *  - 辅助信号是 query 的 2-gram 是否出现在 question 里
 *  - category 不再当过滤条件（过滤会让"分类对但关键词不匹配"的情况直接落空），
 *    降级成一个加权项
 */
import { toSimplified } from './text.js';

export interface FaqLike {
  question: string;
  answer: string;
  category: string;
  keywords?: string | null;
}

export interface RankFaqOptions {
  /** 返回条数，默认 3 */
  limit?: number;
  /** 当前识别出的意图分类，命中则加权 */
  category?: string;
}

/** 分数权重 */
const SCORE = {
  /** query 包含该关键词 */
  keywordInQuery: 5,
  /** 短 query 被关键词包含（如 query="退款" 命中 "退款时间"） */
  keywordContainsShortQuery: 2,
  /** 关键词出现在 question 里 */
  keywordInQuestion: 3,
  /** 关键词出现在 answer 里 */
  keywordInAnswer: 1,
  /** 2-gram 命中 question 的上限 */
  bigramMax: 3,
  /** 整句短语命中 */
  phrase: 5,
  /** 分类一致 */
  category: 2,
} as const;

/**
 * 停用词（疑问词、代词等泛用词）。
 *
 * 没有它们的话，「今天天气怎么样」会因为 2-gram「怎么」「如何」
 * 命中 FAQ 问句里的「怎么办？」「如何申请退款？」，把不相关的内容喂给模型。
 */
const STOPWORDS = new Set([
  '怎么', '怎样', '如何', '什么', '哪些', '哪个', '为什么', '为啥', '干嘛', '哪里', '何时',
  '多少', '几个', '可以', '能否', '能不能', '是不是', '有无', '有没有', '请问', '麻烦',
  '一下', '帮忙', '的话', '这个', '那个', '一个', '我们', '你们', '他们', '还有', '然后',
  '现在', '已经', '以及', '或者', '不是', '就是', '这种', '那种', '一直', '现在',
]);

/** 提取连续汉字段落的 2-gram，中文没有空格，只能靠双字滑窗近似分词 */
function bigrams(text: string): string[] {
  const out: string[] = [];
  const re = /[一-鿿]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const segment = match[0];
    for (let i = 0; i + 2 <= segment.length; i++) {
      const gram = segment.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) out.push(gram);
    }
  }
  return out;
}

/** 拆 keywords 字段 */
function splitKeywords(keywords?: string | null): string[] {
  if (!keywords) return [];
  return keywords
    .split(/[,，、\s]+/)
    .map(k => k.trim())
    .filter(Boolean);
}

/** 给单条 FAQ 打分 */
function scoreFaq(faq: FaqLike, query: string, grams: string[], category?: string): number {
  const question = toSimplified(faq.question || '');
  const answer = toSimplified(faq.answer || '');
  const keywords = splitKeywords(faq.keywords);

  let score = 0;

  for (const keyword of keywords) {
    const kw = toSimplified(keyword);
    if (!kw) continue;

    if (query.includes(kw)) {
      // query 命中了这个关键词
      score += SCORE.keywordInQuery;
      // 该关键词同时出现在标题/答案里，说明这条 FAQ 正是讲这件事的
      if (question.includes(kw)) score += SCORE.keywordInQuestion;
      if (answer.includes(kw)) score += SCORE.keywordInAnswer;
    } else if (query.length <= 4 && kw.includes(query)) {
      // 短 query 被关键词包含（如 query="退款" 命中关键词 "退款时间"）
      score += SCORE.keywordContainsShortQuery;
    }
  }

  // query 的 2-gram 命中标题或答案（同一 gram 只计一次）
  const hitGrams = new Set<string>();
  for (const gram of grams) {
    if (question.includes(gram) || answer.includes(gram)) hitGrams.add(gram);
  }
  score += Math.min(hitGrams.size, SCORE.bigramMax);

  // 整句短语命中
  if (query && (question.includes(query) || answer.includes(query))) {
    score += SCORE.phrase;
  }

  // 分类一致
  if (category && faq.category === category) {
    score += SCORE.category;
  }

  return score;
}

/**
 * 按相关度排序 FAQ。
 *
 * 分数为 0 的条目会被丢弃 —— 宁可返回空，让模型走「查不到就转人工」的话术，
 * 也不要塞给它不相关的 FAQ 让它硬凑答案。
 */
export function rankFaq<T extends FaqLike>(
  items: T[],
  query: string,
  options: RankFaqOptions = {}
): T[] {
  const limit = options.limit ?? 3;
  const normalizedQuery = toSimplified((query || '').trim());
  if (!normalizedQuery) return [];

  const grams = bigrams(normalizedQuery);

  const scored = items
    .map(faq => ({ faq, score: scoreFaq(faq, normalizedQuery, grams, options.category) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(entry => entry.faq);
}
