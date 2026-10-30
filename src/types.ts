/**
 * 类型定义 - AI Customer Assistance
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** Agent Provider：Claude Code（MiniMax） */
export type ProviderId = 'claude';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  defaultModel: string;
  isActive: boolean;
}

/** 用户意图类型 */
export type CustomerIntent = '退款' | '订单查询' | '技术支持' | '转人工' | '通用';

export interface Model {
  modelId: string;
  name: string;
  description?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
}

/**
 * 内容块类型 - 支持文字、工具调用、错误按顺序排列
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  /** 服务端返回的错误（或客户端捕获的异常），单独成块以便醒目展示 */
  | { type: 'error'; text: string };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  timestamp: Date;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  contentBlocks?: ContentBlock[];
}

export interface Session {
  id: string;
  title: string;
  model: string;
  agentId?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  createdAt: Date;
  messages: Message[];
}

export interface CustomAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  icon?: string;
  color?: string;
  permissionMode?: PermissionMode;
  createdAt: Date;
  updatedAt: Date;
}

export type Agent = CustomAgent;

export type Theme = 'light' | 'dark';

/**
 * 权限请求
 */
export interface PermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

export interface PermissionResponse {
  requestId: string;
  behavior: 'allow' | 'deny';
  message?: string;
}

// ============ AI 客服新增类型 ============

/** FAQ 条目 */
export interface FaqItem {
  id: number;
  question: string;
  answer: string;
  category: string;
  keywords: string | null;
  created_at: string;
}

/** 满意度评价 */
export interface Rating {
  id: string;
  session_id: string;
  score: number;
  comment: string | null;
  created_at: string;
}

/** 意图识别结果 */
export interface IntentResult {
  intent: CustomerIntent;
  confidence: number;
}

/** 管理后台 - 对话记录 */
export interface AdminConversation {
  session_id: string;
  title: string;
  model: string;
  message_count: number;
  rating_score: number | null;
  rating_comment: string | null;
  created_at: string;
  updated_at: string;
}

/** 管理后台 - 统计数据 */
export interface AdminDashboardStats {
  totalConversations: number;
  totalMessages: number;
  todayConversations: number;
  ratingStats: {
    total: number;
    avgScore: number;
    distribution: Record<number, number>;
  };
  intentStats: Array<{ intent: string; count: number }>;
  avgMessagesPerSession: number;
}
