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

/**
 * 流式 markdown 回复：先发一条可编辑消息，producer 内多次 setContent 会原地更新同一条。
 * 参考 lark-coding-agent-bridge 的 markdown stream 模式。
 */
export async function streamMarkdownReply(
  channel: LarkChannel,
  chatId: string,
  msg: NormalizedMessage,
  producer: (writer: MarkdownStreamWriter) => Promise<void>,
): Promise<void> {
  const sendOpts = buildSendOpts(msg);
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
}
