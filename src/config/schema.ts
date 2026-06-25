export type TenantBrand = 'feishu' | 'lark';

export interface AppCredentials {
  id: string;
  secret: string;
  tenant: TenantBrand;
}

export interface AppPreferences {
  /** 群中是否必须 @ 机器人才响应。私聊始终响应。默认 true。 */
  requireMentionInGroup?: boolean;
  /** 默认回复内容（非 ping 时） */
  defaultReply?: string;
  /** 是否允许 /cmd 执行本机 shell 命令。默认 true。 */
  cmdEnabled?: boolean;
  /** /cmd 超时时间（秒）。默认 30。 */
  cmdTimeoutSeconds?: number;
  /** /cmd 执行中状态刷新间隔（秒）。0 表示仅显示初始状态不刷新。默认 5。 */
  cmdProgressIntervalSeconds?: number;
}

export interface AppConfig {
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
