import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveDaemonRunInvocation } from './invoke';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  systemdUnitName,
  systemdUnitPath,
} from './paths';
import { paths } from '../config/paths';

export interface UnitInputs {
  program: string;
  runArgs: string[];
  envPath: string;
  channelHome: string;
  cwd: string;
}

export function buildUnit(inputs: UnitInputs): string {
  const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const execStart = [inputs.program, ...inputs.runArgs].map((part) => `"${escape(part)}"`).join(' ');
  return `[Unit]
Description=Feishu Message Test bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${escape(inputs.cwd)}
ExecStart=${execStart}
Restart=always
RestartSec=5
StandardOutput=append:${daemonStdoutPath()}
StandardError=append:${daemonStderrPath()}
Environment="PATH=${escape(inputs.envPath)}"
Environment="FEISHU_MESSAGE_TEST_HOME=${escape(inputs.channelHome)}"

[Install]
WantedBy=default.target
`;
}

export async function writeUnit(extraRunArgs: string[] = []): Promise<void> {
  const invocation = resolveDaemonRunInvocation(extraRunArgs);
  const content = buildUnit({
    program: invocation.program,
    runArgs: invocation.runArgs,
    envPath: process.env.PATH ?? '',
    channelHome: paths.rootDir,
    cwd: invocation.cwd,
  });
  const unitPath = systemdUnitPath();
  await mkdir(dirname(unitPath), { recursive: true });
  await mkdir(daemonLogDir(), { recursive: true });
  await writeFile(unitPath, content, 'utf8');
}

export function unitExists(): boolean {
  return existsSync(systemdUnitPath());
}

interface SystemctlResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runSystemctl(args: string[]): SystemctlResult {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

export function daemonReload(): SystemctlResult {
  return runSystemctl(['daemon-reload']);
}

export function enableAndStart(): SystemctlResult {
  return runSystemctl(['enable', '--now', systemdUnitName()]);
}

export function stop(): SystemctlResult {
  return runSystemctl(['stop', systemdUnitName()]);
}

export function disableAndStop(): SystemctlResult {
  return runSystemctl(['disable', '--now', systemdUnitName()]);
}

export function restart(): SystemctlResult {
  return runSystemctl(['restart', systemdUnitName()]);
}

export function isActive(): boolean {
  const r = spawnSync('systemctl', ['--user', 'is-active', systemdUnitName()], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

export function describeService(): string {
  const r = runSystemctl(['status', systemdUnitName(), '--no-pager']);
  return r.stdout || r.stderr || '';
}

export async function waitUntilInactive(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isActive()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function deleteUnit(): Promise<void> {
  await rm(systemdUnitPath(), { force: true });
}
