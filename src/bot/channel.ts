import type { LarkChannel, LarkChannelOptions, NormalizedMessage } from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import type { AppConfig } from '../config/schema';
import { getRequireMentionInGroup } from '../config/schema';
import { tryHandleCommand } from './commands';
import { buildFixedReply } from './reply';

export interface BotChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

function log(level: 'info' | 'warn' | 'error', phase: string, detail?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = detail ? ` ${JSON.stringify(detail)}` : '';
  console[level](`[${ts}] ${phase}${extra}`);
}

export async function startChannel(cfg: AppConfig): Promise<BotChannel> {
  const { app } = cfg.accounts;

  const opts: LarkChannelOptions = {
    appId: app.id,
    appSecret: app.secret,
    domain:
      app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'feishu-message-test',
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
  };

  const channel = createLarkChannel(opts);
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      try {
        await handleMessage(channel, cfg, msg);
      } catch (err) {
        log('error', 'message-handler-failed', {
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

  const identity = channel.botIdentity;
  log('info', 'ws-connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    appId: app.id,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  return {
    channel,
    disconnect: async () => {
      await channel.disconnect();
    },
  };
}

async function handleMessage(
  channel: LarkChannel,
  cfg: AppConfig,
  msg: NormalizedMessage,
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

  const handled = await tryHandleCommand({ channel, cfg, msg });
  if (handled) {
    log('info', 'command-handled');
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
