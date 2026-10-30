/**
 * FAQ 向量索引
 *
 * 服务启动后异步跑一次：把 FAQ 的「问题 + 答案」转成向量写进 sqlite-vec。
 * 失败不影响服务启动，只记日志——知识库没索引好，客服还能靠关键词检索工作。
 *
 * 两条重要约束：
 *  1. 维度必须从**实际写入的那批向量**里取。早先的实现先拿一条 'query' 向量探维度、
 *     再用 'db' 向量写入，若两者维度不同，所有向量都会被拒且错维度被持久化，
 *     导致向量检索永久失效。现在只发一次批量请求，维度必然与写入一致。
 *  2. FAQ 和模型都没变时不重建索引。embedding 是要花配额（甚至要钱）的，
 *     每次启动都全量重嵌既慢又会在限流时把索引搞砸。
 */
import type { VectorStore } from './vectorStore.js';

export interface IndexableFaq {
  id: number;
  question: string;
  answer: string;
  /** FAQ 的关键词表，参与内容哈希（改了关键词也要重建索引） */
  keywords?: string | null;
}

export type Embedder = (
  texts: string[],
  type: 'db' | 'query'
) => Promise<number[][]>;

export interface IndexFaqsOptions {
  /** 当前 embedding 模型名，用于判断索引是否过期 */
  model?: string;
  /** 强制重建（忽略过期判断） */
  force?: boolean;
}

/** 索引文本：问题 + 答案，让答案里的别名也能被匹配到 */
function buildIndexText(faq: IndexableFaq): string {
  return `${faq.question}\n${faq.answer}`;
}

/**
 * 索引是否需要重建：
 *  - 条数对不上（FAQ 增删过）
 *  - 记录的模型和当前模型不一致（换过 embedding 模型）
 *  - 索引是空的
 */
/** FNV-1a 32 位哈希，用于稳定地标识 FAQ 内容 */
function hashString(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}

/**
 * FAQ 内容哈希。
 *
 * 只比条数不够：条数不变但答案文字改了（或关键词改了），索引里留的还是旧向量。
 */
export function computeFaqHash(faqs: IndexableFaq[]): string {
  const text = faqs
    .map(faq => `${faq.id}\u0000${faq.question}\u0000${faq.answer}\u0000${faq.keywords ?? ''}`)
    .join('\u0001');
  return hashString(text);
}

export function needsReindex(
  store: VectorStore,
  faqs: IndexableFaq[],
  model?: string
): boolean {
  if (store.count() !== faqs.length) return true;
  if (model && store.getMeta('embedding_model') !== model) return true;
  // 内容变了（条数不变）同样要重建，否则索引里是过期向量
  if (store.getMeta('faq_hash') !== computeFaqHash(faqs)) return true;
  return false;
}

/**
 * 建立/更新 FAQ 向量索引，返回成功写入的条数。
 */
export async function indexFaqs(
  store: VectorStore,
  embedder: Embedder,
  faqs: IndexableFaq[],
  options: IndexFaqsOptions = {}
): Promise<number> {
  if (!store.available) {
    console.warn('[Vector] 向量库不可用，跳过 FAQ 索引');
    return 0;
  }
  if (!faqs || faqs.length === 0) return 0;

  // FAQ 与模型都没变 → 复用已有索引，不浪费配额
  if (!options.force && !needsReindex(store, faqs, options.model)) {
    console.log(`[Vector] 索引已是最新（${store.count()} 条），跳过重建`);
    return store.count();
  }

  try {
    const texts = faqs.map(buildIndexText);

    // 只发一次批量请求：维度直接取自这批向量，与写入的向量必然一致
    const vectors = await embedder(texts, 'db');
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      console.warn(
        `[Vector] 向量数量不匹配（期望 ${texts.length}，实得 ${vectors?.length ?? 0}），跳过 FAQ 索引`
      );
      return 0;
    }

    // 各条向量必须等长，否则建表后写入会被拒（静默失效）
    const dim = vectors[0]?.length ?? 0;
    if (dim === 0 || vectors.some(v => !Array.isArray(v) || v.length !== dim)) {
      console.warn('[Vector] 向量维度不一致或为空，跳过 FAQ 索引');
      return 0;
    }

    await store.prepare(dim);

    let written = 0;
    faqs.forEach((faq, index) => {
      if (store.upsert(faq.id, vectors[index])) written++;
    });

    if (options.model) store.setMeta('embedding_model', options.model);
    store.setMeta('faq_count', String(faqs.length));
    store.setMeta('faq_hash', computeFaqHash(faqs));
    store.setMeta('indexed_at', new Date().toISOString());

    return written;
  } catch (error) {
    console.warn('[Vector] FAQ 索引失败（降级为关键词检索）:', (error as Error)?.message);
    return 0;
  }
}
