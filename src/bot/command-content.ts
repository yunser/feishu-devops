import type { NormalizedMessage } from '@larksuite/channel';

/** 去掉 @ 占位符，便于在群里解析 `/cmd ...` 或 `$ ...`。 */
export function normalizeCommandInput(msg: NormalizedMessage): string {
  let text = msg.content.trim();
  for (const mention of msg.mentions ?? []) {
    if (mention.key) {
      text = text.replaceAll(mention.key, ' ');
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}
