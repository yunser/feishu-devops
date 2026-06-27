import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';

export function buildSendOpts(msg: NormalizedMessage): {
  replyTo: string;
  replyInThread?: boolean;
} {
  return {
    replyTo: msg.messageId,
    ...(msg.threadId ? { replyInThread: true } : {}),
  };
}

export interface MarkdownStreamWriter {
  setContent(text: string): Promise<void>;
}

export interface StreamMarkdownReplyOptions {
  /** 覆盖 SDK 默认的 "Thinking..." 初始文案（仅作用于本次 stream）。 */
  initialText?: string;
}

interface ChannelWithOutboundConfig {
  sender: { config: { streamInitialText?: string } };
}

let streamInitialTextChain: Promise<void> = Promise.resolve();

async function withStreamInitialText(
  channel: LarkChannel,
  initialText: string,
  fn: () => Promise<void>,
): Promise<void> {
  const sender = (channel as unknown as ChannelWithOutboundConfig).sender;
  const config = sender?.config;
  if (!config) {
    await fn();
    return;
  }

  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = streamInitialTextChain;
  streamInitialTextChain = prev.then(() => slot);

  await prev;
  const previous = config.streamInitialText;
  config.streamInitialText = initialText;
  try {
    await fn();
  } finally {
    config.streamInitialText = previous;
    release();
  }
}

/**
 * 流式 markdown 回复：先发一条可编辑消息，producer 内多次 setContent 会原地更新同一条。
 * 参考 lark-coding-agent-bridge 的 markdown stream 模式。
 */
export async function streamMarkdownReply(
  channel: LarkChannel,
  chatId: string,
  msg: NormalizedMessage,
  producer: (writer: MarkdownStreamWriter) => Promise<void>,
  options?: StreamMarkdownReplyOptions,
): Promise<void> {
  const sendOpts = buildSendOpts(msg);
  const run = async () => {
    await channel.stream(
      chatId,
      {
        markdown: async (ctrl) => {
          const writer: MarkdownStreamWriter = {
            setContent: (text) => ctrl.setContent(text),
          };
          await producer(writer);
        },
      },
      sendOpts,
    );
  };

  if (options?.initialText !== undefined) {
    await withStreamInitialText(channel, options.initialText, run);
    return;
  }

  await run();
}
