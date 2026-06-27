import type { PermissionConfig } from './permissions';
import type { AgentKind, CodexConfig } from './profile-schema';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  type ProfileConfig,
} from './profile-schema';
import type { AppConfig } from './schema';

export type AgentKindOverride = AgentKind | 'disabled';

export interface AgentConfigFields {
  agentKind?: AgentKindOverride;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  workspaces?: { default?: string };
}

export type FullAppConfig = AppConfig & AgentConfigFields;

export function toProfileConfig(cfg: FullAppConfig): ProfileConfig {
  const agentKind: AgentKind =
    cfg.agentKind === 'codex'
      ? 'codex'
      : cfg.agentKind === 'cursor'
        ? 'cursor'
        : cfg.agentKind === 'pi'
          ? 'pi'
          : 'claude';
  const base = {
    schemaVersion: 2 as const,
    agentKind,
    accounts: cfg.accounts,
    preferences: cfg.preferences ?? {},
    access: {
      allowedUsers: cfg.preferences?.access?.allowedUsers ?? [],
      allowedChats: cfg.preferences?.access?.allowedChats ?? [],
      admins: cfg.preferences?.access?.admins ?? [],
      requireMentionInGroup: cfg.preferences?.requireMentionInGroup !== false,
    },
    workspaces: cfg.workspaces ?? {},
    permissions: cfg.permissions,
    codex: cfg.codex,
  };
  try {
    return normalizeProfileConfig(base);
  } catch {
    return createDefaultProfileConfig({
      agentKind,
      accounts: cfg.accounts,
      preferences: cfg.preferences,
      permissions: cfg.permissions,
      codex: cfg.codex,
    });
  }
}
