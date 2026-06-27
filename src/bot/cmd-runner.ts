import type { AppConfig } from '../config/schema';
import { getCmdProgressIntervalMs, getCmdTimeoutMs } from '../config/schema';
import { formatShellResult, runShellCommand, truncateShellOutput } from './run-shell';

const OUTPUT_FLUSH_INTERVAL_MS = 300;

export interface PartialShellOutput {
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

export function formatRunningStatus(
  command: string,
  elapsedSec: number,
  partial?: PartialShellOutput,
): string {
  const elapsed = elapsedSec > 0 ? ` (${elapsedSec}s)` : '';
  const lines: string[] = [`⏳ 正在执行…${elapsed}`, '', `$ ${command}`];

  if (partial) {
    const stdout = partial.stdout.trimEnd();
    const stderr = partial.stderr.trimEnd();
    const blockLines: string[] = [];

    if (stdout) blockLines.push(stdout);
    if (stderr) {
      if (stdout) blockLines.push('');
      blockLines.push('stderr:');
      blockLines.push(stderr);
    }

    if (blockLines.length > 0) {
      lines.push('', `\`\`\`bash\n${blockLines.join('\n')}\n\`\`\``);
    }
    if (partial.truncated) {
      lines.push('', '_（输出过长，已截断）_');
    }
  }

  return lines.join('\n');
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
  let outputFlushScheduled = false;
  let stdout = '';
  let stderr = '';
  const progressIntervalMs = getCmdProgressIntervalMs(cfg);

  const getPartialOutput = (): PartialShellOutput => {
    const truncated = truncateShellOutput(stdout, stderr);
    return truncated;
  };

  const pushProgress = async (partial?: PartialShellOutput) => {
    elapsedSec = Math.floor((Date.now() - started) / 1000);
    await onProgress(formatRunningStatus(command, elapsedSec, partial));
  };

  const scheduleOutputFlush = () => {
    if (outputFlushScheduled) return;
    outputFlushScheduled = true;
    setTimeout(() => {
      outputFlushScheduled = false;
      if (tickInFlight) return;
      tickInFlight = true;
      void pushProgress(getPartialOutput()).finally(() => {
        tickInFlight = false;
      });
    }, OUTPUT_FLUSH_INTERVAL_MS).unref();
  };

  await pushProgress();

  const timer =
    progressIntervalMs > 0
      ? setInterval(() => {
          if (tickInFlight) return;
          tickInFlight = true;
          void pushProgress(getPartialOutput()).finally(() => {
            tickInFlight = false;
          });
        }, progressIntervalMs)
      : undefined;

  try {
    const result = await runShellCommand(command, {
      cwd,
      timeoutMs: getCmdTimeoutMs(cfg),
      onOutput: (kind, chunk) => {
        if (kind === 'stdout') stdout += chunk;
        else stderr += chunk;
        scheduleOutputFlush();
      },
    });
    return formatShellResult(command, result);
  } finally {
    if (timer) clearInterval(timer);
  }
}
