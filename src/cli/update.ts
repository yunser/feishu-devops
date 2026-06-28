import pkg from '../../package.json';
import { spawnProcess, spawnProcessSync } from '../platform/spawn';

function getGlobalInstalledVersion(packageName: string): string | undefined {
  const fromBin = spawnProcessSync(packageName, ['--version'], { encoding: 'utf8' });
  const binStdout = fromBin.stdout;
  const binVersion = typeof binStdout === 'string' ? binStdout.trim() : undefined;
  if (fromBin.status === 0 && binVersion) return binVersion;

  const fromNpm = spawnProcessSync('npm', ['list', '-g', packageName, '--depth=0', '--json'], {
    encoding: 'utf8',
  });
  const npmStdout = fromNpm.stdout;
  if (fromNpm.status !== 0 || typeof npmStdout !== 'string') return undefined;

  try {
    const data = JSON.parse(npmStdout) as {
      dependencies?: Record<string, { version?: string }>;
    };
    return data.dependencies?.[packageName]?.version;
  } catch {
    return undefined;
  }
}

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

  const version = getGlobalInstalledVersion(packageName);
  if (version) {
    console.log(`✓ ${packageName} 已更新到 ${version}`);
  } else {
    console.log(`✓ ${packageName} 已更新到最新版本`);
  }
}
