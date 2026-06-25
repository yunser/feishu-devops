import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface CursorRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  timestamp_ms?: number;
  text?: string;
  message?: { content?: ContentBlock[] };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  is_error?: boolean;
  result?: string;
}

export interface CursorStreamState {
  sawPartialAssistantText: boolean;
}

export function createCursorStreamState(): CursorStreamState {
  return { sawPartialAssistantText: false };
}

export function* translateEvent(
  raw: unknown,
  state: CursorStreamState,
): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CursorRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'thinking' && evt.subtype === 'delta' && typeof evt.text === 'string' && evt.text) {
    yield { type: 'thinking', delta: evt.text };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    const isPartial = typeof evt.timestamp_ms === 'number';
    if (!isPartial && state.sawPartialAssistantText) {
      return;
    }
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        if (isPartial) state.sawPartialAssistantText = true;
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.is_error === true || (evt.subtype && evt.subtype !== 'success')) {
      yield {
        type: 'error',
        message: typeof evt.result === 'string' ? evt.result : 'cursor agent run failed',
        terminationReason: 'failed',
      };
      return;
    }
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.inputTokens,
        outputTokens: evt.usage.outputTokens,
        cachedInputTokens: evt.usage.cacheReadTokens,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}
