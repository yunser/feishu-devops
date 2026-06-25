import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import type { WorkspaceStore } from '../workspace/store';

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`;
  return p;
}

export function isAbsoluteOrTilde(p: string): boolean {
  return isAbsolute(p) || p === '~' || p.startsWith('~/');
}

export function chatScope(msg: NormalizedMessage): string {
  return msg.chatId;
}

export function storedCwd(workspaces: WorkspaceStore, chatId: string): string | undefined {
  return workspaces.cwdFor(chatId);
}

export function effectiveCwd(workspaces: WorkspaceStore, chatId: string): string {
  return workspaces.cwdFor(chatId) ?? process.cwd();
}
