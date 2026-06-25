export type TenantBrand = 'feishu' | 'lark';

export interface AppCredentials {
  id: string;
  secret: string;
  tenant: TenantBrand;
}

/**
 * How replies are rendered in IM chats:
 *   - `card`: full interactive card (tool panels, stop button, footer status)
 *   - `markdown`: lightweight streaming markdown card (typewriter, no buttons)
 *   - `text`: plain markdown post sent once at run completion (no streaming)
 */
export type MessageReplyMode = 'card' | 'markdown' | 'text';

export interface AppAccess {
  allowedUsers?: string[];
  allowedChats?: string[];
  admins?: string[];
}

export interface AppPreferences {
  /** 群中是否必须 @ 机器人才响应。私聊始终响应。默认 true。 */
  requireMentionInGroup?: boolean;
  /** 默认回复内容（agent 未启用时的 fallback） */
  defaultReply?: string;
  /** 是否允许 /cmd 执行本机 shell 命令。默认 true。 */
  cmdEnabled?: boolean;
  /** /cmd 超时时间（秒）。默认 30。 */
  cmdTimeoutSeconds?: number;
  /** /cmd 执行中状态刷新间隔（秒）。0 表示仅显示初始状态不刷新。默认 5。 */
  cmdProgressIntervalSeconds?: number;
  /** Agent 回复渲染模式。默认 markdown。 */
  messageReply?: MessageReplyMode;
  messageReplyMigrated?: boolean;
  /** 是否在输出中展示工具调用过程。默认 true。 */
  showToolCalls?: boolean;
  /** 全局最大并发 agent run 数。默认 10。 */
  maxConcurrentRuns?: number;
  /** 全局 idle 超时（分钟）。0 / 未设置 = 不超时。 */
  runIdleTimeoutMinutes?: number;
  /** agent 子进程 SIGTERM → SIGKILL 宽限期（毫秒）。默认 5000。 */
  agentStopGraceMs?: number;
  access?: AppAccess;
}

/** Placeholder for profile-schema compatibility. */
export type SecretsConfig = Record<string, never>;

export interface AppConfig {
  schemaVersion?: 2;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && app?.secret && app?.tenant);
}

export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  return cfg.preferences?.requireMentionInGroup !== false;
}

export function getDefaultReply(cfg: AppConfig): string {
  return cfg.preferences?.defaultReply ?? 'hello world';
}

export function isCmdEnabled(cfg: AppConfig): boolean {
  return cfg.preferences?.cmdEnabled !== false;
}

export function getCmdTimeoutMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.cmdTimeoutSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 30_000;
  return Math.min(Math.floor(raw), 120) * 1000;
}

/** /cmd 执行中刷新间隔。0 = 不周期性刷新。默认 5000ms。 */
export function getCmdProgressIntervalMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.cmdProgressIntervalSeconds;
  if (raw === 0) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 5_000;
  return Math.min(Math.floor(raw), 60) * 1000;
}

export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'text' && cfg.preferences?.messageReplyMigrated !== true) {
    return 'markdown';
  }
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'markdown';
}

export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls !== false;
}

export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  return Math.min(Math.floor(raw), 50);
}

export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}
