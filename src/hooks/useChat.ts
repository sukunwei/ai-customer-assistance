import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Message, ToolCall, PermissionRequest, PermissionMode, ProviderId, Session, CustomAgent, ContentBlock } from '../types';
import { createSseParser } from '../utils/sseParser';
import { buildErrorBlocks } from '../utils/chatContent';

const STORAGE_KEYS = {
  draftInput: 'draftInput',
};

interface UseChatOptions {
  currentSession: Session | undefined;
  currentSessionId: string | null;
  selectedModel: string;
  provider: ProviderId;
  getAgent: (id: string) => CustomAgent | undefined;
  addSession: (session: Session) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  updateSessionMessages: (sessionId: string, updater: (messages: Message[]) => Message[]) => void;
  updateSessionModel: (sessionId: string, modelId: string) => void;
  setCurrentSessionId: (id: string | null) => void;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}

interface NewChatOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
}

export function useChat(options: UseChatOptions) {
  const {
    currentSession,
    currentSessionId,
    selectedModel,
    provider,
    getAgent,
    updateSessionModel,
    setCurrentSessionId,
    setSessions,
  } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [inputValue, setInputValue] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.draftInput) || '';
  });
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);

  // 保存输入框内容到 localStorage（防抖）
  const saveInput = useCallback((value: string) => {
    setInputValue(value);
  }, []);

  // 发送消息
  const sendMessage = useCallback(async (
    messageContent: string,
    newChatOptions?: NewChatOptions,
    onNavigate?: (path: string) => void
  ) => {
    if (!messageContent.trim() || isLoading) return;

    let sessionId = currentSessionId;
    let currentCwd = currentSession?.cwd;
    let currentAgentId = currentSession?.agentId || 'default';
    let currentPermissionMode = currentSession?.permissionMode || 'default';
    
    // 如果没有当前会话，使用新对话页面的选项创建新会话
    if (!sessionId && newChatOptions) {
      const selectedAgent = getAgent(newChatOptions.agentId);
      const agentPermissionMode = selectedAgent?.permissionMode || 'default';
      const finalPermissionMode = newChatOptions.permissionMode !== 'default' 
        ? newChatOptions.permissionMode 
        : agentPermissionMode;
      
      const newSession: Session = {
        id: uuidv4(),
        title: messageContent.slice(0, 30) + (messageContent.length > 30 ? '...' : ''),
        model: selectedModel,
        agentId: newChatOptions.agentId,
        cwd: newChatOptions.cwd || undefined,
        permissionMode: finalPermissionMode,
        createdAt: new Date(),
        messages: []
      };
      
      setSessions(prev => [newSession, ...prev]);
      setCurrentSessionId(newSession.id);
      sessionId = newSession.id;
      currentCwd = newSession.cwd;
      currentAgentId = newSession.agentId || 'default';
      currentPermissionMode = newSession.permissionMode || 'default';
      
      updateSessionModel(newSession.id, selectedModel);
      
      onNavigate?.(`/chat/${newSession.id}`);
    }

    const tempUserMessageId = uuidv4();
    const tempAssistantMessageId = uuidv4();

    const userMessage: Message = {
      id: tempUserMessageId,
      role: 'user',
      content: messageContent,
      timestamp: new Date()
    };

    const assistantMessage: Message = {
      id: tempAssistantMessageId,
      role: 'assistant',
      content: '',
      model: selectedModel,
      timestamp: new Date(),
      isStreaming: true,
      contentBlocks: []
    };

    setSessions(prev => prev.map(s => {
      if (s.id === sessionId) {
        const newTitle = s.messages.length === 0 
          ? messageContent.slice(0, 30) + (messageContent.length > 30 ? '...' : '')
          : s.title;
        return {
          ...s,
          title: newTitle,
          messages: [...s.messages, userMessage, assistantMessage]
        };
      }
      return s;
    }));

    setInputValue('');
    localStorage.removeItem(STORAGE_KEYS.draftInput);
    setIsLoading(true);

    const agent = getAgent(currentAgentId);
    const systemPrompt = agent?.systemPrompt;

    // init 事件到达后会被替换成服务端的真实 id；catch 分支同样要用，所以声明在 try 之外
    let realSessionId = sessionId!;
    let realAssistantMessageId = tempAssistantMessageId;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: messageContent,
          model: selectedModel,
          provider,
          systemPrompt,
          // 服务端靠 agentId 区分「客服模式」和「自定义 Agent」，
          // 不能靠 systemPrompt 是否为空 —— 内置 default agent 也有自己的提示词
          agentId: currentAgentId,
          cwd: currentCwd,
          permissionMode: currentPermissionMode,
        })
      });

      if (!response.ok) {
        throw new Error(`服务返回错误 ${response.status} ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      let fullContent = '';
      let usedModel = selectedModel;
      let currentToolCalls: ToolCall[] = [];
      let contentBlocks: ContentBlock[] = [];
      let currentTextBlock: string = '';  // 当前正在积累的文本块

      /** 按真实 id 更新当前助手消息 */
      const patchAssistantMessage = (patch: Partial<Message>) => {
        setSessions(prev => prev.map(s => {
          if (s.id !== realSessionId) return s;
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === realAssistantMessageId ? { ...m, ...patch } : m
            )
          };
        }));
      };

      /** 追加一个错误块，并结束流式状态 */
      const appendErrorBlock = (text: string) => {
        contentBlocks = buildErrorBlocks(contentBlocks, text);
        patchAssistantMessage({ contentBlocks, isStreaming: false });
      };

      if (reader) {
        // SSE 事件可能被网络切成任意 chunk，必须按事件边界（空行）组装；
        // 直接对 chunk 做 split('\n') 会丢掉被切断的事件，中文还会乱码。
        const parser = createSseParser(raw => {
          let data: any;
          try {
            data = JSON.parse(raw);
          } catch {
            return;  // 忽略非法 JSON
          }

          if (data.type === 'init') {
            realSessionId = data.sessionId;
            realAssistantMessageId = data.assistantMessageId;
            usedModel = data.model;

            if (realSessionId !== sessionId) {
              setSessions(prev => prev.map(s =>
                s.id === sessionId ? { ...s, id: realSessionId } : s
              ));
              setCurrentSessionId(realSessionId);
              sessionId = realSessionId;
            }

            setSessions(prev => prev.map(s => {
              if (s.id === realSessionId) {
                return {
                  ...s,
                  messages: s.messages.map(m =>
                    m.id === tempAssistantMessageId
                      ? { ...m, id: realAssistantMessageId }
                      : m
                  )
                };
              }
              return s;
            }));
          } else if (data.type === 'text') {
            fullContent += data.content;
            currentTextBlock += data.content;

            // 更新或创建最后一个文本块
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              lastBlock.text = currentTextBlock;
            } else if (currentTextBlock) {
              contentBlocks.push({ type: 'text', text: currentTextBlock });
            }

            patchAssistantMessage({
              content: fullContent,
              model: usedModel,
              toolCalls: [...currentToolCalls],
              contentBlocks: [...contentBlocks],
            });
          } else if (data.type === 'tool') {
            // 如果有累积的文本，先结束当前文本块
            currentTextBlock = '';

            const toolCall: ToolCall = {
              id: data.id || uuidv4(),
              name: data.name,
              input: data.input,
              status: 'running'
            };
            currentToolCalls.push(toolCall);

            // 添加工具调用块
            contentBlocks.push({ type: 'tool_use', toolCall });

            patchAssistantMessage({
              toolCalls: [...currentToolCalls],
              contentBlocks: [...contentBlocks],
            });
          } else if (data.type === 'tool_result') {
            const toolId = data.toolId;
            const toolIndex = toolId
              ? currentToolCalls.findIndex(t => t.id === toolId)
              : currentToolCalls.length - 1;

            if (toolIndex >= 0) {
              currentToolCalls[toolIndex].status = data.isError ? 'error' : 'completed';
              currentToolCalls[toolIndex].isError = data.isError || false;
              currentToolCalls[toolIndex].result = typeof data.content === 'string'
                ? data.content
                : JSON.stringify(data.content);

              // 同步更新 contentBlocks 中对应的工具调用
              const blockIndex = contentBlocks.findIndex(
                b => b.type === 'tool_use' && b.toolCall.id === currentToolCalls[toolIndex].id
              );
              if (blockIndex >= 0) {
                (contentBlocks[blockIndex] as { type: 'tool_use'; toolCall: ToolCall }).toolCall = { ...currentToolCalls[toolIndex] };
              }

              patchAssistantMessage({
                toolCalls: [...currentToolCalls],
                contentBlocks: [...contentBlocks],
              });
            }
          } else if (data.type === 'done') {
            patchAssistantMessage({ isStreaming: false });
          } else if (data.type === 'error') {
            // 服务端错误：显示出来并结束流式状态，否则界面会一直空转
            console.error('[Chat] Server error:', data.message);
            appendErrorBlock(data.message || '未知错误');
          } else if (data.type === 'permission_request') {
            console.log('[Permission] Request received:', data);
            setPermissionRequest({
              requestId: data.requestId,
              toolUseId: data.toolUseId,
              toolName: data.toolName,
              input: data.input,
              sessionId: data.sessionId,
              timestamp: data.timestamp
            });
          }
        });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) parser.push(value);
        }
        parser.flush();
      }

      // 兜底收尾：服务端异常退出时不会发 done 事件，isStreaming 必须在这里结束
      patchAssistantMessage({ isStreaming: false });
    } catch (error) {
      console.error('Chat error:', error);
      const errorText = (error as Error)?.message || String(error) || '发生错误，请重试';
      setSessions(prev => prev.map(s => {
        if (s.id !== realSessionId) return s;
        return {
          ...s,
          messages: s.messages.map(m =>
            m.id === realAssistantMessageId
              ? {
                  ...m,
                  content: errorText,
                  contentBlocks: [...(m.contentBlocks || []), { type: 'error', text: errorText }],
                  isStreaming: false
                }
              : m
          )
        };
      }));
    } finally {
      setIsLoading(false);
    }
  }, [currentSession, currentSessionId, selectedModel, provider, getAgent, updateSessionModel, setCurrentSessionId, setSessions, isLoading]);

  // 处理停止事件
  const handleStop = useCallback(() => {
    console.log('ChatSender stop event');
    setIsLoading(false);
  }, []);

  // 处理权限允许
  const handlePermissionAllow = useCallback(async () => {
    if (!permissionRequest) return;
    
    console.log('[Permission] User allowed:', permissionRequest.requestId);
    
    await fetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: permissionRequest.requestId,
        behavior: 'allow'
      })
    });
    
    setPermissionRequest(null);
  }, [permissionRequest]);

  // 处理权限拒绝
  const handlePermissionDeny = useCallback(async () => {
    if (!permissionRequest) return;
    
    console.log('[Permission] User denied:', permissionRequest.requestId);
    
    await fetch('/api/permission-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: permissionRequest.requestId,
        behavior: 'deny',
        message: '用户拒绝了此操作'
      })
    });
    
    setPermissionRequest(null);
  }, [permissionRequest]);

  return {
    isLoading,
    inputValue,
    setInputValue: saveInput,
    permissionRequest,
    sendMessage,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  };
}
