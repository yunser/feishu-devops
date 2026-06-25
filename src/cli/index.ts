import { Command } from 'commander';
import pkg from '../../package.json';
import { runStart } from './start';

const program = new Command();

program
  .name('feishu-message-test')
  .description('飞书消息收发测试：扫码创建应用，接收消息并固定内容回复')
  .version(pkg.version, '-v, --version');

program
  .command('run')
  .description('前台运行 bot，接收消息并固定内容回复')
  .option('-c, --config <path>', '配置文件路径')
  .option('--app-id <id>', '使用已有飞书应用（跳过扫码创建）')
  .option('--app-secret <secret>', 'App Secret（配合 --app-id）')
  .option('--tenant <tenant>', '租户域名：feishu 或 lark（默认 feishu）')
  .action(async (opts: {
    config?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
  }) => {
    await runStart(opts);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
