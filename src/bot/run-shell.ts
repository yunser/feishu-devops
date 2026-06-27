import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as pty from '@lydell/node-pty';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 3_500;
const CMD_ENV_KEY = 'FEISHU_DEVOPS_CMD';
const PTY_COLS = 80;
const PTY_ROWS = 24;

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface ShellSpawnHandle {
  writeStdin(data: string): void;
  kill(): void;
}

export interface SpawnShellOptions {
  cwd?: string;
  timeoutMs?: number;
  interactive?: boolean;
  onOutput?: (kind: 'stdout' | 'stderr', chunk: string) => void;
  onSpawn?: (handle: ShellSpawnHandle) => void;
}

let expectPathPromise: Promise<string | undefined> | undefined;
let windowsPowerShellPath: string | undefined;

function resolveWindowsPowerShell(): string {
  if (windowsPowerShellPath) return windowsPowerShellPath;
  if (process.env.FEISHU_DEVOPS_SHELL) {
    windowsPowerShellPath = process.env.FEISHU_DEVOPS_SHELL;
    return windowsPowerShellPath;
  }

  for (const exe of ['pwsh', 'pwsh.exe', 'powershell.exe']) {
    const found = spawnSync('where', [exe], { encoding: 'utf8', windowsHide: true });
    if (found.status === 0) {
      const line = found.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (line) {
        windowsPowerShellPath = line;
        return windowsPowerShellPath;
      }
    }
  }

  windowsPowerShellPath = 'powershell.exe';
  return windowsPowerShellPath;
}

function buildShellSpawnArgs(command: string, interactive: boolean): { file: string; args: string[] } | null {
  if (process.platform !== 'win32') return null;

  const args = ['-NoProfile'];
  if (!interactive) args.push('-NonInteractive');
  args.push('-Command', command);
  return { file: resolveWindowsPowerShell(), args };
}

function spawnShellChild(
  command: string,
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'] | ['ignore', 'pipe', 'pipe'];
    interactive?: boolean;
  },
): ChildProcess {
  const shellArgs = buildShellSpawnArgs(command, opts.interactive ?? false);
  if (shellArgs) {
    return spawn(shellArgs.file, shellArgs.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio,
      windowsHide: true,
    });
  }

  return spawn(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio,
  });
}

async function resolveExpectPath(): Promise<string | undefined> {
  if (!expectPathPromise) {
    expectPathPromise = (async () => {
      for (const candidate of ['/usr/bin/expect', '/bin/expect']) {
        try {
          await access(candidate, fsConstants.X_OK);
          return candidate;
        } catch {
          /* try next */
        }
      }
      return undefined;
    })();
  }
  return expectPathPromise;
}

export function normalizeTerminalOutput(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const WINDOWS_CP_TO_ENCODING: Record<string, string> = {
  '65001': 'utf-8',
  '936': 'gb18030',
  '54936': 'gb18030',
  '950': 'big5',
  '932': 'shift_jis',
  '949': 'euc-kr',
  '1252': 'windows-1252',
  '437': 'ibm437',
};

let windowsShellEncoding: string | undefined;

function detectWindowsShellEncoding(): string {
  if (windowsShellEncoding) return windowsShellEncoding;
  if (process.platform !== 'win32') {
    windowsShellEncoding = 'utf-8';
    return windowsShellEncoding;
  }

  try {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', 'chcp'], { encoding: 'buffer' });
    const output = Buffer.concat([
      result.stdout ?? Buffer.alloc(0),
      result.stderr ?? Buffer.alloc(0),
    ]);
    const chcpText = new TextDecoder('gb18030').decode(output);
    const match = chcpText.match(/:\s*(\d+)/);
    const cp = match?.[1] ?? '936';
    windowsShellEncoding = WINDOWS_CP_TO_ENCODING[cp] ?? 'gb18030';
  } catch {
    windowsShellEncoding = 'gb18030';
  }

  return windowsShellEncoding;
}

export function decodeShellOutput(chunk: Buffer): string {
  if (process.platform !== 'win32') {
    return chunk.toString('utf8');
  }

  const encoding = detectWindowsShellEncoding();
  if (encoding === 'utf-8') {
    return chunk.toString('utf8');
  }

  try {
    return new TextDecoder(encoding).decode(chunk);
  } catch {
    return chunk.toString('utf8');
  }
}

function writePtyLine(term: pty.IPty, text: string): void {
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  term.write(`${line}\r`);
}

function attachOutputPump(
  child: ChildProcess,
  onChunk: (kind: 'stdout' | 'stderr', text: string) => void,
): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    onChunk('stdout', normalizeTerminalOutput(decodeShellOutput(chunk)));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    onChunk('stderr', normalizeTerminalOutput(decodeShellOutput(chunk)));
  });
}

function childSpawnHandle(child: ChildProcess): ShellSpawnHandle {
  return {
    writeStdin: (data) => {
      child.stdin?.write(data.endsWith('\n') ? data : `${data}\n`);
    },
    kill: () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500).unref();
    },
  };
}

function spawnPipeShellCommand(
  command: string,
  opts: SpawnShellOptions,
): Promise<ShellRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd ?? process.cwd();

  return new Promise((resolve) => {
    const child = spawnShellChild(command, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      interactive: opts.interactive,
    });

    opts.onSpawn?.(childSpawnHandle(child));

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500).unref();
    }, timeoutMs);

    attachOutputPump(child, (kind, text) => {
      if (kind === 'stdout') stdout += text;
      else stderr += text;
      opts.onOutput?.(kind, text);
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

function spawnExpectShellCommand(
  command: string,
  expectPath: string,
  opts: SpawnShellOptions,
): Promise<ShellRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd ?? process.cwd();

  return new Promise((resolve) => {
    const child = spawn(
      expectPath,
      ['-c', 'spawn -noecho bash -c $env(FEISHU_DEVOPS_CMD); interact'],
      {
        cwd,
        env: { ...process.env, [CMD_ENV_KEY]: command },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    opts.onSpawn?.(childSpawnHandle(child));

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 500).unref();
    }, timeoutMs);

    attachOutputPump(child, (kind, text) => {
      if (kind === 'stdout') stdout += text;
      else stderr += text;
      opts.onOutput?.(kind, text);
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

function spawnPtyShellCommand(command: string, opts: SpawnShellOptions): Promise<ShellRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = opts.cwd ?? process.cwd();
  const shellArgs =
    process.platform === 'win32'
      ? { file: resolveWindowsPowerShell(), args: ['-NoProfile', '-Command', command] }
      : { file: process.env.SHELL || '/bin/bash', args: ['-c', command] };

  let term: pty.IPty;
  try {
    term = pty.spawn(shellArgs.file, shellArgs.args, {
      cwd,
      env: process.env,
      cols: PTY_COLS,
      rows: PTY_ROWS,
    });
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve) => {
    opts.onSpawn?.({
      writeStdin: (data) => writePtyLine(term, data),
      kill: () => {
        term.kill('SIGTERM');
        setTimeout(() => term.kill('SIGKILL'), 500).unref();
      },
    });

    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      term.kill('SIGTERM');
      setTimeout(() => term.kill('SIGKILL'), 500).unref();
    }, timeoutMs);

    term.onData((data) => {
      const text = normalizeTerminalOutput(data);
      stdout += text;
      opts.onOutput?.('stdout', text);
    });

    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      const truncated = truncateShellOutput(stdout, '');
      resolve({
        stdout: truncated.stdout,
        stderr: '',
        exitCode,
        timedOut,
        truncated: truncated.truncated,
      });
    });
  });
}

export async function spawnShellCommand(
  command: string,
  opts: SpawnShellOptions = {},
): Promise<ShellRunResult> {
  if (!opts.interactive) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cwd = opts.cwd ?? process.cwd();

    return new Promise((resolve) => {
      const child = spawnShellChild(command, {
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

      attachOutputPump(child, (kind, text) => {
        if (kind === 'stdout') stdout += text;
        else stderr += text;
        opts.onOutput?.(kind, text);
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

  try {
    return await spawnPtyShellCommand(command, opts);
  } catch {
    const expectPath = await resolveExpectPath();
    if (expectPath) {
      return spawnExpectShellCommand(command, expectPath, opts);
    }
    return spawnPipeShellCommand(command, opts);
  }
}

export async function runShellCommand(
  command: string,
  opts: {
    cwd?: string;
    timeoutMs?: number;
    onOutput?: (kind: 'stdout' | 'stderr', chunk: string) => void;
  } = {},
): Promise<ShellRunResult> {
  return spawnShellCommand(command, opts);
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
