/**
 * 向量索引的元数据存储
 *
 * 索引元数据（embedding 模型、FAQ 条数、内容哈希）需要跨进程重启保留，
 * 否则每次启动都会判定「索引过期」而重新 embedding，白烧配额。
 *
 * 两种实现：
 *  - createDbMetaStore   —— 存进项目已有的 SQLite（chat.db），重启后仍在
 *  - createMemoryMetaStore —— 进程内 Map，测试用
 */
import Database from 'better-sqlite3';

export interface MetaStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const META_TABLE = 'rag_index_meta';

export function createDbMetaStore(db: Database.Database): MetaStore {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT)`);
  } catch (error) {
    console.warn('[RAG] 创建元数据表失败:', (error as Error)?.message);
  }

  return {
    get(key: string): string | null {
      try {
        const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(key) as
          | { value: string }
          | undefined;
        return row?.value ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        db.prepare(`INSERT OR REPLACE INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(key, value);
      } catch (error) {
        console.warn(`[RAG] 写入元数据失败（${key}）:`, (error as Error)?.message);
      }
    },
  };
}

export function createMemoryMetaStore(): MetaStore {
  const map = new Map<string, string>();
  return {
    get(key: string): string | null {
      return map.get(key) ?? null;
    },
    set(key: string, value: string): void {
      map.set(key, value);
    },
  };
}
