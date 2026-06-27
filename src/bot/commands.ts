import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { AgentRuntimeState, SwitchableAgentKind } from './agent-switch';
import { switchRuntimeAgent } from './agent-switch';
import { cwdCard, helpCard, resumeCard, statusCard } from '../card/templates';
import type { FullAppConfig } from '../config/agent-config';
import { accessToClaudePermissionMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import type { AppConfig } from '../config/schema';
import { getCmdTimeoutMs, isCmdEnabled } from '../config/schema';
import { resolveWorkingDirectory } from '../policy/workspace';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type { ActiveRuns } from './active-runs';
import { normalizeCommandInput } from './command-content';
import { runShellWithProgress } from './cmd-runner';
import {
  chatScope,
  effectiveCwd,
  expandTilde,
  isAbsoluteOrTilde,
  storedCwd,
} from './cwd';
import { createBoundChat, defaultChatName } from './group';
import type { ProcessPool } from './process-pool';
import { formatShellResult, runShellCommand } from './run-shell';
import { buildSendOpts, streamMarkdownReply } from './stream-reply';

export interface CommandContext {
  channel: LarkChannel;
  cfg: AppConfig;
  fullCfg?: FullAppConfig;
  profileConfig?: ProfileConfig;
  msg: NormalizedMessage;
  scope: string;
  workspaces: WorkspaceStore;
  activeRuns?: ActiveRuns;
  sessions?: SessionStore;
  sessionCatalog?: SessionCatalog;
  agent?: AgentAdapter;
  processPool?: ProcessPool;
  runtime?: AgentRuntimeState;
  activePolicyFingerprints?: Map<string, string>;
  fromCardAction?: boolean;
}

type Handler = (args: string, ctx: CommandContext) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  '/cmd': handleCmd,
  '/cwd': handleCwd,
  '/help': handleHelp,
  '/new': handleNew,
  '/reset': handleReset,
  '/stop': handleStop,
  '/status': handleStatus,
  '/resume': handleResume,
  '/use': handleSwitch,
};

const CARD_HANDLERS: Record<string, Handler> = {
  help: handleHelp,
  status: handleStatus,
  new: handleNew,
  reset: handleReset,
  resume: handleResume,
  stop: handleStop,
  'cwd.view': handleCwdViewCard,
};

export async function tryHandleCommand(ctx: CommandContext): Promise<boolean> {
  const input = normalizeCommandInput(ctx.msg);
  const scope = ctx.scope || chatScope(ctx.msg);
  ctx.scope = scope;

  if (input.startsWith('$')) {
    await handleCmd(input.slice(1).trim(), ctx);
    return true;
  }

  if (!input.startsWith('/')) return false;

  const parts = input.split(/\s+/);
  const cmd = parts[0] ?? '';
  const args = input.slice(cmd.length).trim();
  const handler = HANDLERS[cmd];
  if (!handler) {
    await replyText(ctx, `未知命令 \`${cmd}\`，发送 /help 查看可用命令。`);
    return true;
  }

  await handler(args, ctx);
  return true;
}

/** 卡片按钮回调入口，cmd 不带前导 `/`。 */
export async function runCommandHandler(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const firstArg = args.split(/\s+/)[0] ?? '';
  const restArgs = args.includes(' ') ? args.slice(args.indexOf(' ') + 1).trim() : '';
  const dottedKey = firstArg ? `${name}.${firstArg}` : name;

  if (dottedKey === 'resume.use') {
    await handleResumeUse(restArgs, ctx);
    return true;
  }

  const dottedHandler = CARD_HANDLERS[dottedKey];
  if (dottedHandler) {
    await dottedHandler(restArgs, ctx);
    return true;
  }

  const handler = CARD_HANDLERS[name];
  if (!handler) return false;
  await handler(args, ctx);
  return true;
}

async function handleCmd(args: string, ctx: CommandContext): Promise<void> {
  if (!isCmdEnabled(ctx.cfg)) {
    await replyText(ctx, '❌ shell 命令已禁用。可在配置中设置 preferences.cmdEnabled = true');
    return;
  }

  if (!args) {
    await replyText(ctx, '用法: /cmd <shell 命令> 或 $ <shell 命令>\n示例: $ pwd');
    return;
  }

  const cwd = effectiveCwd(ctx.workspaces, ctx.scope);

  try {
    await streamMarkdownReply(ctx.channel, ctx.msg.chatId, ctx.msg, async (writer) => {
      const finalText = await runShellWithProgress(args, ctx.cfg, (status) =>
        writer.setContent(status),
      cwd);
      await writer.setContent(finalText);
    });
  } catch (err) {
    console.warn('[cmd] stream failed, falling back to plain send:', err);
    const result = await runShellCommand(args, {
      cwd,
      timeoutMs: getCmdTimeoutMs(ctx.cfg),
    });
    await replyMarkdown(ctx, formatShellResult(args, result));
  }
}

async function handleCwd(args: string, ctx: CommandContext): Promise<void> {
  const input = args.trim();

  if (!input) {
    await replyText(ctx, '用法:\n/cwd <绝对路径>  设置当前会话工作目录\n/cwd view        查看当前会话工作目录');
    return;
  }

  if (input === 'view') {
    await handleCwdViewCard('', ctx);
    return;
  }

  if (!isAbsoluteOrTilde(input)) {
    await replyText(ctx, '请使用绝对路径，或 `~/xxx` 表示 home 下的子路径。');
    return;
  }

  const workspace = await resolveWorkingDirectory(expandTilde(input));
  if (!workspace.ok) {
    await replyText(ctx, workspace.userVisible);
    return;
  }

  ctx.workspaces.setCwd(ctx.scope, workspace.cwdRealpath);
  await replyMarkdown(ctx, `✓ 已设置工作目录为 \`${workspace.cwdRealpath}\``);
}

async function handleCwdViewCard(_args: string, ctx: CommandContext): Promise<void> {
  const saved = storedCwd(ctx.workspaces, ctx.scope);
  const effective = effectiveCwd(ctx.workspaces, ctx.scope);
  const card = cwdCard(saved, effective);
  await sendCard(ctx, card);
}

async function handleNew(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();

  if (trimmed === 'chat' || trimmed.startsWith('chat ')) {
    const rawName = trimmed === 'chat' ? '' : trimmed.slice(5).trim();
    return handleNewChat(rawName, ctx);
  }

  if (trimmed) {
    await replyText(ctx, '用法: /new 或 /new chat [群名称]');
    return;
  }

  await clearSession(ctx);
}

async function handleReset(args: string, ctx: CommandContext): Promise<void> {
  if (args.trim()) {
    await replyText(ctx, '用法: /reset（清除当前会话 agent 上下文）');
    return;
  }
  await clearSession(ctx);
}

async function clearSession(ctx: CommandContext): Promise<void> {
  const wasRunning = ctx.activeRuns?.interrupt(ctx.scope) ?? false;
  ctx.sessions?.clear(ctx.scope);
  archiveCatalogForScope(ctx);
  const text = wasRunning ? '已中断当前任务并开始新会话。' : '已开始新会话。';
  if (ctx.fromCardAction) {
    await replyMarkdown(ctx, text);
  } else {
    await replyMarkdown(ctx, `✓ ${text}`);
  }
}

async function handleNewChat(rawName: string, ctx: CommandContext): Promise<void> {
  const botLabel = ctx.channel.botIdentity?.name ?? ctx.agent?.displayName ?? '测试群';
  const name = rawName || defaultChatName(botLabel);
  const sourceCwd = storedCwd(ctx.workspaces, ctx.scope);

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

  if (sourceCwd) {
    ctx.workspaces.setCwd(created.chatId, sourceCwd);
  }

  const welcome = sourceCwd
    ? `🎉 群已建好，工作目录继承自原会话：\`${sourceCwd}\`\n\n@我 + 任意消息开始对话。`
    : '🎉 群已建好。\n\n@我 + 任意消息开始对话。';
  try {
    await ctx.channel.send(created.chatId, { markdown: welcome });
  } catch (err) {
    console.warn('[new-chat] welcome message failed:', err);
  }

  await replyMarkdown(ctx, `✓ 已创建群 **${created.name}**，去新群里继续。`);
}

async function handleHelp(_args: string, ctx: CommandContext): Promise<void> {
  const card = helpCard(ctx.agent?.displayName ?? 'Agent');
  await sendCard(ctx, card);
}

async function handleStatus(_args: string, ctx: CommandContext): Promise<void> {
  const profile = ctx.profileConfig;
  const cwd = storedCwd(ctx.workspaces, ctx.scope);
  const effective = effectiveCwd(ctx.workspaces, ctx.scope);
  const sess = ctx.sessions?.getRaw(ctx.scope);
  const isCodex = profile?.agentKind === 'codex';
  const usesSessionStore = !isCodex;
  const catalogEntry =
    isCodex && ctx.sessionCatalog
      ? ctx.sessionCatalog.entries().find(
          (e) => e.scopeId === ctx.scope && e.status === 'active' && e.agentId === 'codex',
        )
      : undefined;

  const card = statusCard({
    cwd,
    effectiveCwd: effective,
    sessionId: isCodex ? catalogEntry?.threadId : sess?.sessionId,
    sessionStale: usesSessionStore && Boolean(cwd && sess && sess.cwd !== cwd),
    agentName: resolveStatusAgentName(ctx),
    runtimeAccess: runtimeAccessStatus(profile),
    activeRun: Boolean(ctx.activeRuns?.get(ctx.scope)),
    queue: ctx.processPool?.snapshot(),
    scope: ctx.scope,
    chatMode: ctx.msg.chatType === 'p2p' ? 'p2p' : 'group',
  });
  await sendCard(ctx, card);
}

async function handleResume(args: string, ctx: CommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const rest = parts.slice(1).join(' ').trim();

  if (sub === 'use' && rest) {
    return handleResumeUse(rest, ctx);
  }

  const cwd = storedCwd(ctx.workspaces, ctx.scope) ?? effectiveCwd(ctx.workspaces, ctx.scope);
  const sess = ctx.sessions?.getRaw(ctx.scope);
  const profile = ctx.profileConfig;
  const isCodex = profile?.agentKind === 'codex';
  const catalogEntry =
    isCodex && ctx.sessionCatalog
      ? ctx.sessionCatalog.entries().find(
          (e) => e.scopeId === ctx.scope && e.status === 'active' && e.agentId === 'codex',
        )
      : undefined;

  const sessionId = isCodex ? catalogEntry?.threadId : sess?.sessionId;
  const entries = sessionId
    ? [
        {
          sessionId,
          preview: isCodex
            ? '当前 Codex thread'
            : profile?.agentKind === 'cursor'
              ? '当前 Cursor 会话'
              : profile?.agentKind === 'pi'
                ? '当前 Pi 会话'
                : '当前 Claude 会话',
          relTime: '当前',
          current: true,
        },
      ]
    : [];

  const card = resumeCard(cwd, entries);
  await sendCard(ctx, card);
}

async function handleResumeUse(sessionId: string, ctx: CommandContext): Promise<void> {
  const profile = ctx.profileConfig;
  const cwd = storedCwd(ctx.workspaces, ctx.scope) ?? effectiveCwd(ctx.workspaces, ctx.scope);

  if (!sessionId) {
    await replyText(ctx, '请指定要恢复的 session id。');
    return;
  }

  ctx.activeRuns?.interrupt(ctx.scope);

  if (profile?.agentKind === 'codex') {
    const entry = ctx.sessionCatalog?.entries().find(
      (e) =>
        e.scopeId === ctx.scope &&
        e.status === 'active' &&
        e.agentId === 'codex' &&
        e.threadId === sessionId,
    );
    if (entry) {
      await replyMarkdown(ctx, '✓ 已恢复 Codex thread，请继续发送消息。');
      return;
    }
    await replyText(ctx, '未找到可恢复的 Codex thread，请先完成一次对话。');
    return;
  }

  ctx.sessions?.set(ctx.scope, sessionId, cwd);
  const agentLabel =
    profile?.agentKind === 'cursor' ? 'Cursor' : profile?.agentKind === 'pi' ? 'Pi' : 'Claude';
  await replyMarkdown(ctx, `✓ 已恢复 ${agentLabel} 会话，请继续发送消息。`);
}

async function handleStop(_args: string, ctx: CommandContext): Promise<void> {
  const ok = ctx.activeRuns?.interrupt(ctx.scope) ?? false;
  if (!ok && !ctx.fromCardAction) {
    await replyText(ctx, '当前没有正在运行的 agent。');
  }
}

async function handleSwitch(args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.runtime || !ctx.processPool || !ctx.activeRuns || !ctx.sessions || !ctx.sessionCatalog) {
    await replyText(ctx, '当前环境不支持切换 agent。');
    return;
  }

  const kind = args.trim().toLowerCase();
  if (!isSwitchableAgentKind(kind)) {
    await replyText(ctx, '用法: `/use claude` | `/use codex` | `/use cursor` | `/use pi`');
    return;
  }

  const current = ctx.runtime.fullCfg.agentKind ?? 'claude';
  if (kind === current) {
    await replyMarkdown(
      ctx,
      `当前已是 **${ctx.runtime.agent?.displayName ?? kind}**，无需切换。`,
    );
    return;
  }

  const result = await switchRuntimeAgent({
    kind,
    runtime: ctx.runtime,
    pool: ctx.processPool,
    activeRuns: ctx.activeRuns,
    channel: ctx.channel,
    sessions: ctx.sessions,
    sessionCatalog: ctx.sessionCatalog,
    activePolicyFingerprints: ctx.activePolicyFingerprints,
  });

  if (!result.ok) {
    await replyText(ctx, `❌ 切换失败：${result.message}`);
    return;
  }

  await replyMarkdown(
    ctx,
    `✓ 已切换到 **${result.displayName}**（原 ${current}）。\n\n` +
      '已中断进行中的任务并清空 agent 会话上下文；工作目录不变。',
  );
}

function isSwitchableAgentKind(value: string): value is SwitchableAgentKind {
  return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'pi';
}

function resolveStatusAgentName(ctx: CommandContext): string {
  if (ctx.runtime?.agentUnavailable) {
    const kind = ctx.profileConfig?.agentKind ?? 'agent';
    return `${kind}（不可用）`;
  }
  return ctx.agent?.displayName ?? ctx.profileConfig?.agentKind ?? 'unknown';
}

function runtimeAccessStatus(
  profile: ProfileConfig | undefined,
): { label: string; value: string } {
  if (!profile) return { label: 'access', value: 'unknown' };
  if (profile.agentKind === 'claude') {
    return {
      label: 'permission',
      value: accessToClaudePermissionMode(
        profile.permissions.defaultAccess,
        profile.permissions,
      ),
    };
  }
  if (profile.agentKind === 'cursor') {
    return { label: 'mode', value: 'force' };
  }
  if (profile.agentKind === 'pi') {
    return { label: 'mode', value: 'json' };
  }
  return {
    label: 'sandbox',
    value: `${profile.sandbox.defaultMode}/${profile.sandbox.maxMode}`,
  };
}

function archiveCatalogForScope(ctx: CommandContext): void {
  if (!ctx.sessionCatalog) return;
  for (const entry of ctx.sessionCatalog.entries()) {
    if (entry.scopeId === ctx.scope && entry.status === 'active') {
      ctx.sessionCatalog.archiveActive({
        scopeId: entry.scopeId,
        agentId: entry.agentId,
        cwdRealpath: entry.cwdRealpath,
        policyFingerprint: entry.policyFingerprint,
      });
    }
  }
}

async function sendCard(ctx: CommandContext, card: object): Promise<void> {
  const sendOpts = buildSendOpts(ctx.msg);
  try {
    await ctx.channel.send(ctx.msg.chatId, { card }, sendOpts);
  } catch {
    await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
  }
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
