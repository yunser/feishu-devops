import * as launchd from './launchd';
import { launchAgentPlistPath, systemdUnitPath, windowsTaskName } from './paths';
import * as schtasks from './schtasks';
import * as systemd from './systemd';

export interface ServiceResult {
  ok: boolean;
  stderr: string;
}

export type ServiceResultLike = ServiceResult | Promise<ServiceResult>;

export interface ServiceAdapter {
  readonly platformName: string;
  fileExists(): boolean;
  isRunning(): boolean;
  servicePath(): string;
  install(): Promise<void>;
  start(): ServiceResultLike;
  stop(): ServiceResultLike;
  stopAndDisableAutostart(): ServiceResultLike;
  restart(): ServiceResultLike;
  waitUntilStopped(timeoutMs?: number): Promise<boolean>;
  deleteFile(): Promise<void>;
  describeStatus(): string;
  parseStatus(text: string): { pid?: string; lastExit?: string };
}

function makeLaunchdAdapter(extraRunArgs: string[]): ServiceAdapter {
  return {
    platformName: 'launchd (macOS)',
    fileExists: () => launchd.plistExists(),
    isRunning: () => launchd.isLoaded(),
    servicePath: () => launchAgentPlistPath(),
    install: () => launchd.writePlist(extraRunArgs),
    start: () => launchd.bootstrap(),
    stop: () => launchd.bootout(),
    stopAndDisableAutostart: () => launchd.bootout(),
    restart: () => launchd.kickstart(),
    waitUntilStopped: (timeoutMs) => launchd.waitUntilUnloaded(timeoutMs),
    deleteFile: () => launchd.deletePlist(),
    describeStatus: () => launchd.describeService(),
    parseStatus: (text) => ({
      pid: text.match(/pid\s*=\s*(\d+)/)?.[1],
      lastExit: text.match(/last exit code\s*=\s*(-?\d+)/i)?.[1],
    }),
  };
}

function makeSystemdAdapter(extraRunArgs: string[]): ServiceAdapter {
  return {
    platformName: 'systemd (Linux user)',
    fileExists: () => systemd.unitExists(),
    isRunning: () => systemd.isActive(),
    servicePath: () => systemdUnitPath(),
    install: async () => {
      await systemd.writeUnit(extraRunArgs);
      systemd.daemonReload();
    },
    start: () => systemd.enableAndStart(),
    stop: () => systemd.stop(),
    stopAndDisableAutostart: () => systemd.disableAndStop(),
    restart: () => systemd.restart(),
    waitUntilStopped: (timeoutMs) => systemd.waitUntilInactive(timeoutMs),
    deleteFile: async () => {
      await systemd.deleteUnit();
      systemd.daemonReload();
    },
    describeStatus: () => systemd.describeService(),
    parseStatus: (text) => ({
      pid: text.match(/Main PID:\s*(\d+)/)?.[1],
      lastExit: text.match(/Process:\s+\d+\s+ExecStart=.*status=(\d+)/)?.[1],
    }),
  };
}

function makeSchtasksAdapter(extraRunArgs: string[]): ServiceAdapter {
  return {
    platformName: 'Task Scheduler (Windows)',
    fileExists: () => schtasks.isTaskRegistered(),
    isRunning: () => schtasks.isTaskRunning(),
    servicePath: () => windowsTaskName(),
    install: async () => {
      const r = await schtasks.installTask(extraRunArgs);
      if (!r.ok) throw new Error(r.stderr || 'schtasks /Create failed');
    },
    start: () => schtasks.runTask(),
    stop: () => schtasks.endTask(),
    stopAndDisableAutostart: () => schtasks.endAndDisable(),
    restart: () => schtasks.restartTask(),
    waitUntilStopped: (timeoutMs) => schtasks.waitUntilStopped(timeoutMs),
    deleteFile: async () => {
      await schtasks.deleteTask();
    },
    describeStatus: () => schtasks.describeTask(),
    parseStatus: (text) => ({
      pid: text.match(/Process ID:\s*(\d+)/i)?.[1],
      lastExit: text.match(/Last Result:\s*(\d+)/i)?.[1],
    }),
  };
}

export function getServiceAdapter(extraRunArgs: string[] = []): ServiceAdapter | null {
  if (process.platform === 'darwin') return makeLaunchdAdapter(extraRunArgs);
  if (process.platform === 'linux') return makeSystemdAdapter(extraRunArgs);
  if (process.platform === 'win32') return makeSchtasksAdapter(extraRunArgs);
  return null;
}
