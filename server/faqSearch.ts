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
  /**
   * 命中所需的最少「强信号」数，默认 1。
   *
   * 强信号 = FAQ 的关键词被 query 精确命中（或短 query 被关键词包含）或整句短语命中；
   * 弱信号 = 只有 2-gram 偶然匹配。
   *
   * 实测证明弱信号里真假混杂且分数相同（「手机号能不能换」是真命中 2 分，
   * 「钱什么时候能回来」命中「工作时间」是噪声也是 2 分），靠总分阈值无法区分。
   * 所以弱信号一律不返回——它们交给向量路（实测这些真命中向量路都能召回）。
   */
  minStrongHits?: number;
}

/** 单条 FAQ 的打分结果 */
export interface FaqScore {
  /** 总分，用于排序 */
  total: number;
  /** 强信号命中数：关键词精确匹配 / 短 query 反向匹配 / 整句短语命中 */
  strongHits: number;
  /** 弱信号命中数：2-gram 命中 */
  gramHits: number;
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
function scoreFaq(faq: FaqLike, query: string, grams: string[], category?: string): FaqScore {
  const question = toSimplified(faq.question || '');
  const answer = toSimplified(faq.answer || '');
  const keywords = splitKeywords(faq.keywords);

  let total = 0;
  let strongHits = 0;
  let gramHits = 0;

  for (const keyword of keywords) {
    const kw = toSimplified(keyword);
    if (!kw) continue;

    if (query.includes(kw)) {
      // query 精确命中了这个关键词 —— 强信号
      total += SCORE.keywordInQuery;
      strongHits++;
      // 该关键词同时出现在标题/答案里，说明这条 FAQ 正是讲这件事的
      if (question.includes(kw)) total += SCORE.keywordInQuestion;
      if (answer.includes(kw)) total += SCORE.keywordInAnswer;
    } else if (query.length <= 4 && kw.includes(query)) {
      // 短 query 被关键词包含（如 query="退款" 命中 "退款时间"）—— 也是强信号
      total += SCORE.keywordContainsShortQuery;
      strongHits++;
    }
  }

  // query 的 2-gram 命中标题或答案（同一 gram 只计一次）—— 弱信号
  const hitGrams = new Set<string>();
  for (const gram of grams) {
    if (question.includes(gram) || answer.includes(gram)) hitGrams.add(gram);
  }
  gramHits = hitGrams.size;
  total += Math.min(gramHits, SCORE.bigramMax);

  // 整句短语命中 —— 强信号
  if (query && (question.includes(query) || answer.includes(query))) {
    total += SCORE.phrase;
    strongHits++;
  }

  // 分类一致 —— 弱信号（分类相同不代表内容相关）
  if (category && faq.category === category) {
    total += SCORE.category;
  }

  return { total, strongHits, gramHits };
}

/**
 * 按相关度排序 FAQ。
 *
 * 只保留达到强信号门槛的条目 —— 宁可返回空，让模型走「查不到就转人工」的话术，
 * 也不要塞给它不相关的 FAQ 让它硬凑答案。
 */
export function rankFaq<T extends FaqLike>(
  items: T[],
  query: string,
  options: RankFaqOptions = {}
): T[] {
  const limit = options.limit ?? 3;
  const minStrongHits = options.minStrongHits ?? 1;
  const normalizedQuery = toSimplified((query || '').trim());
  if (!normalizedQuery) return [];

  const grams = bigrams(normalizedQuery);

  const scored = items
    .map(faq => ({ faq, score: scoreFaq(faq, normalizedQuery, grams, options.category) }))
    .filter(entry => entry.score.strongHits >= minStrongHits)
    .sort((a, b) => b.score.total - a.score.total);

  return scored.slice(0, limit).map(entry => entry.faq);
}
