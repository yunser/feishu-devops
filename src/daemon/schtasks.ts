import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveDaemonRunInvocation } from './invoke';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  windowsLauncherCmdPath,
  windowsTaskName,
} from './paths';
import { paths } from '../config/paths';

export interface LauncherInputs {
  program: string;
  runArgs: string[];
  envPath: string;
  channelHome: string;
  cwd: string;
}

export function buildLauncherCmd(inputs: LauncherInputs): string {
  const cmdParts = [inputs.program, ...inputs.runArgs]
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(' ');
  return [
    '@echo off',
    `cd /d "${inputs.cwd.replace(/"/g, '""')}"`,
    `set "FEISHU_MESSAGE_TEST_HOME=${inputs.channelHome}"`,
    `set "PATH=${inputs.envPath}"`,
    `${cmdParts} >> "${daemonStdoutPath()}" 2>> "${daemonStderrPath()}"`,
    '',
  ].join('\r\n');
}

async function writeLauncherCmd(extraRunArgs: string[] = []): Promise<void> {
  const invocation = resolveDaemonRunInvocation(extraRunArgs);
  const content = buildLauncherCmd({
    program: invocation.program,
    runArgs: invocation.runArgs,
    envPath: process.env.PATH ?? '',
    channelHome: paths.rootDir,
    cwd: invocation.cwd,
  });
  const cmdPath = windowsLauncherCmdPath();
  await mkdir(dirname(cmdPath), { recursive: true });
  await mkdir(daemonLogDir(), { recursive: true });
  await writeFile(cmdPath, content, 'utf8');
}

interface SchtasksResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runSchtasks(args: string[]): SchtasksResult {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

export async function installTask(extraRunArgs: string[] = []): Promise<SchtasksResult> {
  await writeLauncherCmd(extraRunArgs);
  return runSchtasks([
    '/Create',
    '/F',
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/TN',
    windowsTaskName(),
    '/TR',
    `"${windowsLauncherCmdPath()}"`,
  ]);
}

export function runTask(): SchtasksResult {
  return runSchtasks(['/Run', '/TN', windowsTaskName()]);
}

export function endTask(): SchtasksResult {
  return runSchtasks(['/End', '/TN', windowsTaskName()]);
}

export function disableTask(): SchtasksResult {
  return runSchtasks(['/Change', '/TN', windowsTaskName(), '/Disable']);
}

export function endAndDisable(): SchtasksResult {
  const ended = endTask();
  const disabled = disableTask();
  return disabled.ok ? disabled : ended.ok ? disabled : ended;
}

export async function restartTask(): Promise<SchtasksResult> {
  endTask();
  await waitUntilStopped();
  return runTask();
}

export function isTaskRegistered(): boolean {
  const r = spawnSync('schtasks', ['/Query', '/TN', windowsTaskName()], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

export function isTaskRunning(): boolean {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName()]);
  if (!r.ok) return false;
  return /Status:\s+Running/i.test(r.stdout);
}

export function describeTask(): string {
  const r = runSchtasks(['/Query', '/V', '/FO', 'LIST', '/TN', windowsTaskName()]);
  return r.stdout || r.stderr || '';
}

export async function waitUntilStopped(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isTaskRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteTask(): Promise<SchtasksResult> {
  const r = runSchtasks(['/Delete', '/F', '/TN', windowsTaskName()]);
  if (existsSync(windowsLauncherCmdPath())) {
    await rm(windowsLauncherCmdPath(), { force: true });
  }
  return r;
}
