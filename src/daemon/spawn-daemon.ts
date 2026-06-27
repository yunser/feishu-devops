import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolveDaemonRunInvocation } from './invoke';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  spawnDaemonMarkerPath,
  spawnDaemonPidPath,
} from './paths';
import { paths } from '../config/paths';

export interface SpawnResult {
  ok: boolean;
  stderr: string;
}

function readPid(): number | null {
  if (!existsSync(spawnDaemonPidPath())) return null;
  const raw = readFileSync(spawnDaemonPidPath(), 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function markerExists(): boolean {
  return existsSync(spawnDaemonMarkerPath());
}

export function isRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    try {
      unlinkSync(spawnDaemonPidPath());
    } catch {
      /* ignore */
    }
    return false;
  }
  return true;
}

export async function install(extraRunArgs: string[] = []): Promise<void> {
  void extraRunArgs;
  await mkdir(daemonLogDir(), { recursive: true });
  await writeFile(spawnDaemonMarkerPath(), 'spawn-daemon\n', 'utf8');
}

export function start(extraRunArgs: string[] = []): SpawnResult {
  if (isRunning()) {
    return { ok: true, stderr: '' };
  }

  const invocation = resolveDaemonRunInvocation(extraRunArgs);
  let outFd: number;
  let errFd: number;
  try {
    outFd = openSync(daemonStdoutPath(), 'a');
    errFd = openSync(daemonStderrPath(), 'a');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr: message };
  }

  const child = spawn(invocation.program, invocation.runArgs, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    cwd: invocation.cwd,
    env: {
      ...process.env,
      PATH: process.env.PATH ?? '',
      FEISHU_DEVOPS_HOME: paths.rootDir,
    },
  });

  closeSync(outFd);
  closeSync(errFd);

  if (!child.pid) {
    return { ok: false, stderr: 'failed to spawn daemon process' };
  }

  try {
    writeFileSync(spawnDaemonPidPath(), `${child.pid}\n`, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr: message };
  }

  child.unref();
  return { ok: true, stderr: '' };
}

export function stop(): SpawnResult {
  const pid = readPid();
  if (pid === null || !isProcessAlive(pid)) {
    return { ok: true, stderr: '' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stderr: message };
  }

  return { ok: true, stderr: '' };
}

export function stopAndDisableAutostart(): SpawnResult {
  return stop();
}

export function restart(extraRunArgs: string[] = []): SpawnResult {
  const r = stop();
  if (!r.ok) return r;
  return start(extraRunArgs);
}

export async function waitUntilInactive(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteMarker(): Promise<void> {
  await rm(spawnDaemonMarkerPath(), { force: true });
  await rm(spawnDaemonPidPath(), { force: true });
}

export function describeService(): string {
  const pid = readPid();
  if (pid !== null && isProcessAlive(pid)) {
    return `bot (detached): running (pid ${pid})`;
  }
  if (pid !== null) {
    return `bot (detached): not running (stale pid ${pid})`;
  }
  return 'bot (detached): not running';
}
