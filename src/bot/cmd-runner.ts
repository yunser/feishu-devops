import type { AppConfig } from '../config/schema';
import { getCmdProgressIntervalMs, getCmdTimeoutMs } from '../config/schema';
import { formatShellResult, runShellCommand } from './run-shell';

export function formatRunningStatus(command: string, elapsedSec: number): string {
  const elapsed = elapsedSec > 0 ? ` (${elapsedSec}s)` : '';
  return `⏳ 正在执行…${elapsed}\n\n$ ${command}`;
}

export async function runShellWithProgress(
  command: string,
  cfg: AppConfig,
  onProgress: (text: string) => Promise<void>,
  cwd?: string,
): Promise<string> {
  const started = Date.now();
  let elapsedSec = 0;
  let tickInFlight = false;
  const progressIntervalMs = getCmdProgressIntervalMs(cfg);

  await onProgress(formatRunningStatus(command, elapsedSec));

  const timer =
    progressIntervalMs > 0
      ? setInterval(() => {
          elapsedSec = Math.floor((Date.now() - started) / 1000);
          if (tickInFlight) return;
          tickInFlight = true;
          void onProgress(formatRunningStatus(command, elapsedSec)).finally(() => {
            tickInFlight = false;
          });
        }, progressIntervalMs)
      : undefined;

  try {
    const result = await runShellCommand(command, {
      cwd,
      timeoutMs: getCmdTimeoutMs(cfg),
    });
    return formatShellResult(command, result);
  } finally {
    if (timer) clearInterval(timer);
  }
}
