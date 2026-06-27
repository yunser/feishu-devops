import type { LarkChannel, LarkChannelOptions, NormalizedMessage } from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { FullAppConfig } from '../config/agent-config';
import { toProfileConfig } from '../config/agent-config';
import type { AppConfig } from '../config/schema';
import { getMaxConcurrentRuns, getRequireMentionInGroup } from '../config/schema';
import { configureLogger } from '../core/logger';
import { paths } from '../config/paths';
import { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import { SessionCatalog as SessionCatalogImpl } from '../session/catalog';
import type { SessionStore } from '../session/store';
import { SessionStore as SessionStoreImpl } from '../session/store';
import { WorkspaceStore } from '../workspace/store';
import { ActiveRuns } from './active-runs';
import { isAgentEnabled, runAgentMessage } from './agent-run';
import type { AgentRuntimeState } from './agent-switch';
import { tryHandleCommand } from './commands';
import { buildFixedReply } from './reply';
import { ProcessPool } from './process-pool';
import { chatScope } from './cwd';
import { handleCardAction } from '../card/dispatcher';

export interface BotChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelOptions {
  workspaces?: WorkspaceStore;
  agent?: AgentAdapter;
  cfg?: FullAppConfig;
  sessions?: SessionStore;
  sessionCatalog?: SessionCatalog;
  cursorDebug?: boolean;
  configPath?: string;
}

function log(level: 'info' | 'warn' | 'error', phase: string, detail?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = detail ? ` ${JSON.stringify(detail)}` : '';
  console[level](`[${ts}] ${phase}${extra}`);
}

export async function startChannel(
  cfg: AppConfig,
  startOpts: StartChannelOptions = {},
): Promise<BotChannel> {
  const fullCfg = (startOpts.cfg ?? cfg) as FullAppConfig;
  const configPath = startOpts.configPath ?? paths.configFile;
  const agentEnabled = Boolean(startOpts.agent) && isAgentEnabled(fullCfg);
  const profileConfig = agentEnabled ? toProfileConfig(fullCfg) : undefined;

  configureLogger({ logsDir: `${paths.rootDir}/logs` });

  const { app } = cfg.accounts;
  const workspaces = startOpts.workspaces ?? new WorkspaceStore();
  if (!startOpts.workspaces) {
    await workspaces.load();
  }

  const sessions = startOpts.sessions ?? new SessionStoreImpl();
  if (!startOpts.sessions) {
    await sessions.load();
  }

  const sessionCatalog = startOpts.sessionCatalog ?? new SessionCatalogImpl();
  if (!startOpts.sessionCatalog) {
    await sessionCatalog.load();
  }

  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => getMaxConcurrentRuns(cfg));
  const activePolicyFingerprints = new Map<string, string>();

  const runtime: AgentRuntimeState = {
    fullCfg,
    profileConfig,
    agent: startOpts.agent,
    executor:
      agentEnabled && startOpts.agent
        ? new RunExecutor({ agent: startOpts.agent, pool, activeRuns })
        : undefined,
    agentEnabled,
    cursorDebug: startOpts.cursorDebug === true,
    configPath,
  };

  const opts: LarkChannelOptions = {
    appId: app.id,
    appSecret: app.secret,
    domain:
      app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'feishu-devops',
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    safety: {
      chatQueue: { enabled: false },
    },
    wsConfig: {
      pingTimeout: 3,
    },
    handshakeTimeoutMs: 8_000,
    httpTimeoutMs: 30_000,
    respectProxyEnv: true,
    includeRawEvent: true,
  };

  const channel = createLarkChannel(opts);
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      try {
        await handleMessage(
          channel,
          cfg,
          msg,
          workspaces,
          {
            runtime,
            pool,
            sessions,
            sessionCatalog,
            activeRuns,
            activePolicyFingerprints,
          },
        );
      } catch (err) {
        log('error', 'message-handler-failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
    cardAction: async (evt) => {
      try {
        await handleCardAction({
          channel,
          evt,
          runtime,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          processPool: pool,
        });
      } catch (err) {
        log('error', 'card-action-failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
    reject: (evt) => {
      log('info', 'message-rejected', { chatId: evt.chatId, reason: evt.reason });
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log('warn', 'ws-reconnecting', { consecutive: consecutiveReconnects });
      if (consecutiveReconnects === 3) {
        console.error('⚠️  已连续重连 3 次，网络可能不稳。');
      }
    },
    reconnected: () => {
      if (runtime.agent) {
        runtime.agent.setBotIdentity?.({
          openId: channel.botIdentity?.openId ?? '',
          name: channel.botIdentity?.name,
        });
      }
      if (consecutiveReconnects > 1) {
        log('info', 'ws-recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log('info', 'ws-reconnected');
      }
      consecutiveReconnects = 0;
    },
    error: (err) => {
      log('error', 'ws-error', {
        message: err?.message ?? String(err),
        code: err?.code,
      });
    },
  });

  await channel.connect();

  if (runtime.agent && channel.botIdentity?.openId) {
    runtime.agent.setBotIdentity?.({
      openId: channel.botIdentity.openId,
      name: channel.botIdentity.name,
    });
  }

  const identity = channel.botIdentity;
  log('info', 'ws-connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    appId: app.id,
    agent: runtime.agentEnabled ? runtime.profileConfig?.agentKind : 'disabled',
  });
  console.log(
    runtime.agentEnabled
      ? `正在监听消息（agent: ${runtime.profileConfig?.agentKind ?? 'unknown'}）。按 Ctrl+C 退出。\n`
      : '正在监听消息。按 Ctrl+C 退出。\n',
  );

  return {
    channel,
    disconnect: async () => {
      await activeRuns.stopAll();
      await sessions.flush();
      await sessionCatalog.flush();
      await workspaces.flush();
      await channel.disconnect();
    },
  };
}

interface MessageHandlerContext {
  runtime: AgentRuntimeState;
  pool: ProcessPool;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  activeRuns: ActiveRuns;
  activePolicyFingerprints: Map<string, string>;
}

async function handleMessage(
  channel: LarkChannel,
  cfg: AppConfig,
  msg: NormalizedMessage,
  workspaces: WorkspaceStore,
  ctx: MessageHandlerContext,
): Promise<void> {
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  log('info', 'message-received', {
    chatType: msg.chatType,
    sender: msg.senderId,
    preview,
    mentionedBot: msg.mentionedBot,
  });

  if (msg.chatType !== 'p2p' && getRequireMentionInGroup(cfg) && !msg.mentionedBot) {
    log('info', 'skip-no-mention', { chatId: msg.chatId });
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    cfg,
    fullCfg: ctx.runtime.fullCfg,
    profileConfig: ctx.runtime.profileConfig,
    msg,
    scope: chatScope(msg),
    workspaces,
    activeRuns: ctx.activeRuns,
    sessions: ctx.sessions,
    sessionCatalog: ctx.sessionCatalog,
    agent: ctx.runtime.agent,
    processPool: ctx.pool,
    runtime: ctx.runtime,
    activePolicyFingerprints: ctx.activePolicyFingerprints,
  });
  if (handled) {
    log('info', 'command-handled');
    return;
  }

  if (
    ctx.runtime.agentEnabled &&
    ctx.runtime.profileConfig &&
    ctx.runtime.executor
  ) {
    await runAgentMessage(
      {
        channel,
        cfg: ctx.runtime.fullCfg,
        profileConfig: ctx.runtime.profileConfig,
        executor: ctx.runtime.executor,
        sessions: ctx.sessions,
        sessionCatalog: ctx.sessionCatalog,
        workspaces,
        activePolicyFingerprints: ctx.activePolicyFingerprints,
      },
      msg,
    );
    return;
  }

  const replyText = buildFixedReply(msg.content, cfg);
  await sendTextReply(channel, msg, replyText);
}

async function sendTextReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  replyText: string,
): Promise<void> {
  const sendOpts = {
    replyTo: msg.messageId,
    ...(msg.threadId ? { replyInThread: true } : {}),
  };

  try {
    await channel.send(msg.chatId, { text: replyText }, sendOpts);
    log('info', 'message-replied', { reply: replyText });
  } catch (err) {
    log('warn', 'reply-with-thread-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    await channel.send(msg.chatId, { text: replyText }, { replyTo: msg.messageId });
    log('info', 'message-replied', { reply: replyText, fallback: true });
  }
}

export type { ActiveRuns, RunExecutor, SessionCatalog, SessionStore };
