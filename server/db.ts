import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库文件路径
const dbPath = path.join(__dirname, '..', 'data', 'chat.db');

// 确保 data 目录存在
import fs from 'fs';
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 创建数据库连接
// 显式标注类型，避免 composite 项目的声明生成报 TS4023
export const db: Database.Database = new Database(dbPath);

// 启用 WAL 模式以提高性能
db.pragma('journal_mode = WAL');

// 初始化数据库表
db.exec(`
  -- 会话表
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    sdk_session_id TEXT,
    provider TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 消息表
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    tool_calls TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- 为会话 ID 创建索引
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

  -- FAQ 知识库表
  CREATE TABLE IF NOT EXISTS faq (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '通用',
    keywords TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 满意度评价表
  CREATE TABLE IF NOT EXISTS ratings (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
    comment TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- 意图识别日志表
  CREATE TABLE IF NOT EXISTS intent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_id TEXT,
    intent TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.0,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`);

// 数据库迁移
try {
  const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasColumn = tableInfo.some(col => col.name === 'sdk_session_id');
  if (!hasColumn) {
    db.exec("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT");
    console.log("[DB] Added sdk_session_id column to sessions table");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// provider 列：历史会话都来自 CodeBuddy
try {
  const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasProvider = tableInfo.some(col => col.name === 'provider');
  if (!hasProvider) {
    db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT");
    console.log("[DB] Added provider column to sessions table");
  }
  db.exec("UPDATE sessions SET provider = 'codebuddy' WHERE provider IS NULL");
} catch (e) {
  // 忽略错误（列可能已存在）
}

// ============= 类型定义 =============

export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  provider: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  created_at: string;
  tool_calls: string | null;
}

export interface DbFaq {
  id: number;
  question: string;
  answer: string;
  category: string;
  keywords: string | null;
  created_at: string;
}

export interface DbRating {
  id: string;
  session_id: string;
  score: number;
  comment: string | null;
  created_at: string;
}

export interface DbIntentLog {
  id: number;
  session_id: string;
  message_id: string | null;
  intent: string;
  confidence: number;
  details: string | null;
  created_at: string;
}

// ============= 会话操作 =============

export function getAllSessions(): DbSession[] {
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
  return stmt.all() as DbSession[];
}

export function getSession(id: string): DbSession | undefined {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(id) as DbSession | undefined;
}

export function createSession(session: DbSession): DbSession {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, title, model, sdk_session_id, provider, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(session.id, session.title, session.model, session.sdk_session_id, session.provider, session.created_at, session.updated_at);
  return session;
}

export function updateSession(id: string, updates: Partial<Pick<DbSession, 'title' | 'model' | 'sdk_session_id' | 'provider'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.sdk_session_id !== undefined) {
    fields.push('sdk_session_id = ?');
    values.push(updates.sdk_session_id);
  }
  if (updates.provider !== undefined) {
    fields.push('provider = ?');
    values.push(updates.provider);
  }

  if (fields.length === 0) return false;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  const stmt = db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

export function deleteSession(id: string): boolean {
  const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============= 消息操作 =============

export function getMessagesBySession(sessionId: string): DbMessage[] {
  const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
  return stmt.all(sessionId) as DbMessage[];
}

export function createMessage(message: DbMessage): DbMessage {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    message.id,
    message.session_id,
    message.role,
    message.content,
    message.model,
    message.created_at,
    message.tool_calls
  );

  const updateStmt = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
  updateStmt.run(new Date().toISOString(), message.session_id);

  return message;
}

export function updateMessage(id: string, updates: Partial<Pick<DbMessage, 'content' | 'tool_calls'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }
  if (updates.tool_calls !== undefined) {
    fields.push('tool_calls = ?');
    values.push(updates.tool_calls);
  }

  if (fields.length === 0) return false;

  values.push(id);

  const stmt = db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

export function deleteMessage(id: string): boolean {
  const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function createMessages(messages: DbMessage[]): void {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((msgs: DbMessage[]) => {
    for (const msg of msgs) {
      stmt.run(msg.id, msg.session_id, msg.role, msg.content, msg.model, msg.created_at, msg.tool_calls);
    }
  });

  insertMany(messages);
}

// ============= FAQ 知识库操作 =============

export function getAllFaqs(): DbFaq[] {
  const stmt = db.prepare('SELECT * FROM faq ORDER BY category, id');
  return stmt.all() as DbFaq[];
}

export function searchFaq(query: string): DbFaq[] {
  const searchTerm = `%${query}%`;
  const stmt = db.prepare(`
    SELECT * FROM faq 
    WHERE question LIKE ? 
       OR answer LIKE ? 
       OR keywords LIKE ? 
       OR category LIKE ?
    ORDER BY 
      CASE 
        WHEN question LIKE ? THEN 1
        WHEN keywords LIKE ? THEN 2
        WHEN answer LIKE ? THEN 3
        ELSE 4
      END
    LIMIT 10
  `);
  return stmt.all(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm) as DbFaq[];
}

export function searchFaqByCategory(category: string, query: string): DbFaq[] {
  const searchTerm = `%${query}%`;
  const stmt = db.prepare(`
    SELECT * FROM faq 
    WHERE category = ?
      AND (question LIKE ? OR answer LIKE ? OR keywords LIKE ?)
    ORDER BY 
      CASE 
        WHEN question LIKE ? THEN 1
        WHEN keywords LIKE ? THEN 2
        ELSE 3
      END
    LIMIT 10
  `);
  return stmt.all(category, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm) as DbFaq[];
}

export function addFaq(faq: Omit<DbFaq, 'id' | 'created_at'>): DbFaq {
  const stmt = db.prepare(`
    INSERT INTO faq (question, answer, category, keywords)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(faq.question, faq.answer, faq.category, faq.keywords || null);
  return { ...faq, id: result.lastInsertRowid as number, created_at: new Date().toISOString() } as DbFaq;
}

export function getFaqCount(): number {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM faq');
  const row = stmt.get() as { count: number };
  return row.count;
}

// ============= 满意度评价操作 =============

export function createRating(rating: DbRating): DbRating {
  const stmt = db.prepare(`
    INSERT INTO ratings (id, session_id, score, comment, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(rating.id, rating.session_id, rating.score, rating.comment, rating.created_at);
  return rating;
}

export function getRatingBySession(sessionId: string): DbRating | undefined {
  const stmt = db.prepare('SELECT * FROM ratings WHERE session_id = ?');
  return stmt.get(sessionId) as DbRating | undefined;
}

export function getRatingStats(): { total: number; avgScore: number; distribution: Record<number, number> } {
  const countStmt = db.prepare('SELECT COUNT(*) as count, AVG(score) as avg FROM ratings');
  const countRow = countStmt.get() as { count: number; avg: number | null };

  const distStmt = db.prepare('SELECT score, COUNT(*) as count FROM ratings GROUP BY score ORDER BY score');
  const distRows = distStmt.all() as Array<{ score: number; count: number }>;

  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of distRows) {
    distribution[row.score] = row.count;
  }

  return {
    total: countRow.count,
    avgScore: countRow.avg ? Math.round(countRow.avg * 100) / 100 : 0,
    distribution
  };
}

// ============= 意图日志操作 =============

export function logIntent(log: Omit<DbIntentLog, 'id' | 'created_at'>): DbIntentLog {
  const stmt = db.prepare(`
    INSERT INTO intent_logs (session_id, message_id, intent, confidence, details)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(log.session_id, log.message_id, log.intent, log.confidence, log.details || null);
  return { ...log, id: result.lastInsertRowid as number, created_at: new Date().toISOString() } as DbIntentLog;
}

export function getIntentStats(): Array<{ intent: string; count: number }> {
  const stmt = db.prepare('SELECT intent, COUNT(*) as count FROM intent_logs GROUP BY intent ORDER BY count DESC');
  return stmt.all() as Array<{ intent: string; count: number }>;
}

// ============= 管理后台操作 =============

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

export function getAdminConversations(limit: number = 50, offset: number = 0): {
  conversations: AdminConversation[];
  total: number;
} {
  const totalStmt = db.prepare('SELECT COUNT(*) as count FROM sessions');
  const totalRow = totalStmt.get() as { count: number };

  const stmt = db.prepare(`
    SELECT 
      s.id as session_id,
      s.title,
      s.model,
      COUNT(m.id) as message_count,
      r.score as rating_score,
      r.comment as rating_comment,
      s.created_at,
      s.updated_at
    FROM sessions s
    LEFT JOIN messages m ON s.id = m.session_id
    LEFT JOIN ratings r ON s.id = r.session_id
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?
  `);
  const rows = stmt.all(limit, offset) as AdminConversation[];

  return { conversations: rows, total: totalRow.count };
}

export function getDashboardStats(): {
  totalConversations: number;
  totalMessages: number;
  todayConversations: number;
  ratingStats: { total: number; avgScore: number; distribution: Record<number, number> };
  intentStats: Array<{ intent: string; count: number }>;
  avgMessagesPerSession: number;
} {
  const convStmt = db.prepare('SELECT COUNT(*) as count FROM sessions');
  const convRow = convStmt.get() as { count: number };

  const msgStmt = db.prepare('SELECT COUNT(*) as count FROM messages');
  const msgRow = msgStmt.get() as { count: number };

  const today = new Date().toISOString().slice(0, 10);
  const todayStmt = db.prepare("SELECT COUNT(*) as count FROM sessions WHERE created_at >= ?");
  const todayRow = todayStmt.get(today) as { count: number };

  const ratingStats = getRatingStats();
  const intentStats = getIntentStats();

  return {
    totalConversations: convRow.count,
    totalMessages: msgRow.count,
    todayConversations: todayRow.count,
    ratingStats,
    intentStats,
    avgMessagesPerSession: convRow.count > 0 ? Math.round((msgRow.count / convRow.count) * 10) / 10 : 0
  };
}

// ============= 数据维护 =============

export function clearAllData(): void {
  db.exec('DELETE FROM ratings');
  db.exec('DELETE FROM intent_logs');
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
}

// ============= 预设 FAQ 数据初始化 =============

const DEFAULT_FAQS = [
  // 退款类
  { question: '如何申请退款？', answer: '您可以在订单详情页点击「申请退款」按钮，填写退款原因后提交。我们会在1-3个工作日内审核处理。如超过7天未收到退款，请联系人工客服。', category: '退款', keywords: '退款,申请退款,退货退款,怎么退款' },
  { question: '退款需要多长时间到账？', answer: '审核通过后，退款一般会在1-5个工作日内原路返还至您的支付账户。信用卡退款可能需要5-15个工作日，具体取决于发卡行处理速度。', category: '退款', keywords: '退款时间,到账,多久退款,退款周期' },
  { question: '退款被拒怎么办？', answer: '如果退款申请被拒，请核实是否满足退款条件：1）商品需在7天无理由退货期内；2）商品未经使用且包装完好；3）虚拟商品/定制商品不支持退款。如仍有疑问可联系人工客服申诉。', category: '退款', keywords: '退款被拒,退款失败,申诉,拒绝退款' },
  { question: '申请退款后如何查看进度？', answer: '在「我的订单」-「退款/售后」页面可查看退款处理进度。状态包括：待审核、审核中、已通过（退款中）、已到账、已拒绝。每个状态变更都会推送通知。', category: '退款', keywords: '退款进度,查看退款,退款状态,退款查询' },

  // 订单查询类
  { question: '如何查询我的订单？', answer: '登录后进入「我的订单」页面即可查看所有订单。支持按订单状态、时间范围筛选。如订单未显示，请确认登录账号是否正确。', category: '订单查询', keywords: '订单,查询订单,我的订单,查看订单' },
  { question: '订单发货后如何查物流？', answer: '在订单详情页点击「查看物流」可实时追踪包裹位置。一般发货后24小时内物流信息会更新。如超过48小时未更新，可能是快递公司系统延迟，请联系我们核实。', category: '订单查询', keywords: '物流,快递,发货,查询物流,运单号,快递跟踪,包裹,寄到哪,东西到哪,查物流,物流查询' },
  { question: '订单显示已签收但我没收到货？', answer: '请您先核实：1）是否家人/同事/物业代签；2）快递是否放在了快递柜或驿站。如确认未收到，请在订单详情页点击「未收到货」反馈，我们会在2小时内联系快递公司核实。', category: '订单查询', keywords: '签收,没收到,丢件,未收到货' },
  { question: '如何修改或取消订单？', answer: '未发货的订单可在订单详情页直接取消。已发货订单不支持取消，可在收货后申请退货退款。修改收货地址请在订单详情页操作，已发货订单无法修改地址。', category: '订单查询', keywords: '取消订单,修改订单,改地址,撤销订单,不要了,不想要了' },

  // 技术支持类
  { question: 'App 闪退怎么办？', answer: '请按以下步骤排查：1）更新 App 至最新版本；2）重启手机；3）清理 App 缓存（设置-通用-存储-清理缓存）；4）如仍未解决，请卸载重装。注意提前备份重要数据。', category: '技术支持', keywords: '闪退,崩溃,卡顿,打不开,闪退怎么办' },
  { question: '无法登录账号怎么办？', answer: '请检查：1）网络连接是否正常；2）账号密码是否正确（尝试找回密码）；3）是否使用了第三方登录（微信/QQ）且授权过期。如仍无法登录，请提供截图联系人工客服。', category: '技术支持', keywords: '登录,无法登录,密码,账号,登录不上,登不上' },
  { question: '支付失败怎么办？', answer: '常见原因：1）银行卡/账户余额不足；2）银行卡未开通网上支付功能；3）支付限额超限；4）网络不稳定。建议更换支付方式或等待10分钟后重试。如持续失败请联系人工客服。', category: '技术支持', keywords: '支付失败,付款失败,支付不了,无法支付,扣款' },
  { question: '如何修改账号密码/手机号？', answer: '修改密码：进入「设置」-「账号安全」-「修改密码」，输入原密码后设置新密码。修改手机号：进入「设置」-「账号安全」-「修改手机号」，需验证原手机号和身份信息。', category: '技术支持', keywords: '修改密码,改密码,改手机号,修改手机,账号安全' },

  // 通用类
  { question: '如何联系人工客服？', answer: '您可以拨打客服热线 400-XXX-XXXX（工作时间 9:00-21:00），或在本对话中输入「转人工」，我们将为您转接在线人工客服。投诉建议请发送邮件至 feedback@example.com。', category: '通用', keywords: '人工客服,客服电话,联系客服,转人工,投诉,建议' },
  { question: '工作时间是什么时候？', answer: '在线客服工作时间：周一至周日 9:00-21:00。电话客服工作时间：周一至周五 9:00-18:00。非工作时间提交的问题将在次日优先处理。', category: '通用', keywords: '工作时间,营业时间,客服时间' },
  { question: '你们的退货地址是什么？', answer: '退货地址：XX省XX市XX区XX路XX号 售后服务中心（收），邮编：XXXXXX。退货前请先在线提交退货申请获得退货单号，未申请直接寄回可能影响退款处理。', category: '退款', keywords: '退货地址,寄回地址,邮寄地址,退到哪里' },
  { question: '忘记密码如何找回？', answer: '在登录页面点击「忘记密码」，可通过绑定的手机号或邮箱接收验证码重置密码。如手机号和邮箱均已停用，请联系人工客服进行身份验证后重置。', category: '技术支持', keywords: '忘记密码,找回密码,重置密码,密码找回' },
];

function initFaqData(): void {
  const count = getFaqCount();
  if (count === 0) {
    console.log('[DB] 初始化预设 FAQ 数据...');
    const insertStmt = db.prepare(`
      INSERT INTO faq (question, answer, category, keywords, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    const insertAll = db.transaction((faqs: typeof DEFAULT_FAQS) => {
      for (const faq of faqs) {
        insertStmt.run(faq.question, faq.answer, faq.category, faq.keywords);
      }
    });
    insertAll(DEFAULT_FAQS);
    console.log(`[DB] 已初始化 ${DEFAULT_FAQS.length} 条 FAQ 数据`);
  }
}

// 初始化 FAQ 数据
initFaqData();

export default db;
