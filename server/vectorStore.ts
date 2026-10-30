/**
 * sqlite-vec 向量存储
 *
 * 把向量存在项目已有的 SQLite 里（同一进程、同一事务），
 * 不引入独立的向量数据库服务。
 *
 * 降级：sqlite-vec 没装或加载失败时，`available` 为 false，
 * 所有方法安全返回空值而不抛错——检索层据此退化为纯关键词检索。
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createDbMetaStore, type MetaStore } from './ragMeta.js';

export interface VectorStore {
  /** sqlite-vec 是否加载成功 */
  readonly available: boolean;
  /** 当前索引维度，尚未建表为 null */
  readonly dim: number | null;
  /**
   * 准备索引（设置维度；维度变化时清空重建）。
   *
   * 必须是异步的：远程向量库（Cloudflare Vectorize）需要先查/建索引才知道维度，
   * 同步返回会导致随后的写入因为「维度未知」全部失败。
   */
  prepare(dim: number): Promise<void>;
  /** 写入一条向量，非法向量返回 false */
  upsert(id: number, vector: number[]): boolean;
  /** 删除一条向量 */
  remove(id: number): void;
  /**
   * 相似度检索，按距离升序。
   *
   * 返回 Promise 是因为远程向量库（Cloudflare Vectorize）的查询必然是网络调用；
   * 本地实现（sqlite-vec）直接返回已 resolve 的 Promise。
   */
  query(vector: number[], topK: number): Promise<Array<{ id: number; distance: number }>>;
  /** 当前索引条数 */
  count(): number;
  /** 读取索引元数据（如 embedding 模型、索引时间） */
  getMeta(key: string): string | null;
  /** 写入索引元数据 */
  setMeta(key: string, value: string): void;
}

const VEC_TABLE = 'faq_vec';

/** 向量是否合法：长度匹配且每个分量都是有限数 */
function isValidVector(vector: number[], dim: number): boolean {
  if (!Array.isArray(vector) || vector.length !== dim) return false;
  for (const component of vector) {
    if (typeof component !== 'number' || !Number.isFinite(component)) return false;
  }
  return true;
}

export function createVectorStore(db: Database.Database, meta?: MetaStore): VectorStore {
  let available = false;
  try {
    sqliteVec.load(db);
    available = true;
  } catch (error) {
    console.warn(
      '[Vector] sqlite-vec 加载失败，向量检索不可用（将退化为关键词检索）:',
      (error as Error)?.message
    );
  }

  const metaStore = meta ?? createDbMetaStore(db);
  let currentDim: number | null = null;

  if (available) {
    try {
      const recorded = metaStore.get('embedding_dim');
      if (recorded) {
        const parsed = parseInt(recorded, 10);
        if (Number.isFinite(parsed) && parsed > 0) currentDim = parsed;
      }
    } catch (error) {
      console.warn('[Vector] 初始化元数据表失败:', (error as Error)?.message);
    }
  }

  /** 建表（维度已知时） */
  const createVecTable = (dim: number) => {
    db.exec(`CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(faq_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}])`);
    metaStore.set('embedding_dim', String(dim));
  };

  /**
   * 写入一条向量。
   *
   * vec0 不支持 INSERT OR REPLACE（会抛 UNIQUE constraint failed），
   * 必须先删后插；两者放进同一个事务，避免中间态被查到。
   *
   * 只有 sqlite-vec 可用时才创建（db 可能是不可用的替身）。
   */
  const replaceVector = available
    ? db.transaction((rowId: bigint, payload: string) => {
        db.prepare(`DELETE FROM ${VEC_TABLE} WHERE faq_id = ?`).run(rowId);
        db.prepare(`INSERT INTO ${VEC_TABLE} (faq_id, embedding) VALUES (?, ?)`).run(rowId, payload);
      })
    : null;

  const ensureTable = () => {
    // 表可能已被手工删掉，确保它存在
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(VEC_TABLE);
    if (!exists && currentDim) createVecTable(currentDim);
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
      if (!Number.isFinite(dim) || dim <= 0) {
        console.warn(`[Vector] 非法维度 ${dim}，忽略`);
        return;
      }
      if (currentDim === dim) {
        ensureTable();
        return;
      }
      try {
        db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
        createVecTable(dim);
        currentDim = dim;
        console.log(`[Vector] 索引维度变更为 ${dim}，已重建`);
      } catch (error) {
        console.warn('[Vector] 重建索引失败:', (error as Error)?.message);
      }
    },

    upsert(id: number, vector: number[]): boolean {
      if (!available || currentDim === null) return false;
      if (!isValidVector(vector, currentDim)) {
        console.warn(
          `[Vector] 拒绝非法向量（id=${id}，期望维度 ${currentDim}，实际 ${vector?.length ?? '非数组'}）`
        );
        return false;
      }
      try {
        ensureTable();
        if (!replaceVector) return false;
        replaceVector(BigInt(id), JSON.stringify(vector));
        return true;
      } catch (error) {
        console.warn(`[Vector] 写入向量失败（id=${id}）:`, (error as Error)?.message);
        return false;
      }
    },

    remove(id: number): void {
      if (!available || currentDim === null) return;
      try {
        db.prepare(`DELETE FROM ${VEC_TABLE} WHERE faq_id = ?`).run(BigInt(id));
      } catch (error) {
        console.warn(`[Vector] 删除向量失败（id=${id}）:`, (error as Error)?.message);
      }
    },

    async query(vector: number[], topK: number): Promise<Array<{ id: number; distance: number }>> {
      if (!available || currentDim === null) return [];
      if (!isValidVector(vector, currentDim)) {
        // 不能静默返回空——否则会表现为「向量检索开着但永远召回不到东西」
        console.warn(
          `[Vector] 查询向量非法（期望维度 ${currentDim}，实际 ${vector?.length ?? '非数组'}），跳过向量检索`
        );
        return [];
      }
      if (!Number.isFinite(topK) || topK <= 0) return [];
      try {
        ensureTable();
        const rows = db
          .prepare(
            `SELECT faq_id, distance FROM ${VEC_TABLE} WHERE embedding MATCH ? AND k = ? ORDER BY distance`
          )
          .all(JSON.stringify(vector), topK) as Array<{ faq_id: number; distance: number }>;
        return rows.map(row => ({ id: row.faq_id, distance: row.distance }));
      } catch (error) {
        console.warn('[Vector] 相似度查询失败:', (error as Error)?.message);
        return [];
      }
    },

    count(): number {
      if (!available || currentDim === null) return 0;
      try {
        ensureTable();
        const row = db.prepare(`SELECT COUNT(*) AS c FROM ${VEC_TABLE}`).get() as { c: number };
        return row?.c ?? 0;
      } catch {
        return 0;
      }
    },

    getMeta(key: string): string | null {
      if (!available) return null;
      return metaStore.get(key);
    },

    setMeta(key: string, value: string): void {
      if (!available) return;
      metaStore.set(key, value);
    },
  };
}
