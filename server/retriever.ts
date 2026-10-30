/**
 * 检索层：关键词 + 向量的混合检索
 *
 * 两条路并行，任一路失败只损失该路召回：
 *  - 关键词路：现有的 `rankFaq` 打分逻辑（纯本地，零延迟）
 *  - 向量路：远程 embedding + sqlite-vec
 *
 * 融合用 RRF（Reciprocal Rank Fusion）：只看排名不看分数，
 * 因此不需要把「关键词打分」和「余弦距离」归一化到同一量纲。
 */

export interface RankedItem {
  id: number;
  /** RRF 融合分 */
  score: number;
  /** 命中该文档的检索器名 */
  sources: string[];
}

export interface RankingList {
  source: string;
  items: Array<{ id: number }>;
}

/** RRF 的标准平滑常数 */
const DEFAULT_RRF_K = 60;

/**
 * 把多路检索结果按 RRF 融合。
 *
 * score(doc) = Σ 1 / (k + rank)，rank 从 1 开始
 * 同分时保持传入顺序（先出现的排前面）。
 */
export function fuseRankings(
  lists: RankingList[],
  k: number = DEFAULT_RRF_K
): RankedItem[] {
  const merged = new Map<number, { score: number; sources: Set<string>; order: number }>();
  let order = 0;

  for (const list of lists) {
    list.items.forEach((item, index) => {
      const rank = index + 1;
      const existing = merged.get(item.id);
      if (existing) {
        existing.score += 1 / (k + rank);
        existing.sources.add(list.source);
      } else {
        merged.set(item.id, {
          score: 1 / (k + rank),
          sources: new Set([list.source]),
          order: order++,
        });
      }
    });
  }

  return Array.from(merged.entries())
    .map(([id, value]) => ({
      id,
      score: value.score,
      sources: [...value.sources],
    }))
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1e-12) return b.score - a.score;
      return 0; // 稳定排序：同分保持插入顺序
    });
}

export interface RetrieveFaqsOptions {
  topK: number;
  /** 关键词检索（同步） */
  keyword: (query: string, topK: number) => Array<{ id: number }>;
  /** 向量检索（异步），失败时自动降级 */
  vector?: (query: string, topK: number) => Promise<Array<{ id: number }>>;
}

/**
 * 混合检索。向量路出错时静默降级为纯关键词，绝不把异常抛给调用方——
 * 客服必须始终能回答。
 *
 * 两路各自多取一些候选（topK * 3）再融合：只取 topK 的话，
 * 向量路会无条件占掉一半名额，把关键词路的命中挤出去，
 * 而 FAQ 的 keywords 是人工整理的高质量词表，精确匹配上比向量更准。
 */
export async function retrieveFaqs(
  query: string,
  options: RetrieveFaqsOptions
): Promise<RankedItem[]> {
  const { topK, keyword, vector } = options;
  const candidateTopK = topK * 3;

  const keywordItems = safeSync(() => keyword(query, candidateTopK), 'keyword');
  const vectorItems = vector
    ? await safeAsync(() => vector(query, candidateTopK), 'vector')
    : [];

  const lists: RankingList[] = [{ source: 'keyword', items: keywordItems }];
  if (vectorItems.length > 0) {
    lists.push({ source: 'vector', items: vectorItems });
  }

  return fuseRankings(lists).slice(0, topK);
}

function safeSync<T>(fn: () => T, label: string): T {
  try {
    return fn();
  } catch (error) {
    console.warn(`[Retriever] ${label} 检索失败，降级处理:`, (error as Error)?.message);
    return [] as unknown as T;
  }
}

async function safeAsync<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[Retriever] ${label} 检索失败，降级处理:`, (error as Error)?.message);
    return [] as unknown as T;
  }
}
