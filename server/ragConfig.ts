/**
 * RAG（向量检索）配置
 *
 * 默认关闭：未开启时不发起任何 embedding 请求，系统行为与纯关键词检索完全一致。
 * 开关打开但 embedding 不可用时，检索层自动降级，用户无感。
 *
 * 默认指向 Cloudflare Workers AI 的 bge-m3（有免费额度、不按 RPM 限流、中文效果好），
 * 向量库默认用本地 sqlite-vec；两者都可以配置切换。
 */
import type { EmbeddingConfig, EmbeddingProtocol } from './embeddings.js';
import type { VectorizeConfig } from './vectorizeStore.js';

export type VectorStoreKind = 'sqlite' | 'vectorize';

export interface RagConfig {
  /** 向量检索是否启用 */
  enabled: boolean;
  /** 检索返回条数 */
  topK: number;
  embedding: EmbeddingConfig;
  /** 向量库后端 */
  vectorStore: VectorStoreKind;
  /** vectorize 后端的配置（vectorStore === 'vectorize' 时有效） */
  vectorize: VectorizeConfig;
}

const DEFAULT_BASE_URL = '';
const DEFAULT_MODEL = '@cf/baai/bge-m3';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TOP_K = 3;
const DEFAULT_VECTORIZE_INDEX = 'scs-faq';

function parseIntSafe(value: string | undefined, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 解析 API Key。
 *
 * 只有 minimax 协议才允许回退到 ANTHROPIC_AUTH_TOKEN —— 那是 MiniMax 的 key，
 * 拿去请求 Cloudflare/OpenAI 只会得到 401。其他协议必须显式配 EMBEDDING_API_KEY。
 */
function resolveApiKey(protocol: EmbeddingProtocol): string {
  if (process.env.EMBEDDING_API_KEY) return process.env.EMBEDDING_API_KEY;
  if (protocol === 'minimax') {
    return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
  }
  return '';
}

function resolveProtocol(): EmbeddingProtocol {
  const raw = String(process.env.EMBEDDING_PROTOCOL || '').trim().toLowerCase();
  if (raw === 'minimax' || raw === 'openai' || raw === 'cloudflare') return raw;
  return 'cloudflare';
}

function resolveVectorStore(): VectorStoreKind {
  const raw = String(process.env.VECTOR_STORE || '').trim().toLowerCase();
  return raw === 'vectorize' ? 'vectorize' : 'sqlite';
}

export function getRagConfig(): RagConfig {
  const protocol = resolveProtocol();
  const apiKey = resolveApiKey(protocol);
  const baseUrl = (process.env.EMBEDDING_BASE_URL || DEFAULT_BASE_URL).trim();

  const enabled =
    String(process.env.VECTOR_SEARCH || '').trim().toLowerCase() === 'on' &&
    Boolean(apiKey) &&
    Boolean(baseUrl);

  return {
    enabled,
    topK: parseIntSafe(process.env.RAG_TOP_K, DEFAULT_TOP_K),
    embedding: {
      baseUrl,
      apiKey,
      model: (process.env.EMBEDDING_MODEL || DEFAULT_MODEL).trim(),
      protocol,
      timeoutMs: parseIntSafe(process.env.EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    },
    vectorStore: resolveVectorStore(),
    vectorize: {
      accountId: (process.env.VECTORIZE_ACCOUNT_ID || '').trim(),
      indexName: (process.env.VECTORIZE_INDEX || DEFAULT_VECTORIZE_INDEX).trim(),
      // Cloudflare 的 embedding 与向量库用同一个 token
      apiKey: (process.env.VECTORIZE_API_KEY || apiKey).trim(),
    },
  };
}
