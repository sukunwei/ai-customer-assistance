import { ContentBlock } from '../types';

/**
 * 构造错误内容块。
 *
 * SDK 出错时会把错误原文当作助手文本吐出来（例如 "API Error: 400 ..."），
 * 服务端随后又推一条 error 事件，两者描述的是同一次失败。
 * 如果最后一块文本恰好被错误消息包含，说明它是这条错误的重复表述，
 * 用错误块替换掉，避免同一条错误在界面上显示两遍。
 */
export function buildErrorBlocks(blocks: ContentBlock[], errorMessage: string): ContentBlock[] {
  const message = errorMessage || '未知错误';
  const next = [...blocks];

  const last = next[next.length - 1];
  if (last && last.type === 'text' && last.text.trim() && message.includes(last.text.trim())) {
    next.pop();
  }

  next.push({ type: 'error', text: message });
  return next;
}
