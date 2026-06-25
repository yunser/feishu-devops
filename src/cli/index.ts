import { Command } from 'commander';
import pkg from '../../package.json';
import { runStart } from './start';

/**
 * pnpm/npm 传参时常见 `run -- --agent cursor`，中间的 `--` 会让 Commander
 * 把后续 flag 当成 positional args 而忽略，导致 agent 回退到 config 默认值。
 */
function normalizeArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--' && i + 1 < argv.length && argv[i + 1]?.startsWith('-')) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

const program = new Command();

program
  .name('feishu-message-test')
  .description('飞书消息收发测试：扫码创建应用，接收消息并固定内容回复')
  .version(pkg.version, '-v, --version');

program
  .command('run')
  .description('前台运行 bot，接收消息并通过 Claude Code / Codex / Cursor 回复')
  .option('-c, --config <path>', '配置文件路径')
  .option('--app-id <id>', '使用已有飞书应用（跳过扫码创建）')
  .option('--app-secret <secret>', 'App Secret（配合 --app-id）')
  .option('--tenant <tenant>', '租户域名：feishu 或 lark（默认 feishu）')
  .option('--agent <kind>', 'agent 类型：claude / codex / cursor / disabled（默认 claude）')
  .option('--debug', 'Cursor agent 调试：打印 spawn args 与原生 stream-json 事件')
  .action(async (opts: {
    config?: string;
    appId?: string;
    appSecret?: string;
    tenant?: string;
    agent?: string;
    debug?: boolean;
  }) => {
    const agent =
      opts.agent === 'claude' ||
      opts.agent === 'codex' ||
      opts.agent === 'cursor' ||
      opts.agent === 'disabled'
        ? opts.agent
        : undefined;
    await runStart({ ...opts, agent, debug: opts.debug === true });
  });

program.parseAsync(normalizeArgv(process.argv)).catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
