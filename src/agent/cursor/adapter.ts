import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import {
  formatSpawnArgsForLog,
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';
import {
  createStdoutJsonStats,
  readStdoutJsonLines,
  summarizeAgentEnv,
  type StdoutJsonStats,
} from '../read-stdout-lines';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { createCursorStreamState, translateEvent } from './stream-json';

export interface CursorAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** 打印 spawn args 与每条原生 stream-json 事件。也可通过 FEISHU_DEVOPS_CURSOR_DEBUG=1 开启。 */
  debug?: boolean;
}

function isCursorDebugEnabled(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const raw =
    process.env.FEISHU_DEVOPS_CURSOR_DEBUG ?? process.env.LARK_CHANNEL_CURSOR_DEBUG;
  return raw === '1' || raw === 'true';
}

type CursorChild = SpawnedProcessByStdio<null, Readable, Readable>;

export class CursorAdapter implements AgentAdapter {
  readonly id = 'cursor';
  readonly displayName = 'Cursor Agent';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly debug: boolean;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CursorAdapterOptions = {}) {
    this.binary = opts.binary ?? 'agent';
    this.larkChannel = opts.larkChannel;
    this.debug = isCursorDebugEnabled(opts.debug);
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'cursor',
      agentName: 'Cursor Agent',
      command: this.binary,
      binaryPath: this.binary,
      args: ['--version'],
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for CursorAdapter.run');
    }

    const systemPrompt = buildBridgeSystemPrompt(this.botIdentity);
    const prompt = systemPrompt ? `${systemPrompt}\n\n${opts.prompt}` : opts.prompt;

    const args = [
      '-p',
      '--force',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      prompt,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);

    if (this.debug) {
      console.log('[cursor debug] spawn', {
        binary: this.binary,
        cwd: opts.cwd,
        args: formatDebugArgs(args),
      });
    }

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as CursorChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      binary: this.binary,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: prompt.length,
      model: opts.model,
      agent: 'cursor',
      args: formatSpawnArgsForLog(args),
    });
    log.info('agent', 'spawn-env', { agent: 'cursor', ...summarizeAgentEnv(process.env) });

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line, agent: 'cursor' });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn agent: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal, agent: 'cursor' });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, this.debug),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', {
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
          agent: 'cursor',
        });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
                agent: 'cursor',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: CursorChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  debug: boolean,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn agent: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const streamState = createCursorStreamState();
  const stats: StdoutJsonStats = createStdoutJsonStats();
  for await (const parsed of readStdoutJsonLines(child.stdout, { agent: 'cursor', debug, stats })) {
    if (debug) {
      console.log('[cursor debug] event', parsed);
    }
    yield* translateEvent(parsed, streamState);
  }
  log.info('agent', 'stdout-summary', {
    agent: 'cursor',
    rawLines: stats.rawLines,
    parsedOk: stats.parsedOk,
    parseFailed: stats.parseFailed,
    exitCode: child.exitCode,
    signal: child.signalCode,
    ...(stats.parseFailed > 0 ? { failedSamples: stats.failedSamples } : {}),
  });
  if (stats.rawLines === 0) {
    log.warn('agent', 'stdout-empty', {
      agent: 'cursor',
      exitCode: child.exitCode,
      signal: child.signalCode,
    });
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `cursor runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `cursor agent exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `cursor runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

function formatDebugArgs(args: string[]): string[] {
  const promptIndex = args.length - 1;
  if (promptIndex < 0) return args;
  const prompt = args[promptIndex];
  if (typeof prompt !== 'string' || prompt.length <= 200) return args;
  const copy = [...args];
  copy[promptIndex] = `${prompt.slice(0, 200)}… (${prompt.length} chars)`;
  return copy;
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
