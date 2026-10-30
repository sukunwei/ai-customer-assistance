/**
 * 远程 embedding 客户端
 *
 * 支持两种协议：
 *  - minimax : POST {baseUrl}/embeddings  body {model, type, texts}
 *              响应 {vectors: number[][], base_resp: {status_code, status_msg}}
 *  - openai  : POST {baseUrl}/embeddings  body {model, input}
 *              响应 {data: [{embedding: number[]}]}
 *
 * 重要：MiniMax 用 **HTTP 200 + base_resp.status_code != 0** 表达错误，
 * 只看 HTTP 状态码会把限流当成成功，拿到空向量。
 *
 * 限流（status_code=1002 或 HTTP 429）触发指数退避重试，但重试次数有上限——
 * 查询路径不能为了向量检索让用户等上几十秒，超出即失败，由检索层降级。
 */

export type EmbeddingProtocol = 'minimax' | 'openai' | 'cloudflare';

export interface EmbeddingConfig {
  /** 例 'https://api.minimax.io/v1' */
  baseUrl: string;
  apiKey: string;
  /** 例 'embo-01' */
  model: string;
  protocol: EmbeddingProtocol;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 退避初始延迟（毫秒），默认 1000 */
  retryBaseDelayMs?: number;
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** 缓存条目上限 */
const CACHE_MAX = 256;

/** 熔断：连续失败多少次后打开 */
const CIRCUIT_FAILURE_THRESHOLD = 3;
/** 熔断打开后的冷却时长 */
const CIRCUIT_COOLDOWN_MS = 60_000;

/** 进程内缓存：key = baseUrl:protocol:model:type:text */
const cache = new Map<string, number[]>();

/** 熔断状态 */
let circuitFailures = 0;
let circuitOpenUntil = 0;

function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

function recordFailure(): void {
  circuitFailures++;
  if (circuitFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.warn(
      `[Embedding] 连续 ${circuitFailures} 次失败，熔断 ${CIRCUIT_COOLDOWN_MS / 1000}s（期间直接降级，不发请求）`
    );
  }
}

function recordSuccess(): void {
  circuitFailures = 0;
  circuitOpenUntil = 0;
}

/** 清空缓存并重置熔断（测试与运维用） */
export function clearEmbeddingCache(): void {
  cache.clear();
  circuitFailures = 0;
  circuitOpenUntil = 0;
}

function cacheGet(key: string): number[] | undefined {
  const hit = cache.get(key);
  if (hit) {
    // 命中后移到末尾，保持 LRU 顺序
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: number[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * 校验向量本身是否可用。
 *
 * 不校验的后果：含非法分量或长度不一致的向量会被照单全收、写进缓存，
 * 之后每次查询都被向量库拒绝——表现为「向量检索开着、日志正常，但永远召回不到东西」。
 */
function validateVectors(vectors: number[][]): void {
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) {
    throw new EmbeddingError('embedding vector is empty', 'invalid_vector');
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dim) {
      throw new EmbeddingError(
        `embedding vector dimensions differ: expected ${dim}, got ${vector?.length ?? 'non-array'}`,
        'dimension_mismatch'
      );
    }
    for (const component of vector) {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new EmbeddingError(
          'embedding vector contains a non-finite or non-numeric component',
          'invalid_vector'
        );
      }
    }
  }
}

function isTimeout(error: unknown): boolean {
  const e = error as { name?: string; message?: string };
  if (!e) return false;
  return e.name === 'AbortError' || /abort|timeout|timed out/i.test(e.message || '');
}

/** MiniMax 用业务码 1002 表示频率限制 */
const RATE_LIMIT_CODE = '1002';

interface RawResponse {
  status: number;
  body: any;
}

async function requestOnce(
  texts: string[],
  config: EmbeddingConfig,
  type: 'db' | 'query'
): Promise<RawResponse> {
  // Cloudflare Workers AI 的端点形如
  // {base}/accounts/{account_id}/ai/run/{模型名}，模型名自带 @cf/ 前缀；
  // 其余两家是 {base}/embeddings。
  const url =
    config.protocol === 'cloudflare'
      ? `${config.baseUrl.replace(/\/+$/, '')}/${config.model}`
      : `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };

  const body =
    config.protocol === 'minimax'
      ? { model: config.model, type, texts }
      : config.protocol === 'cloudflare'
        ? { text: texts }
        : { model: config.model, input: texts };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  const parsed = await response.json().catch(() => null);

  if (response.status === 429) {
    throw new EmbeddingError(`embedding rate limited (HTTP 429)`, '429');
  }

  if (!response.ok) {
    throw new EmbeddingError(
      `embedding request failed: HTTP ${response.status}`,
      String(response.status)
    );
  }

  return { status: response.status, body: parsed };
}

/** 从响应里取出向量，同时把业务错误码翻译成异常 */
function extractVectors(response: RawResponse, protocol: EmbeddingProtocol): number[][] {
  const body = response.body;

  if (protocol === 'minimax') {
    const code = body?.base_resp?.status_code;
    if (code !== undefined && code !== 0) {
      throw new EmbeddingError(
        `embedding API error ${code}: ${body?.base_resp?.status_msg || 'unknown'}`,
        String(code)
      );
    }
    const vectors = body?.vectors;
    if (!Array.isArray(vectors) || vectors.length === 0) {
      throw new EmbeddingError('embedding response contained no vectors', 'empty_response');
    }
    return vectors;
  }

  if (protocol === 'cloudflare') {
    // Workers AI 用 success 字段表达业务错误（HTTP 仍可能是 200）
    if (body?.success === false) {
      const first = body?.errors?.[0];
      const code = first?.code;
      throw new EmbeddingError(
        `embedding API error ${code ?? ''}: ${first?.message || 'unknown'}`.trim(),
        String(code ?? 'unknown')
      );
    }
    const data = body?.result?.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new EmbeddingError('embedding response contained no vectors', 'empty_response');
    }
    return data;
  }

  const data = body?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new EmbeddingError('embedding response contained no vectors', 'empty_response');
  }
  return data.map((item: any) => {
    if (!Array.isArray(item?.embedding)) {
      throw new EmbeddingError('embedding response item has no embedding array', 'empty_response');
    }
    return item.embedding as number[];
  });
}

function isRateLimited(error: unknown): boolean {
  return error instanceof EmbeddingError && (error.code === RATE_LIMIT_CODE || error.code === '429');
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 把一组文本变成向量。
 *
 * @param maxRetries 限流时的最大重试次数（默认 2，即最多发 3 次请求）
 */
export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig,
  type: 'db' | 'query' = 'query',
  maxRetries = 2
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const results: number[][] = new Array(texts.length);
  const pending: Array<{ index: number; text: string; key: string }> = [];

  texts.forEach((text, index) => {
    const key = `${config.baseUrl}:${config.protocol}:${config.model}:${type}:${text}`;
    const hit = cacheGet(key);
    if (hit) {
      results[index] = hit;
    } else {
      pending.push({ index, text, key });
    }
  });

  if (pending.length === 0) return results;

  // 熔断打开时直接失败降级，不再发网络请求——
  // 否则 embedding 长期不可用时，每个用户请求都要白等一轮退避。
  if (isCircuitOpen()) {
    throw new EmbeddingError(
      'embedding circuit is open (service unavailable, degraded to keyword search)',
      'circuit_open'
    );
  }

  const baseDelay = config.retryBaseDelayMs ?? 1000;
  let attempt = 0;

  for (;;) {
    try {
      const response = await requestOnce(
        pending.map(p => p.text),
        config,
        type
      );
      const vectors = extractVectors(response, config.protocol);

      if (vectors.length !== pending.length) {
        throw new EmbeddingError(
          `embedding response count mismatch: expected ${pending.length}, got ${vectors.length}`,
          'count_mismatch'
        );
      }

      // 校验通过才允许进缓存——坏向量一旦入缓存，后续每次查询都会被拒
      validateVectors(vectors);

      pending.forEach((p, i) => {
        cacheSet(p.key, vectors[i]);
        results[p.index] = vectors[i];
      });
      recordSuccess();
      return results;
    } catch (error) {
      if (isTimeout(error)) {
        recordFailure();
        throw new EmbeddingError('embedding request timeout', 'timeout');
      }
      if (isRateLimited(error) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        attempt++;
        console.warn(
          `[Embedding] 触发限流，${delay}ms 后重试（第 ${attempt}/${maxRetries} 次）`
        );
        await sleep(delay);
        continue;
      }
      recordFailure();
      throw error;
    }
  }
}
