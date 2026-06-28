import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../config/paths';

export const SERVICE_NAME = 'chat-devops.bot';

export function launchAgentLabel(): string {
  return `ai.${SERVICE_NAME}`;
}

export function launchAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel()}.plist`);
}

export function systemdUnitName(): string {
  return `${SERVICE_NAME}.service`;
}

export function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'systemd', 'user', systemdUnitName());
}

export function windowsTaskName(): string {
  return 'FeishuDevops.Bot';
}

export function windowsLauncherCmdPath(): string {
  return join(paths.rootDir, 'daemon', 'launcher.cmd');
}

export function daemonLogDir(): string {
  return join(paths.rootDir, 'logs', 'daemon');
}

export function daemonStdoutPath(): string {
  return join(daemonLogDir(), 'daemon-stdout.log');
}

export function daemonStderrPath(): string {
  return join(daemonLogDir(), 'daemon-stderr.log');
}

export function spawnDaemonPidPath(): string {
  return join(daemonLogDir(), 'bot.pid');
}

export function spawnDaemonMarkerPath(): string {
  return join(daemonLogDir(), '.spawn-daemon');
}
