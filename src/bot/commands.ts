import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AppConfig } from '../config/schema';
import { getCmdTimeoutMs, isCmdEnabled } from '../config/schema';
import { normalizeCommandInput } from './command-content';
import { runShellWithProgress } from './cmd-runner';
import { formatShellResult, runShellCommand } from './run-shell';
import { buildSendOpts, streamMarkdownReply } from './stream-reply';

export interface CommandContext {
  channel: LarkChannel;
  cfg: AppConfig;
  msg: NormalizedMessage;
}

const HANDLERS: Record<string, (args: string, ctx: CommandContext) => Promise<void>> = {
  '/cmd': handleCmd,
  '/help': handleHelp,
};

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const input = normalizeCommandInput(ctx.msg);
  if (!input.startsWith('/')) return false;

  const parts = input.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = input.slice(cmd.length).trim();
  const handler = HANDLERS[cmd];
  if (!handler) return false;

  await handler(args, ctx);
  return true;
}

async function handleCmd(args: string, ctx: CommandContext): Promise<void> {
  if (!isCmdEnabled(ctx.cfg)) {
    await replyText(ctx, '❌ /cmd 已禁用。可在配置中设置 preferences.cmdEnabled = true');
    return;
  }

  if (!args) {
    await replyText(ctx, '用法: /cmd <shell 命令>\n示例: /cmd pwd');
    return;
  }

  try {
    await streamMarkdownReply(ctx.channel, ctx.msg.chatId, ctx.msg, async (writer) => {
      const finalText = await runShellWithProgress(args, ctx.cfg, (status) =>
        writer.setContent(status),
      );
      await writer.setContent(finalText);
    });
  } catch (err) {
    console.warn('[cmd] stream failed, falling back to plain send:', err);
    const result = await runShellCommand(args, { timeoutMs: getCmdTimeoutMs(ctx.cfg) });
    await replyText(ctx, formatShellResult(args, result));
  }
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const lines = [
    '可用命令:',
    '/cmd <shell>  在本机执行 shell 命令并返回输出',
    '/help         显示此帮助',
    '',
    '示例: /cmd pwd',
    '示例: /cmd sleep 3s',
  ];
  if (!isCmdEnabled(ctx.cfg)) {
    lines.push('', '注意: /cmd 当前已禁用');
  }
  await replyText(ctx, lines.join('\n'));
}

async function replyText(ctx: CommandContext, text: string): Promise<void> {
  const sendOpts = buildSendOpts(ctx.msg);

  try {
    await ctx.channel.send(ctx.msg.chatId, { text }, sendOpts);
  } catch {
    await ctx.channel.send(ctx.msg.chatId, { text }, { replyTo: ctx.msg.messageId });
  }
}
