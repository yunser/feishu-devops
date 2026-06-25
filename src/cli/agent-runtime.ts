import { ClaudeAdapter, CodexAdapter, CursorAdapter } from '../agent';
import type { AgentAdapter } from '../agent/types';
import {
  formatAgentPreflightError,
  getAgentPreflightDiagnostic,
} from '../agent/preflight';
import type { FullAppConfig } from '../config/agent-config';
import { toProfileConfig } from '../config/agent-config';
import { paths } from '../config/paths';
import type { ProfileConfig } from '../config/profile-schema';
import { resolveExecutablePath } from './agent-detection';

export interface CreateRuntimeAgentOptions {
  configPath?: string;
  cursorDebug?: boolean;
}

export function createRuntimeAgent(
  cfg: FullAppConfig,
  opts: CreateRuntimeAgentOptions = {},
): AgentAdapter {
  const profileConfig = toProfileConfig(cfg);
  const larkChannel = {
    rootDir: paths.rootDir,
    configPath: opts.configPath ?? paths.configFile,
  };

  if (profileConfig.agentKind === 'codex') {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: paths.rootDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
    });
  }
  if (profileConfig.agentKind === 'cursor') {
    const command =
      process.env.FEISHU_MESSAGE_TEST_CURSOR_BIN ??
      process.env.LARK_CHANNEL_CURSOR_BIN ??
      'agent';
    return new CursorAdapter({
      binary: command,
      larkChannel,
      ...(opts.cursorDebug === true ? { debug: true } : {}),
    });
  }
  return new ClaudeAdapter({ larkChannel });
}

export async function checkRuntimeAgentAvailability(
  agent: AgentAdapter,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const availability = await agent.checkAvailability?.();
  if (!availability) {
    const ok = await agent.isAvailable();
    return ok ? { ok: true } : { ok: false, message: `${agent.displayName} 不可用` };
  }
  if (availability.ok) return { ok: true };
  const diagnostic = getAgentPreflightDiagnostic(availability.error);
  if (diagnostic) {
    return { ok: false, message: formatAgentPreflightError(availability.error) };
  }
  return { ok: false, message: `${agent.displayName} 不可用` };
}

export async function resolveCodexBinaryPath(): Promise<string> {
  const command = process.env.FEISHU_MESSAGE_TEST_CODEX_BIN ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex';
  return resolveExecutablePath(command);
}

export async function resolveClaudeBinaryPath(): Promise<string> {
  const command = process.env.FEISHU_MESSAGE_TEST_CLAUDE_BIN ?? process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude';
  return resolveExecutablePath(command);
}

export async function resolveCursorBinaryPath(): Promise<string> {
  const command =
    process.env.FEISHU_MESSAGE_TEST_CURSOR_BIN ?? process.env.LARK_CHANNEL_CURSOR_BIN ?? 'agent';
  return resolveExecutablePath(command);
}

export function applyAgentKindToConfig(
  cfg: FullAppConfig,
  agentKind: 'claude' | 'codex' | 'cursor',
  codexBinaryPath?: string,
): FullAppConfig {
  const next: FullAppConfig = { ...cfg, agentKind };
  if (agentKind === 'codex' && codexBinaryPath) {
    next.codex = {
      binaryPath: codexBinaryPath,
      inheritCodexHome: true,
      ignoreRules: true,
      ...(cfg.codex ?? {}),
    };
  }
  return next;
}

export type { ProfileConfig };
