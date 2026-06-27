import type { Readable } from 'node:stream';

function nextLineBreak(buffer: string): { index: number; length: number } | undefined {
  const rn = buffer.indexOf('\r\n');
  const n = buffer.indexOf('\n');
  const r = buffer.indexOf('\r');

  const candidates: { index: number; length: number }[] = [];
  if (rn >= 0) candidates.push({ index: rn, length: 2 });
  if (n >= 0) candidates.push({ index: n, length: 1 });
  if (r >= 0) candidates.push({ index: r, length: 1 });
  if (candidates.length === 0) return undefined;

  return candidates.reduce((best, cur) => (cur.index < best.index ? cur : best));
}

/**
 * 从 agent 子进程 stdout 按行读取。兼容 `\n`、`\r\n`、仅 `\r` 换行。
 * Windows 下 pipe 模式常见仅 `\r`，readline 会漏读整段 JSON 输出。
 */
export async function* readStdoutLines(stream: Readable): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (;;) {
      const br = nextLineBreak(buffer);
      if (!br) break;
      const line = buffer.slice(0, br.index);
      buffer = buffer.slice(br.index + br.length);
      if (line.trim()) yield line;
    }
  }
  const rest = buffer.trim();
  if (rest) yield rest;
}
