import dns from 'node:dns';
import {
  applyAgentKindToConfig,
  checkRuntimeAgentAvailability,
  createRuntimeAgent,
  resolveClaudeBinaryPath,
  resolveCodexBinaryPath,
  resolveCursorBinaryPath,
  resolvePiBinaryPath,
} from './agent-runtime';
import { startChannel } from '../bot/channel';
import type { FullAppConfig } from '../config/agent-config';
import { saveConfig } from '../config/store';
import { paths } from '../config/paths';
import { SessionStore } from '../session/store';
import { SessionCatalog } from '../session/catalog';
import { WorkspaceStore } from '../workspace/store';
import { resolveConfig } from './bootstrap';

dns.setDefaultResultOrder('ipv4first');

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

export interface StartOptions {
  config?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  agent?: 'claude' | 'codex' | 'cursor' | 'pi' | 'disabled';
  /** 开启 Cursor agent 调试输出（spawn args + 原生 stream-json 事件） */
  debug?: boolean;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const { cfg, configPath } = await resolveConfig(opts);
  let fullCfg = cfg as FullAppConfig;

  const agentKind = opts.agent ?? fullCfg.agentKind ?? 'claude';
  if (agentKind === 'disabled') {
    fullCfg = { ...fullCfg, agentKind: 'disabled' };
  } else if (opts.agent || !fullCfg.agentKind || fullCfg.agentKind === 'disabled') {
    if (agentKind === 'codex') {
      const binaryPath = fullCfg.codex?.binaryPath ?? (await resolveCodexBinaryPath());
      fullCfg = applyAgentKindToConfig(fullCfg, 'codex', binaryPath);
    } else if (agentKind === 'cursor') {
      fullCfg = applyAgentKindToConfig(fullCfg, 'cursor');
    } else if (agentKind === 'pi') {
      fullCfg = applyAgentKindToConfig(fullCfg, 'pi');
    } else {
      fullCfg = applyAgentKindToConfig(fullCfg, 'claude');
    }
    if (configPath === paths.configFile) {
      await saveConfig(fullCfg);
    }
  }

  const workspaces = new WorkspaceStore();
  await workspaces.load();
  const sessions = new SessionStore();
  await sessions.load();
  const sessionCatalog = new SessionCatalog();
  await sessionCatalog.load();

  let agent;
  let agentUnavailable = false;
  if (agentKind !== 'disabled') {
    agent = createRuntimeAgent(fullCfg, { configPath, cursorDebug: opts.debug });
    const availability = await checkRuntimeAgentAvailability(agent);
    if (!availability.ok) {
      console.warn('⚠ Agent 不可用，服务将以无 Agent 模式启动（/cmd、/status 等命令仍可用）');
      console.warn(availability.message);
      agent = undefined;
      agentUnavailable = true;
    } else if (agentKind === 'claude') {
      try {
        const claudePath = await resolveClaudeBinaryPath();
        console.log(`✓ Claude Code: ${claudePath}`);
      } catch {
        /* already checked */
      }
    } else if (agentKind === 'cursor') {
      try {
        const cursorPath = await resolveCursorBinaryPath();
        console.log(`✓ Cursor Agent: ${cursorPath}${opts.debug ? ' (debug)' : ''}`);
      } catch {
        console.log(`✓ Cursor Agent: agent${opts.debug ? ' (debug)' : ''}`);
      }
    } else if (agentKind === 'pi') {
      try {
        const piPath = await resolvePiBinaryPath();
        console.log(`✓ Pi Agent: ${piPath}${opts.debug ? ' (debug)' : ''}`);
      } catch {
        console.log(`✓ Pi Agent: pi${opts.debug ? ' (debug)' : ''}`);
      }
    } else {
      console.log(`✓ Codex CLI: ${fullCfg.codex?.binaryPath ?? 'codex'}`);
    }
  }

  const bridge = await startChannel(cfg, {
    workspaces,
    agent,
    cfg: fullCfg,
    sessions,
    sessionCatalog,
    cursorDebug: opts.debug,
    configPath,
    agentUnavailable,
  });

  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal}，正在断开连接…`);
    try {
      await bridge.disconnect();
    } catch (err) {
      console.error('断开连接时出错:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise<void>(() => {});
}
