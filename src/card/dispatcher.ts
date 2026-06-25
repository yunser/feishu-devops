import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';
import type { ProcessPool } from '../bot/process-pool';
import type { ActiveRuns } from '../bot/active-runs';
import type { AgentRuntimeState } from '../bot/agent-switch';
import { runCommandHandler, type CommandContext } from '../bot/commands';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { chatScope } from '../bot/cwd';

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  runtime: AgentRuntimeState;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  processPool?: ProcessPool;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (!cmd) return;

  log.info('cardAction', 'cmd', { cmd, chatId: deps.evt.chatId });

  const msg = makeFakeMsg(deps.evt);
  const ctx: CommandContext = {
    channel: deps.channel,
    cfg: deps.runtime.fullCfg,
    fullCfg: deps.runtime.fullCfg,
    profileConfig: deps.runtime.profileConfig,
    msg,
    scope: chatScope(msg),
    workspaces: deps.workspaces,
    activeRuns: deps.activeRuns,
    sessions: deps.sessions,
    sessionCatalog: deps.sessionCatalog,
    agent: deps.runtime.agent,
    processPool: deps.processPool,
    runtime: deps.runtime,
    fromCardAction: true,
  };

  const [name, ...rest] = cmd.split('.');
  const sub = rest.join(' ');
  const args = composeArgs(sub, payload);

  try {
    const ok = await runCommandHandler(name ?? '', args, ctx);
    if (!ok) {
      log.warn('cardAction', 'unknown', { cmd });
      await deps.channel.send(deps.evt.chatId, {
        markdown: `未知操作 \`${cmd}\`，请发送 /help 查看可用命令。`,
      });
    }
  } catch (err) {
    log.fail('cardAction', err, { cmd });
  }
}

function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(evt: CardActionEvent): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
