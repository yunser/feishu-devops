import pkg from '../../package.json';
import { spawnProcess } from '../platform/spawn';

/**
 * `update` — 通过 npm 全局安装最新版本。
 */
export async function runUpdate(): Promise<void> {
  const packageName = pkg.name;
  const spec = `${packageName}@latest`;

  console.log(`正在更新 ${packageName}（npm install -g ${spec}）...`);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawnProcess('npm', ['install', '-g', spec], {
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  if (exitCode !== 0) {
    console.error(`✗ 更新失败（npm 退出码 ${exitCode ?? 'unknown'}）`);
    process.exit(exitCode ?? 1);
  }

  console.log(`✓ ${packageName} 已更新到最新版本`);
}
