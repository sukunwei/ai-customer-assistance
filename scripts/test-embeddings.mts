/**
 * server/embeddings.ts 单元测试
 *
 * 用 globalThis.fetch 打桩，不发真实网络请求。
 * 运行: npx tsx scripts/test-embeddings.mts
 */
import assert from 'node:assert/strict';
import {
  embedTexts,
  EmbeddingError,
  clearEmbeddingCache,
  type EmbeddingConfig,
} from '../server/embeddings.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const realFetch = globalThis.fetch;

interface Call { url: string; init: any; }

function stubFetch(handler: (call: Call, index: number) => any) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { url: String(url), init };
    calls.push(call);
    const result = handler(call, calls.length - 1);
    if (result instanceof Error) throw result;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
    };
  }) as any;
  return calls;
}

function restoreFetch() { globalThis.fetch = realFetch; }

const MINIMAX_CONFIG: EmbeddingConfig = {
  baseUrl: 'https://api.minimax.io/v1',
  apiKey: 'sk-cp-test-key',
  model: 'embo-01',
  protocol: 'minimax',
  timeoutMs: 1000,
  retryBaseDelayMs: 1,   // 测试里把退避压到 1ms
};

const CF_CONFIG_TEST: EmbeddingConfig = {
  baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run',
  apiKey: 'cfut-test',
  model: '@cf/multilingual/e5-large',
  protocol: 'cloudflare',
  timeoutMs: 1000,
  retryBaseDelayMs: 1,
};

const OPENAI_CONFIG: EmbeddingConfig = {
  ...MINIMAX_CONFIG,
  baseUrl: 'https://api.example.com/v1',
  model: 'text-embedding-3-small',
  protocol: 'openai',
};

async function expectError(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
    check(label, false, '没有抛错');
    return undefined;
  } catch (e: any) {
    return e;
  }
}

async function run() {
  // ---------- 1. minimax 协议 ----------
  console.log('1. minimax 协议');
  {
    clearEmbeddingCache();
    const calls = stubFetch(() => ({
      status: 200,
      body: { vectors: [[1, 2], [3, 4]], base_resp: { status_code: 0, status_msg: 'success' } },
    }));
    const out = await embedTexts(['甲', '乙'], MINIMAX_CONFIG, 'db');
    check('返回两条向量', JSON.stringify(out) === JSON.stringify([[1, 2], [3, 4]]), JSON.stringify(out));
    check('请求发到 baseUrl/embeddings', calls[0].url === 'https://api.minimax.io/v1/embeddings', calls[0].url);
    check('Authorization 头', calls[0].init.headers.Authorization === 'Bearer sk-cp-test-key');
    const body = JSON.parse(calls[0].init.body);
    check('请求体含 model', body.model === 'embo-01', JSON.stringify(body));
    check('请求体含 type=db', body.type === 'db', JSON.stringify(body));
    check('请求体含 texts', Array.isArray(body.texts) && body.texts.length === 2, JSON.stringify(body));
    check('请求体不含 input 字段', body.input === undefined, JSON.stringify(body));
    restoreFetch();
  }

  // ---------- 2. openai 协议 ----------
  console.log('2. openai 协议');
  {
    clearEmbeddingCache();
    const calls = stubFetch(() => ({
      status: 200,
      body: { data: [{ embedding: [1, 2] }] },
    }));
    const out = await embedTexts(['甲'], OPENAI_CONFIG, 'query');
    check('返回向量', JSON.stringify(out) === JSON.stringify([[1, 2]]), JSON.stringify(out));
    check('请求发到 baseUrl/embeddings', calls[0].url === 'https://api.example.com/v1/embeddings', calls[0].url);
    const body = JSON.parse(calls[0].init.body);
    check('请求体用 input', Array.isArray(body.input) && body.input[0] === '甲', JSON.stringify(body));
    check('请求体不含 texts', body.texts === undefined, JSON.stringify(body));
    restoreFetch();
  }

  // ---------- 3. 业务错误码（HTTP 200 但 status_code != 0）----------
  console.log('3. HTTP 200 但业务错误码');
  {
    clearEmbeddingCache();
    stubFetch(() => ({
      status: 200,
      body: { vectors: null, base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } },
    }));
    const err = await expectError(
      () => embedTexts(['甲'], MINIMAX_CONFIG, 'query', 0),
      '抛出 EmbeddingError'
    );
    check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
    check('code 为 1002', err?.code === '1002', String(err?.code));
    check('message 含 rate limit', /rate limit/i.test(String(err?.message)), String(err?.message));
    restoreFetch();
  }

  // ---------- 4. HTTP 错误 ----------
  console.log('4. HTTP 级错误');
  {
    clearEmbeddingCache();
    stubFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
    const err = await expectError(
      () => embedTexts(['甲'], OPENAI_CONFIG, 'query', 0),
      '抛出 EmbeddingError'
    );
    check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
    check('code 反映 HTTP 状态', err?.code === '401', String(err?.code));
    restoreFetch();
  }

  // ---------- 5. 空向量 ----------
  console.log('5. 200 但 vectors 为空');
  {
    clearEmbeddingCache();
    stubFetch(() => ({ status: 200, body: { vectors: null, base_resp: { status_code: 0 } } }));
    const err = await expectError(
      () => embedTexts(['甲'], MINIMAX_CONFIG, 'query', 0),
      '抛出 EmbeddingError'
    );
    check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
    check('code 为 empty_response', err?.code === 'empty_response', String(err?.code));
    restoreFetch();
  }

  // ---------- 6. 超时 ----------
  console.log('6. 超时');
  {
    clearEmbeddingCache();
    stubFetch(() => new Error('The operation was aborted due to timeout'));
    const err = await expectError(
      () => embedTexts(['甲'], MINIMAX_CONFIG, 'query', 0),
      '抛出 EmbeddingError'
    );
    check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
    check('code 为 timeout', err?.code === 'timeout', String(err?.code));
    restoreFetch();
  }

  // ---------- 7. 缓存 ----------
  console.log('7. 缓存');
  {
    clearEmbeddingCache();
    const calls = stubFetch(() => ({
      status: 200,
      body: { vectors: [[9, 9]], base_resp: { status_code: 0 } },
    }));
    await embedTexts(['缓存甲'], MINIMAX_CONFIG, 'query');
    await embedTexts(['缓存甲'], MINIMAX_CONFIG, 'query');
    check('相同文本+type 只请求一次', calls.length === 1, `实际 ${calls.length} 次`);

    await embedTexts(['缓存甲'], MINIMAX_CONFIG, 'db');
    check('type 不同则各请求一次', calls.length === 2, `实际 ${calls.length} 次`);

    await embedTexts(['缓存乙'], MINIMAX_CONFIG, 'query');
    check('不同文本各请求一次', calls.length === 3, `实际 ${calls.length} 次`);
    restoreFetch();
  }

  // ---------- 8. 缓存上限（LRU 淘汰）----------
  console.log('8. 缓存容量上限');
  {
    clearEmbeddingCache();
    const calls = stubFetch(() => ({
      status: 200,
      body: { vectors: [[1, 1]], base_resp: { status_code: 0 } },
    }));
    for (let i = 0; i < 260; i++) {
      await embedTexts([`容量${i}`], MINIMAX_CONFIG, 'query');
    }
    const before = calls.length;
    await embedTexts(['容量0'], MINIMAX_CONFIG, 'query');
    check('最早的条目被淘汰后重新请求', calls.length === before + 1, `实际 ${calls.length - before} 次新请求`);
    restoreFetch();
  }

  // ---------- 9. 限流退避重试 ----------
  console.log('9. 限流退避重试');
  {
    clearEmbeddingCache();
    const calls = stubFetch((_c, i) => {
      if (i < 2) {
        return { status: 200, body: { vectors: null, base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } } };
      }
      return { status: 200, body: { vectors: [[7, 7]], base_resp: { status_code: 0 } } };
    });
    const out = await embedTexts(['退避甲'], MINIMAX_CONFIG, 'query', 3);
    check('重试后成功返回', JSON.stringify(out) === JSON.stringify([[7, 7]]), JSON.stringify(out));
    check('共请求 3 次', calls.length === 3, `实际 ${calls.length} 次`);
    restoreFetch();
  }

  // ---------- 10. 退避次数上限 ----------
  console.log('10. 退避次数上限');
  {
    clearEmbeddingCache();
    const calls = stubFetch(() => ({
      status: 200,
      body: { vectors: null, base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } },
    }));
    const err = await expectError(
      () => embedTexts(['退避乙'], MINIMAX_CONFIG, 'query', 2),
      '超出重试次数后抛错'
    );
    check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
    check('共请求 3 次（首次+2次重试）', calls.length === 3, `实际 ${calls.length} 次`);
    restoreFetch();
  }

  // ---------- 11. HTTP 429 同样退避 ----------
  console.log('11. HTTP 429');
  {
    clearEmbeddingCache();
    const calls = stubFetch((_c, i) => {
      if (i < 1) return { status: 429, body: { error: 'too many requests' } };
      return { status: 200, body: { vectors: [[5, 5]], base_resp: { status_code: 0 } } };
    });
    const out = await embedTexts(['429甲'], MINIMAX_CONFIG, 'query', 2);
    check('429 后重试成功', JSON.stringify(out) === JSON.stringify([[5, 5]]), JSON.stringify(out));
    check('共请求 2 次', calls.length === 2, `实际 ${calls.length} 次`);
    restoreFetch();
  }

  // ---------- 12. 非限流错误不重试 ----------
  console.log('12. 非限流错误不重试');
  {
    clearEmbeddingCache();
    const calls = stubFetch(() => ({ status: 500, body: { error: 'boom' } }));
    await expectError(() => embedTexts(['500甲'], MINIMAX_CONFIG, 'query', 3), '500 应抛错');
    check('只请求 1 次', calls.length === 1, `实际 ${calls.length} 次`);
    restoreFetch();
  }

  console.log('13. 畸形向量必须被拒绝（否则会静默污染缓存与索引）');
{
  clearEmbeddingCache();
  stubFetch(() => ({
    status: 200,
    body: { vectors: [[1, 'x', 3]], base_resp: { status_code: 0 } },
  }));
  const err = await expectError(
    () => embedTexts(['畸形甲'], MINIMAX_CONFIG, 'query', 0),
    '含非数字分量的向量应抛错'
  );
  check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
  check('code 为 invalid_vector', err?.code === 'invalid_vector', String(err?.code));
  restoreFetch();
}

console.log('14. 含 NaN 的向量必须被拒绝');
{
  clearEmbeddingCache();
  stubFetch(() => ({
    status: 200,
    body: { vectors: [[1, NaN, 3]], base_resp: { status_code: 0 } },
  }));
  const err = await expectError(
    () => embedTexts(['畸形乙'], MINIMAX_CONFIG, 'query', 0),
    '含 NaN 的向量应抛错'
  );
  check('code 为 invalid_vector', err?.code === 'invalid_vector', String(err?.code));
  restoreFetch();
}

console.log('15. 各条向量长度不一致必须被拒绝');
{
  clearEmbeddingCache();
  stubFetch(() => ({
    status: 200,
    body: { vectors: [[1, 2, 3], [1, 2]], base_resp: { status_code: 0 } },
  }));
  const err = await expectError(
    () => embedTexts(['甲', '乙'], MINIMAX_CONFIG, 'query', 0),
    '长度不一致应抛错'
  );
  check('code 为 dimension_mismatch', err?.code === 'dimension_mismatch', String(err?.code));
  restoreFetch();
}

console.log('16. 被拒绝的向量不进缓存');
{
  clearEmbeddingCache();
  const calls = stubFetch(() => ({
    status: 200,
    body: { vectors: [[1, 'x']], base_resp: { status_code: 0 } },
  }));
  await expectError(() => embedTexts(['不入缓存'], MINIMAX_CONFIG, 'query', 0), '应抛错');
  await expectError(() => embedTexts(['不入缓存'], MINIMAX_CONFIG, 'query', 0), '应继续抛错');
  check('两次都发了请求（说明没被缓存）', calls.length === 2, `实际 ${calls.length} 次`);
  restoreFetch();
}

console.log('17. 熔断：连续失败后进入冷却窗口，窗口内不再发网络请求');
{
  clearEmbeddingCache();
  const calls = stubFetch(() => ({
    status: 200,
    body: { vectors: null, base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } },
  }));
  for (let i = 0; i < 4; i++) {
    await expectError(() => embedTexts([`熔断${i}`], MINIMAX_CONFIG, 'query', 0), '限流应抛错');
  }
  const before = calls.length;
  const err = await expectError(
    () => embedTexts(['熔断后再问'], MINIMAX_CONFIG, 'query', 0),
    '冷却窗口内应直接抛错'
  );
  check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
  check('code 为 circuit_open', err?.code === 'circuit_open', String(err?.code));
  check('冷却窗口内没有新的网络请求', calls.length === before, `新增 ${calls.length - before} 次`);
  restoreFetch();
  clearEmbeddingCache();
}

console.log('18. 熔断可被重置');
{
  clearEmbeddingCache();
  const calls = stubFetch(() => ({
    status: 200,
    body: { vectors: [[1, 2]], base_resp: { status_code: 0 } },
  }));
  const out = await embedTexts(['重置甲'], MINIMAX_CONFIG, 'query', 0);
  check('成功后正常工作', JSON.stringify(out) === JSON.stringify([[1, 2]]), JSON.stringify(out));
  check('只请求 1 次', calls.length === 1, `实际 ${calls.length} 次`);
  restoreFetch();
}

console.log('19. cloudflare 协议');
{
  clearEmbeddingCache();
  const CF_CONFIG: EmbeddingConfig = {
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run',
    apiKey: 'cfut-test',
    model: '@cf/multilingual/e5-large',
    protocol: 'cloudflare',
    timeoutMs: 1000,
    retryBaseDelayMs: 1,
  };
  const calls = stubFetch(() => ({
    status: 200,
    body: { result: { data: [[1, 2], [3, 4]], shape: [2, 2] }, success: true },
  }));
  const out = await embedTexts(['甲', '乙'], CF_CONFIG, 'db');
  check('返回两条向量', JSON.stringify(out) === JSON.stringify([[1, 2], [3, 4]]), JSON.stringify(out));
  check('URL 是 baseUrl + 模型名', calls[0].url === 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/multilingual/e5-large', calls[0].url);
  const body = JSON.parse(calls[0].init.body);
  check('请求体用 text', Array.isArray(body.text) && body.text.length === 2, JSON.stringify(body));
  check('请求体不含 texts/input', body.texts === undefined && body.input === undefined, JSON.stringify(body));
  restoreFetch();
}

console.log('20. cloudflare 业务错误（success=false）');
{
  clearEmbeddingCache();
  stubFetch(() => ({
    status: 200,
    body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null },
  }));
  const err = await expectError(
    () => embedTexts(['甲'], { ...CF_CONFIG_TEST }, 'query', 0),
    '应抛 EmbeddingError'
  );
  check('是 EmbeddingError', err instanceof EmbeddingError, String(err));
  check('code 为 10000', err?.code === '10000', String(err?.code));
  check('message 含 Authentication', /Authentication/i.test(String(err?.message)), String(err?.message));
  restoreFetch();
}

console.log('21. cloudflare 空向量');
{
  clearEmbeddingCache();
  stubFetch(() => ({
    status: 200,
    body: { result: { data: [], shape: [0, 0] }, success: true },
  }));
  const err = await expectError(
    () => embedTexts(['甲'], { ...CF_CONFIG_TEST }, 'query', 0),
    '应抛 EmbeddingError'
  );
  check('code 为 empty_response', err?.code === 'empty_response', String(err?.code));
  restoreFetch();
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
