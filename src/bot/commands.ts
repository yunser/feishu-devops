import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AppConfig } from '../config/schema';
import { getCmdTimeoutMs, isCmdEnabled } from '../config/schema';
import { normalizeCommandInput } from './command-content';
import { runShellWithProgress } from './cmd-runner';
import { createBoundChat, defaultChatName } from './group';
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
  '/new': handleNew,
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

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  await replyText(ctx, '用法: /new chat [群名称]');
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const botLabel = ctx.channel.botIdentity?.name ?? '测试群';
  const name = rawName || defaultChatName(botLabel);

  let created;
  try {
    created = await createBoundChat({
      channel: ctx.channel,
      name,
      inviteOpenId: ctx.msg.senderId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await replyText(ctx, `❌ 创建群失败：${msg}\n\n确认 bot 已开启 \`im:chat\` 权限。`);
    return;
  }

  try {
    await ctx.channel.send(created.chatId, {
      markdown: '🎉 群已建好。\n\n@我 + 任意消息开始对话。',
    });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await replyMarkdown(ctx, `✓ 已创建群 **${created.name}**，去新群里继续。`);
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const lines = [
    '可用命令:',
    '/cmd <shell>       在本机执行 shell 命令并返回输出',
    '/new chat [名称]   新建群聊并自动拉你进群',
    '/help              显示此帮助',
    '',
    '示例: /cmd pwd',
    '示例: /new chat 开发测试群',
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

async function replyMarkdown(ctx: CommandContext, markdown: string): Promise<void> {
  const sendOpts = buildSendOpts(ctx.msg);

  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, sendOpts);
  } catch {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  }
}
