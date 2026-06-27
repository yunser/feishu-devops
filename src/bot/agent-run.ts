import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability, cursorCapability, piCapability } from '../agent/capability';
import { buildAgentPrompt } from '../agent/prompt';
import type { AgentEvent } from '../agent/types';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import type { FullAppConfig } from '../config/agent-config';
import { toProfileConfig } from '../config/agent-config';
import type { ProfileConfig } from '../config/profile-schema';
import {
  getAgentStopGraceMs,
  getMessageReplyMode,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  type AppConfig,
} from '../config/schema';
import { log, reportMetric } from '../core/logger';
import type { AccessDecision } from '../policy/access';
import type { ScopeContext } from '../policy/run-policy';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type { RunHandle } from './active-runs';
import { chatScope } from './cwd';
import { recordRunSessionEvent, startRunFlow } from './run-flow';

const STREAM_TERMINAL_GRACE_MS = 3000;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

export interface AgentRunDeps {
  channel: LarkChannel;
  cfg: FullAppConfig;
  profileConfig: ProfileConfig;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  activePolicyFingerprints: Map<string, string>;
}

/** feishu-devops 默认开放访问（不做 allowlist 拦截）。 */
function openAccess(): AccessDecision {
  return { ok: true, reason: 'allowed-user' };
}

export async function runAgentMessage(deps: AgentRunDeps, msg: NormalizedMessage): Promise<void> {
  const {
    channel,
    cfg,
    profileConfig,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    activePolicyFingerprints,
  } = deps;

  const scope = chatScope(msg);
  const prompt = buildPrompt(msg, channel.botIdentity);
  log.info('prompt', 'built', { promptChars: prompt.length });

  const sendOpts = {
    replyTo: msg.messageId,
    ...(msg.threadId ? { replyInThread: true } : {}),
  };

  const capability =
    profileConfig.agentKind === 'codex'
      ? codexCapability(profileConfig)
      : profileConfig.agentKind === 'cursor'
        ? cursorCapability(profileConfig)
        : profileConfig.agentKind === 'pi'
          ? piCapability(profileConfig)
          : claudeCapability(profileConfig);

  const scopeContext: ScopeContext = {
    source: 'im',
    chatId: msg.chatId,
    actorId: msg.senderId,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
  };

  const flow = await startRunFlow({
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: [],
    access: openAccess(),
    capability,
    profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(cfg),
    observability: {
      profile: 'default',
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });

  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    await channel.send(msg.chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { execution } = flow;
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  const eventStream = execution.subscribe();

  const recordSession = (evt: AgentEvent): void => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
  };

  const idleTimeoutMs = getRunIdleTimeoutMs(cfg);
  const replyMode = getMessageReplyMode(cfg);
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };

  try {
    if (replyMode === 'card') {
      await runCardReply(channel, msg, handle, eventStream, scope, idleTimeoutMs, recordSession, filterForPrefs);
    } else if (replyMode === 'markdown') {
      await runMarkdownReply(channel, msg, handle, eventStream, scope, idleTimeoutMs, recordSession, filterForPrefs);
    } else {
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
      );
      const body = renderText(filterForPrefs(finalState));
      if (body.trim()) {
        await channel.send(msg.chatId, { markdown: body }, sendOpts);
      }
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    activePolicyFingerprints.delete(scope);
  }
}

async function runMarkdownReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  handle: RunHandle,
  eventStream: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  filterForPrefs: (state: RunState) => RunState,
): Promise<void> {
  const sendOpts = {
    replyTo: msg.messageId,
    ...(msg.threadId ? { replyInThread: true } : {}),
  };
  let latestState: RunState = initialState;
  let producerStarted = false;
  let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
  const renderDone = processAgentStream(
    handle,
    eventStream,
    scope,
    idleTimeoutMs,
    recordSession,
    async (state) => {
      latestState = state;
      if (markdownCtrl) {
        await markdownCtrl.setContent(renderText(filterForPrefs(state)));
      }
    },
  );
  const streamDone = channel.stream(
    msg.chatId,
    {
      markdown: async (ctrl) => {
        producerStarted = true;
        markdownCtrl = ctrl;
        await ctrl.setContent(renderText(filterForPrefs(latestState)));
        await renderDone;
        await ctrl.setContent(renderText(filterForPrefs(latestState)));
      },
    },
    sendOpts,
  );
  await awaitRenderAwareStream({
    mode: 'markdown',
    streamDone,
    renderDone,
    producerStarted: () => producerStarted,
    fallback: async (state) => {
      const body = renderText(filterForPrefs(state));
      if (body.trim()) {
        await channel.send(msg.chatId, { markdown: body }, sendOpts);
      }
    },
  });
}

async function runCardReply(
  channel: LarkChannel,
  msg: NormalizedMessage,
  handle: RunHandle,
  eventStream: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  filterForPrefs: (state: RunState) => RunState,
): Promise<void> {
  const sendOpts = {
    replyTo: msg.messageId,
    ...(msg.threadId ? { replyInThread: true } : {}),
  };
  let latestState: RunState = initialState;
  let producerStarted = false;
  let cardCtrl:
    | { update(next: object | ((current: object) => object)): Promise<void> }
    | undefined;
  const renderDone = processAgentStream(
    handle,
    eventStream,
    scope,
    idleTimeoutMs,
    recordSession,
    async (state) => {
      latestState = state;
      if (cardCtrl) {
        await cardCtrl.update(renderCard(filterForPrefs(state)));
      }
    },
  );
  const streamDone = channel.stream(
    msg.chatId,
    {
      card: {
        initial: renderCard(initialState),
        producer: async (ctrl) => {
          producerStarted = true;
          cardCtrl = ctrl;
          await ctrl.update(renderCard(filterForPrefs(latestState)));
          await renderDone;
          await ctrl.update(renderCard(filterForPrefs(latestState)));
        },
      },
    },
    sendOpts,
  );
  await awaitRenderAwareStream({
    mode: 'card',
    streamDone,
    renderDone,
    producerStarted: () => producerStarted,
    fallback: async (state) => {
      await channel.send(msg.chatId, { card: renderCard(filterForPrefs(state)) }, sendOpts);
    },
  });
}

function buildPrompt(
  msg: NormalizedMessage,
  botIdentity?: { openId: string; name?: string },
): string {
  const text = msg.content.trim();
  const userPart =
    text ||
    '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  return buildAgentPrompt({
    context: {
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      ...(msg.senderName ? { senderName: msg.senderName } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      messageIds: [msg.messageId],
      source: 'im',
    },
    instructions: BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
  });
}

async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState) => Promise<void>,
): Promise<RunState> {
  const runStart = Date.now();
  let state: RunState = initialState;

  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {});
    }, idleTimeoutMs);
  };
  armOrPauseIdle();

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;

      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        recordSession(evt);
        continue;
      }
      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          if (costUsd !== undefined) reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        continue;
      }

      state = reduce(state, evt);
      await flush(state);
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  streamDone: Promise<unknown>;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  fallback: (state: RunState) => Promise<void>;
}): Promise<void> {
  const streamResult = input.streamDone.then(
    () => ({ kind: 'stream' as const, ok: true as const }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await input.fallback(rendered.state);
      return;
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return;
  }

  if (!input.producerStarted()) {
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await input.fallback(first.state);
    return;
  }

  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);
  if (!terminal) {
    log.warn('stream', 'terminal-grace-expired', {
      mode: input.mode,
      graceMs: STREAM_TERMINAL_GRACE_MS,
    });
    return;
  }
  if (!terminal.ok) throw terminal.err;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAgentEnabled(cfg: FullAppConfig): boolean {
  return cfg.agentKind !== 'disabled';
}

export { toProfileConfig };
