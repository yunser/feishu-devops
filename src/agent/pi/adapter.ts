import type { Readable, Writable } from 'node:stream';
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
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { createPiStreamState, translateEvent } from './stream-json';

export interface PiAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** 打印 spawn args 与每条原生 json 事件。也可通过 FEISHU_DEVOPS_PI_DEBUG=1 开启。 */
  debug?: boolean;
}

function isPiDebugEnabled(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const raw = process.env.FEISHU_DEVOPS_PI_DEBUG ?? process.env.LARK_CHANNEL_PI_DEBUG;
  return raw === '1' || raw === 'true';
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi Agent';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly debug: boolean;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'pi';
    this.larkChannel = opts.larkChannel;
    this.debug = isPiDebugEnabled(opts.debug);
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'pi',
      agentName: 'Pi Agent',
      command: this.binary,
      binaryPath: this.binary,
      args: ['--version'],
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for PiAdapter.run');
    }

    // Pass the prompt via stdin, not argv — see claude adapter for the full
    // rationale. In short: the bridge prompt is full of `"`, backticks and `<>`
    // which break cmd.exe argument quoting on the Windows `.cmd` shim, silently
    // swallowing `--mode json` and making pi emit plain text ("未返回内容").
    const stdinPrompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const args = ['--mode', 'json', '-p'];
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);

    if (this.debug) {
      console.log('[pi debug] spawn', {
        binary: this.binary,
        cwd: opts.cwd,
        args: formatDebugArgs(args),
        promptChars: stdinPrompt.length,
        via: 'stdin',
      });
    }

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      binary: this.binary,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: stdinPrompt.length,
      via: 'stdin',
      model: opts.model,
      agent: 'pi',
      args: formatSpawnArgsForLog(args),
    });
    log.info('agent', 'spawn-env', { agent: 'pi', ...summarizeAgentEnv(process.env) });

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
        if (line.trim()) log.warn('agent', 'stderr', { line, agent: 'pi' });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn pi: ${line.trim()}`);
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
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal, agent: 'pi' });
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message, agent: 'pi' });
    });
    child.stdin.end(stdinPrompt, 'utf8');

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, this.debug),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', {
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
          agent: 'pi',
        });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
                agent: 'pi',
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
  child: PiChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  debug: boolean,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn pi: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const streamState = createPiStreamState();
  const stats: StdoutJsonStats = createStdoutJsonStats();
  for await (const parsed of readStdoutJsonLines(child.stdout, { agent: 'pi', debug, stats })) {
    if (debug) {
      console.log('[pi debug] event', parsed);
    }
    yield* translateEvent(parsed, streamState);
  }
  log.info('agent', 'stdout-summary', {
    agent: 'pi',
    rawLines: stats.rawLines,
    parsedOk: stats.parsedOk,
    parseFailed: stats.parseFailed,
    exitCode: child.exitCode,
    signal: child.signalCode,
    ...(stats.parseFailed > 0 ? { failedSamples: stats.failedSamples } : {}),
  });
  if (stats.rawLines === 0) {
    log.warn('agent', 'stdout-empty', {
      agent: 'pi',
      exitCode: child.exitCode,
      signal: child.signalCode,
    });
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `pi runtime error: ${earlyRuntimeError.message}`,
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
  if (!streamState.doneEmitted && exitCode === 0) {
    yield {
      type: 'done',
      sessionId: streamState.sessionId,
      terminationReason: 'normal',
    };
  } else if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `pi agent exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `pi runtime error: ${runtimeError.message}`,
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
