import type { LarkChannel } from '@larksuite/channel';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId: string;
  description?: string;
}

export interface CreatedChat {
  chatId: string;
  name: string;
}

/**
 * 创建仅含 bot 与指定用户的私人群聊。需要 bot 具备 `im:chat` 权限。
 */
export async function createBoundChat(opts: CreateBoundChatOptions): Promise<CreatedChat> {
  const { channel, name, inviteOpenId, description } = opts;
  const { chatId } = await channel.createChat({
    name,
    description,
    inviteUserIds: [inviteOpenId],
    userIdType: 'open_id',
  });
  return { chatId, name };
}

export function defaultChatName(label = '测试群'): string {
  const d = new Date();
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return `${label} · ${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
