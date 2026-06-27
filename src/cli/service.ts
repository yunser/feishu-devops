import { isComplete } from '../config/schema';
import { paths } from '../config/paths';
import { daemonStderrPath, daemonStdoutPath } from '../daemon/paths';
import { getServiceAdapter, type ServiceAdapter } from '../daemon/service-adapter';
import { resolveConfig } from './bootstrap';

export interface ServiceStartOptions {
  config?: string;
  appId?: string;
  appSecret?: string;
  tenant?: string;
  agent?: 'claude' | 'codex' | 'cursor' | 'disabled';
  debug?: boolean;
}

function requireAdapter(cmdName: string, extraRunArgs: string[]): ServiceAdapter {
  const adapter = getServiceAdapter(extraRunArgs);
  if (!adapter) {
    console.error(`${cmdName}: 当前系统不支持后台运行。`);
    console.error('  目前支持: macOS (launchd) / Linux (systemd) / Windows (Task Scheduler)');
    process.exit(1);
  }
  return adapter;
}

function formatServiceStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/re-running the command as root/i.test(line))
    .join('\n')
    .trim();
}

function printServiceFailure(stderr: string): void {
  const cleaned = formatServiceStderr(stderr);

  if (/bootstrap failed.*input\/output error/i.test(cleaned)) {
    console.error('✗ bot 启动失败。');
    console.error('');
    console.error('最常见原因：旧的 bot 实例还在收尾。请稍等几秒后重新运行 `npm start`。');
    console.error('');
    console.error('原始错误:');
    console.error(`  ${cleaned}`);
    return;
  }

  console.error('✗ bot 启动失败:');
  console.error(cleaned);
}

function buildExtraRunArgs(opts: ServiceStartOptions): string[] {
  const args: string[] = [];
  if (opts.config) args.push('--config', opts.config);
  if (opts.appId) args.push('--app-id', opts.appId);
  if (opts.appSecret) args.push('--app-secret', opts.appSecret);
  if (opts.tenant) args.push('--tenant', opts.tenant);
  if (opts.agent) args.push('--agent', opts.agent);
  if (opts.debug) args.push('--debug');
  return args;
}

async function ensureConfigured(opts: ServiceStartOptions): Promise<void> {
  const { cfg } = await resolveConfig(opts);
  if (!isComplete(cfg)) {
    console.error('bot 还没配置 app 凭据。');
    console.error('请重新运行 `npm start` 完成首次扫码向导，或传入已有应用信息。');
    process.exit(1);
  }
}

/**
 * `start` — install (write service file) then start as OS-managed daemon.
 */
export async function runServiceStart(opts: ServiceStartOptions = {}): Promise<void> {
  const extraRunArgs = buildExtraRunArgs(opts);
  await ensureConfigured(opts);
  const adapter = requireAdapter('start', extraRunArgs);

  await adapter.install();

  if (adapter.isRunning()) {
    console.log('检测到旧 bot 实例，先停掉再重启...');
    const r = await adapter.stop();
    if (!r.ok) {
      console.warn(`⚠ 停止旧实例时有警告（继续重启）:\n${formatServiceStderr(r.stderr)}`);
    }
    const ok = await adapter.waitUntilStopped();
    if (!ok) {
      console.error('✗ 旧 bot 实例没有完全停止，请稍后重试。');
      process.exit(1);
    }
  }

  const r = await adapter.start();
  if (!r.ok) {
    printServiceFailure(r.stderr);
    process.exit(1);
  }

  console.log('✓ bot 已在后台启动');
  console.log('  日志:');
  console.log(`    ${daemonStdoutPath()}`);
  console.log(`    ${daemonStderrPath()}`);
  console.log(`  配置目录: ${paths.rootDir}`);
  console.log('  停止: feishu-devops stop');
}

export async function runServiceStop(): Promise<void> {
  const adapter = requireAdapter('stop', []);
  if (!adapter.fileExists()) {
    console.log('bot 还没在后台运行过，无需停止。');
    return;
  }
  if (!adapter.isRunning()) {
    console.log('bot 当前没在后台运行。');
    return;
  }

  const r = await adapter.stopAndDisableAutostart();
  if (!r.ok) {
    console.error(`✗ 停止失败:\n${formatServiceStderr(r.stderr)}`);
    process.exit(1);
  }
  console.log('✓ bot 已停止运行');
  console.log('  通过 `npm start` 或 `feishu-devops start` 可再次启动');
}

/**
 * `restart` — bounce the running daemon in place.
 * If not running, behaves like `start`.
 */
export async function runServiceRestart(opts: ServiceStartOptions = {}): Promise<void> {
  const extraRunArgs = buildExtraRunArgs(opts);
  await ensureConfigured(opts);
  const adapter = requireAdapter('restart', extraRunArgs);

  if (!adapter.fileExists()) {
    console.error('bot 还没在后台运行过。请先运行 `npm start` 启动。');
    process.exit(1);
  }

  if (adapter.isRunning()) {
    const r = await adapter.restart();
    if (!r.ok) {
      printServiceFailure(r.stderr);
      process.exit(1);
    }
    console.log('✓ bot 已重启');
    console.log('  日志:');
    console.log(`    ${daemonStdoutPath()}`);
    console.log(`    ${daemonStderrPath()}`);
    console.log(`  配置目录: ${paths.rootDir}`);
    console.log('  停止: feishu-devops stop');
    return;
  }

  await adapter.install();
  const r = await adapter.start();
  if (!r.ok) {
    printServiceFailure(r.stderr);
    process.exit(1);
  }
  console.log('✓ bot 已在后台启动');
  console.log('  日志:');
  console.log(`    ${daemonStdoutPath()}`);
  console.log(`    ${daemonStderrPath()}`);
  console.log(`  配置目录: ${paths.rootDir}`);
  console.log('  停止: feishu-devops stop');
}

export async function runServiceStatus(): Promise<void> {
  const adapter = requireAdapter('status', []);
  if (!adapter.fileExists()) {
    console.log('bot 当前没在后台运行（从未启动过）');
    console.log('  通过 `npm start` 启动 bot');
    return;
  }
  if (!adapter.isRunning()) {
    console.log('bot 当前没在后台运行');
    console.log('  通过 `npm start` 重新启动');
    return;
  }

  const { pid, lastExit } = adapter.parseStatus(adapter.describeStatus());
  console.log('✓ bot 正在后台运行');
  if (pid) console.log(`  进程 ID: ${pid}`);
  console.log('  日志:');
  console.log(`    ${daemonStdoutPath()}`);
  console.log(`    ${daemonStderrPath()}`);
  if (lastExit && lastExit !== '-1') console.log(`  上次退出码: ${lastExit}`);
}
