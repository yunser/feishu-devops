import type { Readable } from 'node:stream';
import { log } from '../core/logger';

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

/**
 * Tally of what came out of an agent subprocess stdout — used to diagnose the
 * "agent replied with no content" symptom. The adapters used to silently drop
 * any line that failed JSON.parse, so when (e.g. on a Windows service) the agent
 * printed an error string instead of JSON, the run ended as a content-less
 * `done` with zero log evidence. These counts surface that case.
 */
export interface StdoutJsonStats {
  rawLines: number;
  parsedOk: number;
  parseFailed: number;
  /** First chars of up to N lines that failed JSON.parse — the smoking gun. */
  failedSamples: string[];
}

export function createStdoutJsonStats(): StdoutJsonStats {
  return { rawLines: 0, parsedOk: 0, parseFailed: 0, failedSamples: [] };
}

const NON_JSON_WARN_CAP = 5;

/**
 * Read agent stdout as one parsed JSON object per line.
 *
 * Wraps `readStdoutLines` + JSON.parse so every adapter gets identical,
 * instrumented behavior:
 *   - counts raw / parsed / failed lines into `stats` (caller logs the summary)
 *   - warns on every non-JSON line (capped) — these used to be swallowed,
 *     hiding agent error output that explains an empty reply
 *   - under `debug`, prints each raw line head to the daemon stdout log
 */
export async function* readStdoutJsonLines(
  stream: Readable,
  opts: { agent: string; debug?: boolean; stats: StdoutJsonStats },
): AsyncGenerator<unknown> {
  for await (const line of readStdoutLines(stream)) {
    opts.stats.rawLines++;
    if (opts.debug) {
      console.log(`[${opts.agent} debug] stdout-line`, {
        len: line.length,
        head: line.slice(0, 200),
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      opts.stats.parseFailed++;
      if (opts.stats.failedSamples.length < 3) {
        opts.stats.failedSamples.push(line.slice(0, 300));
      }
      if (opts.stats.parseFailed <= NON_JSON_WARN_CAP) {
        log.warn('agent', 'stdout-non-json', {
          agent: opts.agent,
          len: line.length,
          head: line.slice(0, 300),
        });
      }
      continue;
    }
    opts.stats.parsedOk++;
    yield parsed;
  }
}

/**
 * Presence-only snapshot of the env a spawned agent will inherit. Values are
 * deliberately reduced to booleans / counts — the logger redacts raw env, and
 * we only need to know whether the service environment provides the home/profile
 * dirs and credentials the agent needs (the common Windows-service failure mode).
 */
export function summarizeAgentEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const has = (key: string): boolean => Boolean(env[key] && String(env[key]).trim());
  const credentialKeys = Object.keys(env).filter((key) => /key|token|secret|auth/i.test(key));
  return {
    platform: process.platform,
    hasHome: has('HOME'),
    hasUserprofile: has('USERPROFILE'),
    hasAppdata: has('APPDATA'),
    hasLocalappdata: has('LOCALAPPDATA'),
    hasPath: has('PATH'),
    hasAnthropicKey: has('ANTHROPIC_API_KEY'),
    hasOpenaiKey: has('OPENAI_API_KEY'),
    hasPiKey: has('PI_API_KEY'),
    credentialEnvCount: credentialKeys.length,
    credentialEnvKeys: credentialKeys.slice(0, 20),
  };
}
