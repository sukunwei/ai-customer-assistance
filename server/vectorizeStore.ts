/**
 * Cloudflare Vectorize 向量存储
 *
 * 与 sqlite-vec 实现同一个 VectorStore 接口，可以配置切换。
 *
 * 三个和本地 sqlite-vec 不同的关键点：
 *  1. **写入异步生效**：Vectorize 先把向量写进 WAL，异步 job 重建索引，
 *     实测约 60~100 秒后才可查询。刚写完就查会返回 0 条——
 *     这时候必须降级到关键词检索，否则会误判成「向量没命中」。
 *  2. **索引维度创建后不可改**：换 embedding 模型（维度变了）只能删了重建。
 *  3. **每次查询一次网络往返**：实测 250~700ms。
 */
import type { VectorStore } from './vectorStore.js';
import { createMemoryMetaStore, type MetaStore } from './ragMeta.js';

export interface VectorizeConfig {
  /** Cloudflare Account ID */
  accountId: string;
  /** 索引名（kebab-case） */
  indexName: string;
  /** API Token（需要 Account → Vectorize → Edit 权限） */
  apiKey: string;
  /** API 根地址，默认 Cloudflare 公网端点 */
  apiUrl?: string;
  /** 写入后多久内认为索引尚未就绪（毫秒），默认 120000 */
  readyDelayMs?: number;
  /** 距离度量，默认 cosine */
  metric?: 'cosine' | 'euclidean' | 'dot-product';
}

const DEFAULT_API_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_READY_DELAY = 120_000;

export function createVectorizeStore(config: VectorizeConfig, meta?: MetaStore): VectorStore {
  // 默认进程内（测试用）；生产环境由调用方注入持久化的 MetaStore
  let currentDim: number | null = null;
  /** 最近一次写入的时间；Vectorize 写入是异步的，这段时间内查询结果不可信 */
  let lastUpsertAt = 0;

  const available = Boolean(config.accountId && config.indexName && config.apiKey);
  const apiUrl = (config.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const indexesPath = `${apiUrl}/accounts/${config.accountId}/vectorize/v2/indexes`;
  const indexPath = `${indexesPath}/${config.indexName}`;
  const readyDelay = config.readyDelayMs ?? DEFAULT_READY_DELAY;
  const metaStore = meta ?? createMemoryMetaStore();

  /** 统一的请求封装：失败一律返回 null，绝不抛错 */
  const request = async (
    method: 'GET' | 'POST',
    url: string,
    options: { body?: string; contentType?: string } = {}
  ): Promise<any | null> => {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': options.contentType || 'application/json',
        },
        body: options.body,
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) {
        const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
        console.warn(`[Vectorize] ${method} ${url.split('/').pop()} 失败: ${message}`);
        return null;
      }
      return payload;
    } catch (error) {
      console.warn('[Vectorize] 请求异常:', (error as Error)?.message);
      return null;
    }
  };

  return {
    get available() {
      return available;
    },

    get dim() {
      return currentDim;
    },

    async prepare(dim: number): Promise<void> {
      if (!available) return;
      if (!Number.isFinite(dim) || dim <= 0) return;

      await (async () => {
        const existing = await request('GET', indexPath);
        if (existing?.result?.config?.dimensions) {
          const indexDim = existing.result.config.dimensions;
          if (indexDim !== dim) {
            // Vectorize 的维度在索引创建后不可改
            console.warn(
              `[Vectorize] 索引 ${config.indexName} 的维度是 ${indexDim}，与当前 embedding 的 ${dim} 不一致；` +
                'Vectorize 不支持修改维度，需要删除索引后重建'
            );
          }
          currentDim = indexDim;
          return;
        }

        // 索引不存在 → 按探测到的维度创建
        const created = await request('POST', indexesPath, {
          body: JSON.stringify({
            name: config.indexName,
            description: 'AI 客服 FAQ 向量索引',
            config: { dimensions: dim, metric: config.metric || 'cosine' },
          }),
        });
        if (created) {
          // 维度是我们指定的，即使响应里没有回显也要记下来
          currentDim = dim;
          console.log(`[Vectorize] 已创建索引 ${config.indexName}（${dim} 维）`);
        }
      })().catch((error) => {
        console.warn('[Vectorize] 确保索引失败:', (error as Error)?.message);
      });
    },

    upsert(id: number, vector: number[]): boolean {
      if (!available) return false;
      if (currentDim === null) {
        console.warn('[Vectorize] 索引维度未知，跳过写入');
        return false;
      }
      if (!Array.isArray(vector) || vector.length !== currentDim) {
        console.warn(
          `[Vectorize] 拒绝非法向量（id=${id}，期望维度 ${currentDim}，实际 ${vector?.length ?? '非数组'}）`
        );
        return false;
      }
      for (const component of vector) {
        if (typeof component !== 'number' || !Number.isFinite(component)) {
          console.warn(`[Vectorize] 拒绝非法向量（id=${id}，含非有限分量）`);
          return false;
        }
      }

      // 立即标记「最近有写入」——索引要 1 分钟左右才生效，
      // 这段时间内查询结果不可信，必须走降级
      lastUpsertAt = Date.now();

      const line = JSON.stringify({ id: String(id), values: vector });
      void (async () => {
        const result = await request('POST', `${indexPath}/upsert`, {
          body: line,
          contentType: 'application/x-ndjson',
        });
        if (result) {
          console.log('[Vectorize] 向量已写入（索引约 1 分钟内生效，生效前自动降级为关键词检索）');
        }
      })().catch((error) => {
        console.warn('[Vectorize] 写入向量失败:', (error as Error)?.message);
      });

      return true;
    },

    remove(_id: number): void {
      // Vectorize V2 没有单条删除接口（需要按 id 列表批量删）。
      // 当前没有 FAQ 删除功能，先不做处理。
    },

    async query(
      vector: number[],
      topK: number
    ): Promise<Array<{ id: number; distance: number }>> {
      if (!available || currentDim === null) return [];
      if (!Array.isArray(vector) || vector.length !== currentDim) {
        console.warn(
          `[Vectorize] 查询向量维度不匹配（期望 ${currentDim}，实际 ${vector?.length ?? '非数组'}），跳过向量检索`
        );
        return [];
      }
      if (!Number.isFinite(topK) || topK <= 0) return [];

      // 索引尚未生效时查不到东西——此时返回空，让上层降级到关键词检索，
      // 而不是把「还没生效」误判成「没有相似文档」
      if (lastUpsertAt > 0 && Date.now() - lastUpsertAt < readyDelay) {
        console.warn('[Vectorize] 索引尚未生效（Vectorize 写入是异步的），本次跳过向量检索');
        return [];
      }

      const payload = await request('POST', `${indexPath}/query`, {
        body: JSON.stringify({ vector, topK }),
      });
      const matches = payload?.result?.matches;
      if (!Array.isArray(matches)) return [];

      return matches.map((m: any) => ({
        id: Number(m.id),
        // Vectorize 的 score 是相似度（越大越像），统一转成 distance（越小越近）
        distance: 1 - Number(m.score ?? 0),
      }));
    },

    count(): number {
      const recorded = Number(metaStore.get('faq_count') || '0');
      return Number.isFinite(recorded) ? recorded : 0;
    },

    getMeta(key: string): string | null {
      return metaStore.get(key);
    },

    setMeta(key: string, value: string): void {
      metaStore.set(key, value);
    },
  };
}
