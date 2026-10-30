/**
 * server/ragConfig.ts 单元测试
 *
 * 运行: npx tsx scripts/test-rag-config.mts
 */
import { getRagConfig } from '../server/ragConfig.js';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const ENV_KEYS = [
  'VECTOR_SEARCH',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_MODEL',
  'EMBEDDING_PROTOCOL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_TIMEOUT_MS',
  'EMBEDDING_DIM',
  'RAG_TOP_K',
  'VECTOR_STORE',
  'VECTORIZE_ACCOUNT_ID',
  'VECTORIZE_INDEX',
  'VECTORIZE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];

const snapshot = { ...process.env };

function resetEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, snapshot);
}

const CF_BASE = 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run';

console.log('1. 开关');
{
  resetEnv();
  delete process.env.VECTOR_SEARCH;
  check('未设置 VECTOR_SEARCH → 关闭', getRagConfig().enabled === false);

  resetEnv();
  process.env.VECTOR_SEARCH = 'off';
  check('VECTOR_SEARCH=off → 关闭', getRagConfig().enabled === false);

  resetEnv();
  process.env.VECTOR_SEARCH = 'on';
  process.env.EMBEDDING_API_KEY = 'cfut-x';
  process.env.EMBEDDING_BASE_URL = CF_BASE;
  check('VECTOR_SEARCH=on 且配好 key/baseUrl → 开启', getRagConfig().enabled === true);
}

console.log('2. 配置不全时不开启');
{
  resetEnv();
  process.env.VECTOR_SEARCH = 'on';
  process.env.EMBEDDING_API_KEY = 'cfut-x';
  delete process.env.EMBEDDING_BASE_URL;
  check('缺 baseUrl → 关闭', getRagConfig().enabled === false);

  resetEnv();
  process.env.VECTOR_SEARCH = 'on';
  process.env.EMBEDDING_BASE_URL = CF_BASE;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  check('缺 key → 关闭', getRagConfig().enabled === false);
}

console.log('3. 默认值');
{
  resetEnv();
  delete process.env.VECTOR_SEARCH;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_PROTOCOL;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_TIMEOUT_MS;
  const cfg = getRagConfig();
  check('protocol 默认 cloudflare', cfg.embedding.protocol === 'cloudflare', cfg.embedding.protocol);
  check('model 默认 @cf/baai/bge-m3', cfg.embedding.model === '@cf/baai/bge-m3', cfg.embedding.model);
  check('baseUrl 默认空（必须在 .env 里填）', cfg.embedding.baseUrl === '', cfg.embedding.baseUrl);
  check('timeoutMs 默认 5000', cfg.embedding.timeoutMs === 5000, String(cfg.embedding.timeoutMs));
  check('topK 默认 3', cfg.topK === 3, String(cfg.topK));
}

console.log('4. key 回退顺序');
{
  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'minimax';
  process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
  check('minimax 协议回退到 ANTHROPIC_AUTH_TOKEN', getRagConfig().embedding.apiKey === 'auth-token');

  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'minimax';
  process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
  process.env.EMBEDDING_API_KEY = 'embed-key';
  check('EMBEDDING_API_KEY 优先', getRagConfig().embedding.apiKey === 'embed-key');

  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'minimax';
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'api-key';
  check('再回退到 ANTHROPIC_API_KEY', getRagConfig().embedding.apiKey === 'api-key');
}

console.log('5. 非 minimax 协议不自动借用 MiniMax 的 key');
{
  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'cloudflare';
  process.env.ANTHROPIC_AUTH_TOKEN = 'minimax-token';
  check('cloudflare 协议下不借 MiniMax 的 key', getRagConfig().embedding.apiKey === '', getRagConfig().embedding.apiKey);

  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'openai';
  process.env.ANTHROPIC_API_KEY = 'minimax-token';
  check('openai 协议下也不借', getRagConfig().embedding.apiKey === '', getRagConfig().embedding.apiKey);

  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'cloudflare';
  process.env.EMBEDDING_API_KEY = 'cfut-explicit';
  check('显式配了 EMBEDDING_API_KEY 仍然生效', getRagConfig().embedding.apiKey === 'cfut-explicit');
}

console.log('6. 可覆盖项');
{
  resetEnv();
  process.env.VECTOR_SEARCH = 'on';
  process.env.EMBEDDING_API_KEY = 'k';
  process.env.EMBEDDING_BASE_URL = CF_BASE;
  process.env.EMBEDDING_MODEL = '@cf/baai/bge-large-en-v1.5';
  process.env.EMBEDDING_PROTOCOL = 'cloudflare';
  process.env.EMBEDDING_TIMEOUT_MS = '9000';
  process.env.RAG_TOP_K = '5';
  const cfg = getRagConfig();
  check('model 可覆盖', cfg.embedding.model === '@cf/baai/bge-large-en-v1.5', cfg.embedding.model);
  check('protocol 可覆盖', cfg.embedding.protocol === 'cloudflare', cfg.embedding.protocol);
  check('baseUrl 可覆盖', cfg.embedding.baseUrl === CF_BASE, cfg.embedding.baseUrl);
  check('timeoutMs 可覆盖', cfg.embedding.timeoutMs === 9000, String(cfg.embedding.timeoutMs));
  check('topK 可覆盖', cfg.topK === 5, String(cfg.topK));
}

console.log('7. 非法值回退');
{
  resetEnv();
  process.env.EMBEDDING_PROTOCOL = '不存在的协议';
  process.env.EMBEDDING_TIMEOUT_MS = 'abc';
  process.env.RAG_TOP_K = 'abc';
  const cfg = getRagConfig();
  check('未知 protocol 回退 cloudflare', cfg.embedding.protocol === 'cloudflare', cfg.embedding.protocol);
  check('非法 timeout 回退 5000', cfg.embedding.timeoutMs === 5000, String(cfg.embedding.timeoutMs));
  check('非法 topK 回退 3', cfg.topK === 3, String(cfg.topK));
}

console.log('8. 向量库后端选择');
{
  resetEnv();
  delete process.env.VECTOR_STORE;
  check('默认 sqlite', getRagConfig().vectorStore === 'sqlite', getRagConfig().vectorStore);

  resetEnv();
  process.env.VECTOR_STORE = 'vectorize';
  check('可切到 vectorize', getRagConfig().vectorStore === 'vectorize', getRagConfig().vectorStore);

  resetEnv();
  process.env.VECTOR_STORE = '不存在的后端';
  check('未知后端回退 sqlite', getRagConfig().vectorStore === 'sqlite', getRagConfig().vectorStore);

  resetEnv();
  delete process.env.VECTORIZE_INDEX;
  check('Vectorize 索引名默认 scs-faq', getRagConfig().vectorize.indexName === 'scs-faq', getRagConfig().vectorize.indexName);
  check('Vectorize accountId 默认空', getRagConfig().vectorize.accountId === '');

  resetEnv();
  process.env.VECTORIZE_ACCOUNT_ID = 'acct-1';
  process.env.VECTORIZE_INDEX = 'my-index';
  check('accountId 可配置', getRagConfig().vectorize.accountId === 'acct-1');
  check('索引名可配置', getRagConfig().vectorize.indexName === 'my-index');

  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'cloudflare';
  process.env.EMBEDDING_API_KEY = 'cfut-shared';
  check('Vectorize 复用 EMBEDDING_API_KEY', getRagConfig().vectorize.apiKey === 'cfut-shared', getRagConfig().vectorize.apiKey);

  resetEnv();
  process.env.EMBEDDING_PROTOCOL = 'cloudflare';
  process.env.EMBEDDING_API_KEY = 'cfut-shared';
  process.env.VECTORIZE_API_KEY = 'cfut-specific';
  check('VECTORIZE_API_KEY 可单独覆盖', getRagConfig().vectorize.apiKey === 'cfut-specific', getRagConfig().vectorize.apiKey);
}

resetEnv();
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
process.exit(failures === 0 ? 0 : 1);
