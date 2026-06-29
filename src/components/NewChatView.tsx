import { APP_CONFIG } from '../config';
import { Model, Agent, PermissionMode } from '../types';

interface NewChatViewProps {
  agents: Agent[];
  models: Model[];
  selectedModel: string;
  newChatAgentId: string;
  newChatCwd: string;
  newChatPermissionMode: PermissionMode;
  onSelectModel: (modelId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onSetCwd: (cwd: string) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
}

const QUICK_ACTIONS = [
  { icon: '🛒', label: '查询订单', message: '我想查询我的订单' },
  { icon: '💳', label: '申请退款', message: '我想申请退款' },
  { icon: '📦', label: '查物流', message: '我的快递到哪了？' },
  { icon: '🔧', label: '技术支持', message: 'App 遇到了问题，需要技术支持' },
  { icon: '👤', label: '转人工', message: '转人工' },
  { icon: '❓', label: '常见问题', message: '请问有哪些常见问题？' },
];

export function NewChatView({
  onSelectAgent,
  onSetPermissionMode,
}: NewChatViewProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4">
      <div className="w-full max-w-lg">
        {/* Logo 和标题 */}
        <div className="text-center mb-8">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center mb-4 shadow-lg mx-auto"
            style={{
              background: 'linear-gradient(135deg, #0052d9, #366ef4)'
            }}
          >
            <span className="text-4xl">🤖</span>
          </div>
          <h2
            className="text-2xl font-semibold mb-2"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {APP_CONFIG.agentName}
          </h2>
          <p style={{ color: 'var(--td-text-color-secondary)', fontSize: '15px' }}>
            {APP_CONFIG.description}
          </p>
        </div>

        {/* 快捷操作 */}
        <div className="mb-6">
          <p
            className="text-sm font-medium mb-3 text-center"
            style={{ color: 'var(--td-text-color-secondary)' }}
          >
            快捷提问
          </p>
          <div className="grid grid-cols-3 gap-3">
            {QUICK_ACTIONS.map((action, idx) => (
              <div
                key={idx}
                className="p-3 rounded-xl cursor-pointer transition-all duration-200 text-center border border-transparent hover:shadow-sm"
                style={{
                  backgroundColor: 'var(--td-bg-color-container)',
                  borderColor: 'var(--td-border-level-1-color)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--td-brand-color)';
                  e.currentTarget.style.backgroundColor = 'var(--td-brand-color-light)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--td-border-level-1-color)';
                  e.currentTarget.style.backgroundColor = 'var(--td-bg-color-container)';
                }}
                onClick={() => {
                  // 通过触发自定义事件来发送消息
                  window.dispatchEvent(new CustomEvent('quick-send', { detail: action.message }));
                }}
              >
                <div className="text-2xl mb-1.5">{action.icon}</div>
                <div className="text-xs font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                  {action.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 服务说明 */}
        <div
          className="p-4 rounded-xl text-center"
          style={{ backgroundColor: 'var(--td-bg-color-container)' }}
        >
          <p className="text-xs mb-2" style={{ color: 'var(--td-text-color-secondary)' }}>
            ⏰ 在线客服工作时间：9:00 - 21:00（周一至周日）
          </p>
          <p className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            复杂问题可输入「转人工」获取人工客服帮助
          </p>
        </div>
      </div>
    </div>
  );
}
