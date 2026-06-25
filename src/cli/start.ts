import dns from 'node:dns';
import { startChannel } from '../bot/channel';
import { WorkspaceStore } from '../workspace/store';
import { resolveConfig } from './bootstrap';

dns.setDefaultResultOrder('ipv4first');

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

export interface StartOptions {
  config?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const { cfg } = await resolveConfig(opts);
  const workspaces = new WorkspaceStore();
  await workspaces.load();
  const bridge = await startChannel(cfg, { workspaces });

  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal}，正在断开连接…`);
    try {
      await bridge.disconnect();
    } catch (err) {
      console.error('断开连接时出错:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise<void>(() => {});
}
