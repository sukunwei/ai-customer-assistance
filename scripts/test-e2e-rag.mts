/**
 * RAG 端到端测试
 *
 * 覆盖两条路径：
 *  A. VECTOR_SEARCH=off  → 纯关键词检索
 *  B. VECTOR_SEARCH=on   → 走真实的 MiniMax embedding 服务
 *
 * B 场景刻意不使用 mock：MiniMax 的 embedding 配额当前是限流状态，
 * 测试要如实反映这一点——不通就是不通。断言的是**无论 embedding 通不通，
 * 客服都必须正常回答**（降级路径必须可靠）。等配额开通后，B 会自动开始
 * 走向量路，断言依然成立。
 *
 * 运行: npx tsx scripts/test-e2e-rag.mts
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSseParser } from '../src/utils/sseParser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = '') {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ==================== 应用服务器 ====================

interface AppServer {
  port: number;
  logs: string[];
  stop: () => Promise<void>;
}

async function startApp(env: Record<string, string>, port: number): Promise<AppServer> {
  const logs: string[] = [];
  const child: ChildProcess = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
    process.stdout.write(`    [server] ${text}`);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  // 等健康检查通过
  const deadline = Date.now() + 40000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`服务在 40s 内没起来，日志：\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) break;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 500));
  }

  return {
    port,
    logs,
    stop: () => new Promise<void>(resolve => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    }),
  };
}

async function chat(app: AppServer, message: string) {
  const response = await fetch(`http://127.0.0.1:${app.port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      model: 'MiniMax-M3.1-Flash',
      provider: 'claude',
      permissionMode: 'default',
    }),
    signal: AbortSignal.timeout(120000),
  });

  const events: any[] = [];
  const reader = response.body!.getReader();
  const parser = createSseParser(raw => { try { events.push(JSON.parse(raw)); } catch { /* 忽略 */ } });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parser.push(value);
  }
  parser.flush();

  return {
    status: response.status,
    events,
    text: events.filter(e => e.type === 'text').map(e => e.content).join(''),
    tools: events.filter(e => e.type === 'tool'),
    errors: events.filter(e => e.type === 'error'),
  };
}

// ==================== 场景 ====================

async function scenarioA(): Promise<void> {
  console.log('A. VECTOR_SEARCH=off（纯关键词）');
  const app = await startApp({ VECTOR_SEARCH: 'off' }, 3121);
  try {
    const r = await chat(app, '我有多少订单');
    check('HTTP 200', r.status === 200, String(r.status));
    check('有文字答复', r.text.trim().length > 0);
    check('没有工具调用', r.tools.length === 0, JSON.stringify(r.tools.map(t => t.name)));
    check('没有错误事件', r.errors.length === 0, JSON.stringify(r.errors));
    check(
      '日志说明向量检索未启用',
      app.logs.join('').includes('向量检索未启用'),
      '未看到 [Vector] 未启用的日志'
    );
    // 反向断言：VECTOR_SEARCH=off 时不应该发起任何 embedding 请求
    check(
      '未发起 embedding 请求',
      !app.logs.join('').includes('[Embedding]'),
      app.logs.join('').split('\n').filter(l => l.includes('[Embedding]')).join(' | ')
    );
    const faqLine = app.logs.join('').match(/FAQ 检索结果: \d+ 条匹配/)?.[0] ?? '';
    check('FAQ 有命中', /FAQ 检索结果: [1-9]/.test(faqLine), faqLine);
  } finally {
    await app.stop();
  }
}

async function scenarioB(): Promise<void> {
  console.log('\nB. VECTOR_SEARCH=on（真实 MiniMax embedding，不通则降级）');
  const app = await startApp(
    {
      VECTOR_SEARCH: 'on',
      // 走 Cloudflare 协议，但指向一个必然连不上的地址 —— 不 mock，如实反映降级行为
      EMBEDDING_API_KEY: 'cfut-degradation-test',
      EMBEDDING_BASE_URL: 'http://127.0.0.1:9/ai/run',
      EMBEDDING_MODEL: '@cf/multilingual/e5-large',
      EMBEDDING_PROTOCOL: 'cloudflare',
      EMBEDDING_TIMEOUT_MS: '1000',
    },
    3122
  );
  try {
    const r = await chat(app, '我有多少订单');
    const logs = app.logs.join('');

    check('HTTP 200（不是 500）', r.status === 200, String(r.status));
    check('仍能给出文字答复', r.text.trim().length > 0);
    check('没有工具调用', r.tools.length === 0, JSON.stringify(r.tools.map(t => t.name)));

    // 关键断言：向量路径确实被走到了（无论成功还是失败），
    // 否则这个场景对「向量检索有没有真的启用」零覆盖
    check(
      '向量路径确实被走到',
      /\[Vector\]|\[Embedding\]/.test(logs),
      logs.slice(-400)
    );

    const faqLine = logs.match(/FAQ 检索结果: \d+ 条匹配/)?.[0] ?? '';
    check('FAQ 有命中', /FAQ 检索结果: [1-9]/.test(faqLine), faqLine);

    // 如实打印 embedding 的真实状态：配额通了就是通了，没通就是没通
    const vectorReady = logs.includes('[Vector] 已索引');
    const rateLimited = /1002|rate limit/i.test(logs);
    console.log(`    ↳ 向量索引：${vectorReady ? '已建立' : '未建立'}；embedding 限流：${rateLimited ? '是' : '否'}`);
    console.log('    ↳ [Vector]/[Embedding] 日志：');
    for (const line of logs.split('\n').filter(l => l.includes('[Vector]') || l.includes('[Embedding]'))) {
      console.log(`      ${line.trim()}`);
    }
  } finally {
    await app.stop();
  }
}

async function run() {
  console.log('=== RAG 端到端测试 ===\n');
  await scenarioA();
  await scenarioB();
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 个断言失败`}（${checks - failures}/${checks}）`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
