import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 3_500;

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export async function runShellCommand(
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ShellRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd ?? process.cwd();

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500).unref();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const truncated = truncate(stdout, stderr);
      resolve({
        stdout: truncated.stdout,
        stderr: truncated.stderr,
        exitCode,
        timedOut,
        truncated: truncated.truncated,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        timedOut: false,
        truncated: false,
      });
    });
  });
}

function truncate(stdout: string, stderr: string): { stdout: string; stderr: string; truncated: boolean } {
  const combined = stdout.length + stderr.length;
  if (combined <= MAX_OUTPUT_CHARS) {
    return { stdout, stderr, truncated: false };
  }

  const budget = MAX_OUTPUT_CHARS;
  const stdoutBudget = Math.min(stdout.length, Math.floor(budget * 0.7));
  const stderrBudget = Math.min(stderr.length, budget - stdoutBudget);
  return {
    stdout: stdout.slice(0, stdoutBudget),
    stderr: stderr.slice(0, stderrBudget),
    truncated: true,
  };
}

export function formatShellResult(command: string, result: ShellRunResult): string {
  const lines: string[] = [`$ ${command}`];

  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();

  if (stdout) lines.push(stdout);
  if (stderr) {
    lines.push('', 'stderr:', stderr);
  }
  if (result.timedOut) {
    lines.push('', '(命令超时，已终止)');
  } else if (result.exitCode !== 0 && result.exitCode !== null) {
    lines.push('', `(exit ${result.exitCode})`);
  }
  if (result.truncated) {
    lines.push('', '(输出过长，已截断)');
  }
  if (!stdout && !stderr && result.exitCode === 0 && !result.timedOut) {
    lines.push('(无输出)');
  }

  return lines.join('\n');
}
