import type { LarkChannel } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import {
  applyAgentKindToConfig,
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
  resolveCodexBinaryPath,
} from '../cli/agent-runtime';
import type { FullAppConfig } from '../config/agent-config';
import { toProfileConfig } from '../config/agent-config';
import { paths } from '../config/paths';
import type { ProfileConfig } from '../config/profile-schema';
import { saveConfig } from '../config/store';
import { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { ActiveRuns } from './active-runs';
import type { ProcessPool } from './process-pool';

export type SwitchableAgentKind = 'claude' | 'codex' | 'cursor';

export interface AgentRuntimeState {
  fullCfg: FullAppConfig;
  profileConfig: ProfileConfig | undefined;
  agent: AgentAdapter | undefined;
  executor: RunExecutor | undefined;
  agentEnabled: boolean;
  /** 配置了 agent 但启动时不可用（如未安装 CLI）。 */
  agentUnavailable?: boolean;
  cursorDebug: boolean;
  configPath: string;
}

export interface SwitchRuntimeAgentInput {
  kind: SwitchableAgentKind;
  runtime: AgentRuntimeState;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  channel: LarkChannel;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  activePolicyFingerprints?: Map<string, string>;
}

export type SwitchRuntimeAgentResult =
  | { ok: true; kind: SwitchableAgentKind; displayName: string }
  | { ok: false; message: string };

export async function switchRuntimeAgent(
  input: SwitchRuntimeAgentInput,
): Promise<SwitchRuntimeAgentResult> {
  const { runtime, kind } = input;
  const currentKind = runtime.fullCfg.agentKind ?? 'claude';
  if (currentKind === kind && runtime.agentEnabled) {
    return {
      ok: true,
      kind,
      displayName: runtime.agent?.displayName ?? agentLabel(kind),
    };
  }

  await input.activeRuns.stopAll();

  let nextCfg: FullAppConfig;
  try {
    nextCfg = await buildConfigForKind(runtime.fullCfg, kind);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }

  const agent = createRuntimeAgent(nextCfg, {
    configPath: runtime.configPath,
    cursorDebug: runtime.cursorDebug,
  });
  const availability = await checkRuntimeAgentAvailability(agent);
  if (!availability.ok) {
    return { ok: false, message: availability.message };
  }

  if (!runtime.configPath || runtime.configPath === paths.configFile) {
    await saveConfig(nextCfg, runtime.configPath);
  }

  clearAgentSessionState(input.sessions, input.sessionCatalog);
  input.activePolicyFingerprints?.clear();

  runtime.fullCfg = nextCfg;
  runtime.profileConfig = toProfileConfig(nextCfg);
  runtime.agent = agent;
  runtime.executor = new RunExecutor({
    agent,
    pool: input.pool,
    activeRuns: input.activeRuns,
  });
  runtime.agentEnabled = true;

  if (input.channel.botIdentity?.openId) {
    agent.setBotIdentity?.({
      openId: input.channel.botIdentity.openId,
      name: input.channel.botIdentity.name,
    });
  }

  return { ok: true, kind, displayName: agent.displayName };
}

async function buildConfigForKind(
  cfg: FullAppConfig,
  kind: SwitchableAgentKind,
): Promise<FullAppConfig> {
  if (kind === 'codex') {
    const binaryPath = cfg.codex?.binaryPath ?? (await resolveCodexBinaryPath());
    return applyAgentKindToConfig(cfg, 'codex', binaryPath);
  }
  if (kind === 'cursor') {
    return applyAgentKindToConfig(cfg, 'cursor');
  }
  return applyAgentKindToConfig(cfg, 'claude');
}

function clearAgentSessionState(sessions: SessionStore, sessionCatalog: SessionCatalog): void {
  for (const chatId of sessions.chatIds()) {
    sessions.clear(chatId);
  }
  for (const entry of [...sessionCatalog.entries()]) {
    if (entry.status !== 'active') continue;
    sessionCatalog.archiveActive({
      scopeId: entry.scopeId,
      agentId: entry.agentId,
      cwdRealpath: entry.cwdRealpath,
      policyFingerprint: entry.policyFingerprint,
    });
  }
}

function agentLabel(kind: SwitchableAgentKind): string {
  if (kind === 'codex') return 'Codex CLI';
  if (kind === 'cursor') return 'Cursor Agent';
  return 'Claude Code';
}
