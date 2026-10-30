/**
 * Provider 抽象层
 *
 * 目前支持两套 Agent SDK：
 *  - claude   : Claude Code Agent SDK (@anthropic-ai/claude-agent-sdk)，默认接入 MiniMax 的 Anthropic 兼容端点
 *  - codebuddy: CodeBuddy Agent SDK (@tencent-ai/agent-sdk)
 *
 * 两个 SDK 的 query() 签名一致，但事件流细节略有差异，这里统一归一化成 AgentEvent，
 * 上层（/api/chat）不需要关心当前用的是哪一家。
 */
import { query as claudeQuery, BUILTIN_TOOL_NAMES } from '@anthropic-ai/claude-agent-sdk';
import { query as codebuddyQuery, unstable_v2_authenticate } from '@tencent-ai/agent-sdk';

export type ProviderId = 'claude' | 'codebuddy';

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  description: string;
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  claude: {
    id: 'claude',
    name: 'Claude Code (MiniMax)',
    description: 'Claude Code Agent SDK，通过 Anthropic 兼容端点调用 MiniMax 模型',
    defaultModel: 'MiniMax-M3.1-Flash',
  },
  codebuddy: {
    id: 'codebuddy',
    name: 'CodeBuddy',
    description: 'CodeBuddy Agent SDK，需要 CodeBuddy CLI 登录或 CODEBUDDY_API_KEY',
    defaultModel: 'claude-sonnet-4',
  },
};

export const DEFAULT_PROVIDER: ProviderId = 'claude';

// ==================== Claude Code (MiniMax) 配置 ====================

export const CLAUDE_DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic';
export const CLAUDE_DEFAULT_MODEL = 'MiniMax-M3.1-Flash';

/** MiniMax 官方模型列表兜底（拉取 /v1/models 失败时使用） */
export const CLAUDE_FALLBACK_MODELS = [
  { modelId: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', description: '轻量快速，默认模型' },
  { modelId: 'MiniMax-M3', name: 'MiniMax-M3', description: 'M3 版本' },
  { modelId: 'MiniMax-M2.7', name: 'MiniMax-M2.7', description: 'M2.7 版本' },
  { modelId: 'MiniMax-M2.5', name: 'MiniMax-M2.5', description: 'M2.5 版本' },
  { modelId: 'MiniMax-M2.1', name: 'MiniMax-M2.1', description: 'M2.1 版本' },
  { modelId: 'MiniMax-M2', name: 'MiniMax-M2', description: 'M2 版本' },
];

export interface ClaudeConfig {
  baseUrl: string;
  authToken: string;
  model: string;
  /** 是否配置了鉴权信息 */
  configured: boolean;
}

export function getClaudeConfig(): ClaudeConfig {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || '';
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  return {
    baseUrl: process.env.ANTHROPIC_BASE_URL || CLAUDE_DEFAULT_BASE_URL,
    authToken: authToken || apiKey,
    model: process.env.ANTHROPIC_MODEL || CLAUDE_DEFAULT_MODEL,
    configured: Boolean(authToken || apiKey),
  };
}

/**
 * 拉取 MiniMax 可用模型列表（Anthropic 兼容端点）
 */
export async function fetchClaudeModels(config: ClaudeConfig = getClaudeConfig()): Promise<Array<{ modelId: string; name: string; description?: string }>> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/models`;
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };
  if (config.authToken) {
    headers['Authorization'] = `Bearer ${config.authToken}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`获取模型列表失败: HTTP ${response.status}`);
  }

  const payload: any = await response.json();
  const rawList: any[] = Array.isArray(payload?.data) ? payload.data : [];

  const models = rawList
    .map((item: any) => {
      const modelId = item?.id || item?.model_id || item?.model;
      if (!modelId) return null;
      return {
        modelId: String(modelId),
        name: String(item?.display_name || item?.name || modelId),
        description: item?.description,
      };
    })
    .filter(Boolean) as Array<{ modelId: string; name: string; description?: string }>;

  return models.length > 0 ? models : CLAUDE_FALLBACK_MODELS;
}

// ==================== Provider 选择 ====================

export function isProviderId(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codebuddy';
}

/**
 * 解析实际使用的 provider：请求指定 > 环境变量 AGENT_PROVIDER > 默认 claude
 */
export function resolveProvider(requested?: unknown): ProviderId {
  const raw = String(requested || process.env.AGENT_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  return isProviderId(raw) ? raw : DEFAULT_PROVIDER;
}

// ==================== 归一化事件流 ====================

export type PermissionOutcome =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type AgentEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'tool'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; toolId: string; content: string; isError: boolean }
  | { type: 'done'; durationMs?: number; costUsd?: number }
  | { type: 'error'; message: string };

export interface AgentRunOptions {
  cwd: string;
  model: string;
  systemPrompt: string;
  permissionMode: string;
  maxTurns: number;
  /** 上一次会话的 SDK session id（同 provider 才可复用） */
  resume?: string | null;
  /** 客户端断开时中断 Agent 运行 */
  abortController?: AbortController;
  /**
   * 禁用所有内置工具。
   *
   * 客服 Agent 必须禁用：它一旦能跑 Bash/Read，就会自己去翻项目文件找答案，
   * 并把这段工程调试过程当成客服答复发给客户。知识来源只能是拼好的 FAQ 上下文。
   */
  disableTools?: boolean;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID?: string }
  ) => Promise<PermissionOutcome>;
}

function stringifyToolContent(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const anyBlock = block as any;
          if (typeof anyBlock.text === 'string') return anyBlock.text;
          return JSON.stringify(block);
        }
        return String(block);
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * 把 SDK 的消息流转换成归一化事件。两个 SDK 的 assistant 消息结构一致，
 * 工具结果都放在 user 消息的 tool_result block 里。
 */
async function* normalizeStream(stream: AsyncIterable<any>): AsyncGenerator<AgentEvent> {
  for await (const msg of stream) {
    if (!msg || typeof msg !== 'object') continue;

    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id) yield { type: 'init', sessionId: msg.session_id };
      continue;
    }

    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (typeof content === 'string') {
        if (content) yield { type: 'text', content };
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            yield { type: 'text', content: block.text };
          } else if (block?.type === 'tool_use') {
            yield {
              type: 'tool',
              id: block.id,
              name: block.name,
              input: block.input,
            };
          }
        }
      }
      continue;
    }

    if (msg.type === 'user') {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_result') {
          yield {
            type: 'tool_result',
            toolId: block.tool_use_id,
            content: stringifyToolContent(block.content),
            isError: Boolean(block.is_error),
          };
        }
      }
      continue;
    }

    if (msg.type === 'result') {
      if (msg.is_error) {
        yield {
          type: 'error',
          message: typeof msg.result === 'string' && msg.result ? msg.result : 'Agent 执行失败',
        };
      } else {
        yield {
          type: 'done',
          durationMs: msg.duration_ms,
          costUsd: msg.total_cost_usd,
        };
      }
      continue;
    }
  }
}

/**
 * 构造 Claude Code 子进程的环境变量。
 *
 * Claude Code 的鉴权优先级是 ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN，
 * 这里保证「用户只配了 AUTH_TOKEN 时不会被残留的 API_KEY 抢先」。
 */
function buildClaudeEnv(config: ClaudeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  env.ANTHROPIC_BASE_URL = config.baseUrl;
  if (config.authToken) {
    env.ANTHROPIC_AUTH_TOKEN = config.authToken;
    if (!process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_API_KEY) {
      // 保留用户显式设置的 API Key（x-api-key 方式）
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    } else if (!process.env.ANTHROPIC_API_KEY) {
      delete env.ANTHROPIC_API_KEY;
    }
  }
  env.ANTHROPIC_MODEL = config.model;

  return env;
}

async function* runClaudeProvider(prompt: string, options: AgentRunOptions): AsyncGenerator<AgentEvent> {
  const config = getClaudeConfig();

  const claudeOptions: Record<string, unknown> = {
    cwd: options.cwd,
    model: options.model || config.model,
    maxTurns: options.maxTurns,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode,
    canUseTool: async (toolName: string, input: Record<string, unknown>, opts: any) => {
      const outcome = await options.canUseTool(toolName, input, { toolUseID: opts?.toolUseID });
      return outcome as any;
    },
    env: buildClaudeEnv(config),
  };

  if (options.abortController) {
    claudeOptions.abortController = options.abortController;
  }

  // Claude SDK 要求显式声明才允许跳过权限检查
  if (options.permissionMode === 'bypassPermissions') {
    claudeOptions.allowDangerouslySkipPermissions = true;
  }

  if (options.disableTools) {
    // tools: [] 把可用工具白名单清空 —— 模型根本看不到工具，不会去尝试调用，
    // 因此也不会把「我去查一下」的叙述写进答复。disallowedTools 再兜一层，
    // 因为 SDK 自己也说了 BUILTIN_TOOL_NAMES 并不完整。
    //
    // DeferredToolPlaceholder 是 CLI 保留的占位工具（用来维持 deferred tool loading
    // 机制），SDK 的内置工具名列表里没有它，但模型偶尔会误调它，
    // 于是界面上冒出一个没有意义的工具卡片，必须单独禁掉。
    //
    // mcp__* 一并禁掉：tools: [] 只清空内置工具，管不到从本机 MCP 配置加载进来的
    // 工具（实测会冒出 mcp__plugin_figma_figma__whoami 这种）。
    //
    // 即便如此也不能完全指望 SDK 选项 —— 实测 CLI 仍会绕过 disallowedTools 直接
    // 调用 DeferredToolPlaceholder，所以服务端还要再过滤一层事件。
    claudeOptions.tools = [];
    claudeOptions.disallowedTools = [...BUILTIN_TOOL_NAMES, 'DeferredToolPlaceholder', 'mcp__*'];
  }

  if (options.resume) {
    claudeOptions.resume = options.resume;
  }

  const stream = claudeQuery({ prompt, options: claudeOptions as any });
  yield* normalizeStream(stream as AsyncIterable<any>);
}

async function* runCodebuddyProvider(prompt: string, options: AgentRunOptions): AsyncGenerator<AgentEvent> {
  const codebuddyOptions: Record<string, unknown> = {
    cwd: options.cwd,
    model: options.model,
    maxTurns: options.maxTurns,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode,
    canUseTool: async (toolName: string, input: Record<string, unknown>, opts: any) => {
      const outcome = await options.canUseTool(toolName, input, { toolUseID: opts?.toolUseID });
      return outcome as any;
    },
  };

  if (options.resume) {
    codebuddyOptions.resume = options.resume;
  }

  if (options.abortController) {
    codebuddyOptions.abortController = options.abortController;
  }

  if (options.disableTools) {
    // CodeBuddy SDK 没有 tools 白名单选项，只能靠 disallowedTools + 服务端的
    // canUseTool 一律 deny 双保险
    codebuddyOptions.disallowedTools = [...BUILTIN_TOOL_NAMES];
  }

  const stream = codebuddyQuery({ prompt, options: codebuddyOptions as any });
  yield* normalizeStream(stream as AsyncIterable<any>);
}

/**
 * 统一的 Agent 调用入口
 */
export function runAgent(
  provider: ProviderId,
  prompt: string,
  options: AgentRunOptions
): AsyncGenerator<AgentEvent> {
  return provider === 'codebuddy'
    ? runCodebuddyProvider(prompt, options)
    : runClaudeProvider(prompt, options);
}

// ==================== 登录状态检查 ====================

export interface ProviderAuthStatus {
  provider: ProviderId;
  isLoggedIn: boolean;
  method?: 'env' | 'cli' | 'none';
  envConfigured: boolean;
  cliConfigured: boolean;
  error?: string;
  /** 脱敏后的密钥 */
  apiKey?: string;
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
    model?: string;
  };
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 12) return value.slice(0, 4) + '****';
  return value.slice(0, 8) + '****' + value.slice(-4);
}

export function checkClaudeAuth(): ProviderAuthStatus {
  const config = getClaudeConfig();
  const status: ProviderAuthStatus = {
    provider: 'claude',
    isLoggedIn: false,
    envConfigured: config.configured,
    cliConfigured: false,
    envVars: {},
  };

  if (config.configured) {
    status.isLoggedIn = true;
    status.method = 'env';
    status.apiKey = mask(config.authToken);
    status.envVars = {
      authToken: mask(config.authToken),
      baseUrl: config.baseUrl,
      model: config.model,
    };
  } else {
    status.error = '未配置 ANTHROPIC_AUTH_TOKEN，请在设置页填写 MiniMax API Key';
  }

  return status;
}

/**
 * 只检查 CodeBuddy 的环境变量配置，不触发 CLI 登录探测。
 * CLI 探测会访问 CodeBuddy 认证服务，可能长时间无响应，因此只在真正使用
 * CodeBuddy provider 时才调用。
 */
export function checkCodebuddyEnv(): ProviderAuthStatus {
  const status: ProviderAuthStatus = {
    provider: 'codebuddy',
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };

  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;

  if (apiKey || authToken) {
    status.envConfigured = true;
    status.isLoggedIn = true;
    status.method = 'env';
    if (apiKey) {
      status.envVars!.apiKey = mask(apiKey);
      status.apiKey = status.envVars!.apiKey;
    }
    if (authToken) {
      status.envVars!.authToken = mask(authToken);
    }
    if (internetEnv) {
      status.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      status.envVars!.baseUrl = baseUrl;
    }
  }

  return status;
}

export async function checkCodebuddyAuth(timeoutMs = 5000): Promise<ProviderAuthStatus> {
  const status = checkCodebuddyEnv();

  try {
    let needsLogin = false;
    const result = await Promise.race([
      unstable_v2_authenticate({
        environment: 'external',
        onAuthUrl: async () => {
          needsLogin = true;
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('CodeBuddy 登录状态检查超时')), timeoutMs)
      ),
    ]);

    if (!needsLogin) {
      status.isLoggedIn = true;
      status.cliConfigured = true;
      status.method = status.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    if (status.envConfigured) {
      status.isLoggedIn = true;
      status.method = 'env';
    } else {
      status.error = error?.message || String(error);
      status.method = 'none';
    }
  }

  return status;
}
