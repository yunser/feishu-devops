import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 300_000;
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
  opts: {
    cwd?: string;
    timeoutMs?: number;
    onOutput?: (kind: 'stdout' | 'stderr', chunk: string) => void;
  } = {},
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
      const text = chunk.toString('utf8');
      stdout += text;
      opts.onOutput?.('stdout', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      opts.onOutput?.('stderr', text);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const truncated = truncateShellOutput(stdout, stderr);
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

export function truncateShellOutput(
  stdout: string,
  stderr: string,
): { stdout: string; stderr: string; truncated: boolean } {
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
  const blockLines: string[] = [];

  if (stdout) blockLines.push(stdout);
  if (stderr) {
    if (stdout) blockLines.push('');
    blockLines.push('stderr:');
    blockLines.push(stderr);
  }

  if (blockLines.length > 0) {
    lines.push('', `\`\`\`bash\n${blockLines.join('\n')}\n\`\`\``);
  } else if (result.exitCode === 0 && !result.timedOut) {
    lines.push('', '_(无输出)_');
  }

  if (result.timedOut) {
    lines.push('', '_（命令超时，已终止）_');
  } else if (result.exitCode !== 0 && result.exitCode !== null) {
    lines.push('', `_（exit ${result.exitCode}）_`);
  }
  if (result.truncated) {
    lines.push('', '_（输出过长，已截断）_');
  }

  return lines.join('\n');
}
