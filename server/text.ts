/**
 * 文本归一化工具
 *
 * 繁体中文用户输入无法命中简体的意图关键词和 FAQ 库，
 * 所有进入检索和匹配之前的文本都要先转成简体。
 */
import OpenCC from 'opencc-js';

const toCnConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });

/**
 * 繁体转简体。
 *
 * 用的是台湾正体 → 大陆简体 的转换，除了字形还会顺带把台湾用词换成大陆用词
 * （例如「記憶體」→「内存」）。已经是简体的文本不会被改动。
 */
export function toSimplified(text: string): string {
  if (!text) return '';
  try {
    return toCnConverter(text);
  } catch {
    // 转换异常时退回原文，不能因为归一化失败而让整个请求挂掉
    return text;
  }
}
