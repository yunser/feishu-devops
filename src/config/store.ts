import { readFile } from 'node:fs/promises';
import type { AppConfig } from './schema';
import type { FullAppConfig } from './agent-config';
import { paths } from './paths';
import { writeFileAtomic } from '../platform/atomic-write';

export async function loadConfig(path: string = paths.configFile): Promise<Partial<FullAppConfig>> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as Partial<FullAppConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveConfig(cfg: AppConfig | FullAppConfig, path: string = paths.configFile): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}
