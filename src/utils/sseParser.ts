/**
 * SSE（Server-Sent Events）增量解析器
 *
 * 服务端每条事件的格式是 `data: <json>\n\n`。浏览器 fetch 的 reader 给出的 chunk
 * 边界与事件边界无关：一条事件可能被切成多块，一个 chunk 里也可能有多条事件。
 * 直接对 chunk 做 split('\n') 会丢掉被切断的事件，还会在多字节 UTF-8（中文）
 * 字符被切开时产生乱码 U+FFFD。
 *
 * 这里按 SSE 规范以空行（\n\n）作为事件分隔符，并使用流式 TextDecoder，
 * 保证跨 chunk 的事件和跨 chunk 的中文都能被完整还原。
 */

export interface SseParser {
  /** 喂入一段原始字节 */
  push: (chunk: Uint8Array) => void;
  /** 流结束时调用，吐出尾部残留事件并释放不完整的字节序列 */
  flush: () => void;
}

/** 从一段 SSE 原始文本里取出 data 字段 */
function extractData(rawEvent: string): string {
  const lines = rawEvent.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // 冒号后可以有一个空格，按规范去掉一个即可
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return dataLines.join('\n');
}

export function createSseParser(onEvent: (data: string) => void): SseParser {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const drain = (flushRemainder: boolean) => {
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = extractData(rawEvent);
      if (data) onEvent(data);
      boundary = buffer.indexOf('\n\n');
    }

    if (flushRemainder) {
      // 释放解码器里不完整的多字节序列
      buffer += decoder.decode();
      const rawEvent = buffer.trim();
      buffer = '';
      if (rawEvent) {
        const data = extractData(rawEvent);
        if (data) onEvent(data);
      }
    }
  };

  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(false);
    },
    flush() {
      drain(true);
    },
  };
}
