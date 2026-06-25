import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { writeFileAtomic } from '../platform/atomic-write';

interface WorkspaceData {
  chats: Record<string, { cwd: string }>;
}

/** 按 chatId 持久化工作目录；单聊与各群互不影响。 */
export class WorkspaceStore {
  private data: WorkspaceData = { chats: {} };
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.workspacesFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<WorkspaceData>;
      this.data = { chats: parsed.chats ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return this.data.chats[chatId]?.cwd;
  }

  setCwd(chatId: string, cwd: string): void {
    this.data.chats[chatId] = { cwd };
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        console.error('[workspace] persist failed:', err);
      });
  }
}
