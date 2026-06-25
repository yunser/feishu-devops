import type { AppConfig } from '../config/schema';
import { getDefaultReply } from '../config/schema';

/**
 * 根据消息内容生成固定回复。
 * - ping（忽略大小写、首尾空白）→ pong
 * - 其他 → 配置的 defaultReply（默认 hello world）
 */
export function buildFixedReply(content: string, cfg: AppConfig): string {
  const trimmed = content.trim().toLowerCase();
  if (trimmed === 'ping') {
    return 'pong';
  }
  return getDefaultReply(cfg);
}
