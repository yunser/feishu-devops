import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import { resolveDaemonRunInvocation } from './invoke';
import {
  daemonLogDir,
  daemonStderrPath,
  daemonStdoutPath,
  launchAgentLabel,
  launchAgentPlistPath,
} from './paths';
import { paths } from '../config/paths';

export interface PlistInputs {
  program: string;
  runArgs: string[];
  envPath: string;
  channelHome: string;
  cwd: string;
}

export function buildPlist(inputs: PlistInputs): string {
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const argsXml = [inputs.program, ...inputs.runArgs]
    .map((arg) => `        <string>${escape(arg)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${launchAgentLabel()}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escape(inputs.cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escape(daemonStdoutPath())}</string>
    <key>StandardErrorPath</key>
    <string>${escape(daemonStderrPath())}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escape(inputs.envPath)}</string>
        <key>FEISHU_MESSAGE_TEST_HOME</key>
        <string>${escape(inputs.channelHome)}</string>
    </dict>
</dict>
</plist>
`;
}

export async function writePlist(extraRunArgs: string[] = []): Promise<void> {
  const invocation = resolveDaemonRunInvocation(extraRunArgs);
  const content = buildPlist({
    program: invocation.program,
    runArgs: invocation.runArgs,
    envPath: process.env.PATH ?? '',
    channelHome: paths.rootDir,
    cwd: invocation.cwd,
  });
  const plistPath = launchAgentPlistPath();
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(daemonLogDir(), { recursive: true });
  await writeFile(plistPath, content, 'utf8');
}

export function plistExists(): boolean {
  return existsSync(launchAgentPlistPath());
}

function userTarget(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${userTarget()}/${launchAgentLabel()}`;
}

interface LaunchctlResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function runLaunchctl(args: string[]): LaunchctlResult {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: r.stderr ?? '',
    stdout: r.stdout ?? '',
  };
}

export function bootstrap(): LaunchctlResult {
  return runLaunchctl(['bootstrap', userTarget(), launchAgentPlistPath()]);
}

export function bootout(): LaunchctlResult {
  return runLaunchctl(['bootout', serviceTarget()]);
}

export function kickstart(): LaunchctlResult {
  return runLaunchctl(['kickstart', '-k', serviceTarget()]);
}

export function isLoaded(): boolean {
  const r = spawnSync('launchctl', ['print', serviceTarget()], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

export async function waitUntilUnloaded(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoaded()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function describeService(): string {
  const r = runLaunchctl(['print', serviceTarget()]);
  return r.stdout || r.stderr || '';
}

export async function deletePlist(): Promise<void> {
  await rm(launchAgentPlistPath(), { force: true });
}
