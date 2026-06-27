import type { AgentEvent } from '../types';

interface PiSessionHeader {
  type: 'session';
  id?: string;
  cwd?: string;
}

interface PiAssistantMessageEvent {
  type?: string;
  delta?: string;
  toolCall?: {
    id?: string;
    name?: string;
    arguments?: unknown;
  };
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: { total?: number };
}

interface PiMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
  model?: string;
}

interface PiRawEvent {
  type?: string;
  id?: string;
  cwd?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: PiMessage;
  messages?: PiMessage[];
  assistantMessageEvent?: PiAssistantMessageEvent;
  success?: boolean;
  finalError?: string;
}

export interface PiStreamState {
  sawPartialAssistantText: boolean;
  emittedToolCalls: Set<string>;
  sessionId?: string;
  cwd?: string;
  doneEmitted: boolean;
}

export function createPiStreamState(): PiStreamState {
  return {
    sawPartialAssistantText: false,
    emittedToolCalls: new Set(),
    doneEmitted: false,
  };
}

export function* translateEvent(raw: unknown, state: PiStreamState): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as PiRawEvent;

  if (evt.type === 'session') {
    const header = evt as PiSessionHeader;
    state.sessionId = header.id;
    state.cwd = header.cwd;
    yield {
      type: 'system',
      sessionId: header.id,
      cwd: header.cwd,
    };
    return;
  }

  if (evt.type === 'message_update' && evt.assistantMessageEvent) {
    const assistantEvt = evt.assistantMessageEvent;
    if (assistantEvt.type === 'text_delta' && typeof assistantEvt.delta === 'string' && assistantEvt.delta) {
      state.sawPartialAssistantText = true;
      yield { type: 'text', delta: assistantEvt.delta };
      return;
    }
    if (
      assistantEvt.type === 'thinking_delta' &&
      typeof assistantEvt.delta === 'string' &&
      assistantEvt.delta
    ) {
      yield { type: 'thinking', delta: assistantEvt.delta };
      return;
    }
    if (assistantEvt.type === 'toolcall_end' && assistantEvt.toolCall) {
      yield* emitToolUse(
        assistantEvt.toolCall.id,
        assistantEvt.toolCall.name,
        assistantEvt.toolCall.arguments,
        state,
      );
    }
    return;
  }

  if (evt.type === 'tool_execution_start' && evt.toolCallId && evt.toolName) {
    yield* emitToolUse(evt.toolCallId, evt.toolName, evt.args, state);
    return;
  }

  if (evt.type === 'tool_execution_end' && evt.toolCallId) {
    const output =
      typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result ?? '');
    yield {
      type: 'tool_result',
      id: evt.toolCallId,
      output,
      isError: evt.isError === true,
    };
    return;
  }

  if (evt.type === 'message_end' && evt.message?.role === 'assistant') {
    const message = evt.message;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      yield {
        type: 'error',
        message: message.errorMessage || `pi agent run ${message.stopReason}`,
        terminationReason: message.stopReason === 'aborted' ? 'interrupted' : 'failed',
      };
    }
    return;
  }

  if (evt.type === 'turn_end' && evt.message?.role === 'assistant') {
    yield* emitUsage(evt.message.usage);
    return;
  }

  if (evt.type === 'agent_end') {
    const lastAssistant = [...(evt.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant');
    if (lastAssistant?.usage) {
      yield* emitUsage(lastAssistant.usage);
    }
    if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
      yield {
        type: 'error',
        message: lastAssistant.errorMessage || `pi agent run ${lastAssistant.stopReason}`,
        terminationReason: lastAssistant.stopReason === 'aborted' ? 'interrupted' : 'failed',
      };
      return;
    }
    if (!state.doneEmitted) {
      state.doneEmitted = true;
      yield {
        type: 'done',
        sessionId: state.sessionId,
        terminationReason: 'normal',
      };
    }
  }
}

function* emitToolUse(
  id: string | undefined,
  name: string | undefined,
  input: unknown,
  state: PiStreamState,
): Generator<AgentEvent> {
  if (!id || !name || state.emittedToolCalls.has(id)) return;
  state.emittedToolCalls.add(id);
  yield { type: 'tool_use', id, name, input };
}

function* emitUsage(usage: PiUsage | undefined): Generator<AgentEvent> {
  if (!usage) return;
  yield {
    type: 'usage',
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead,
    costUsd: usage.cost?.total,
  };
}
