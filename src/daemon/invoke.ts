import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface DaemonRunInvocation {
  /** First element of ProgramArguments (node or tsx wrapper). */
  program: string;
  /** Remaining ProgramArguments after `program`. */
  runArgs: string[];
  /** Working directory for the daemon process. */
  cwd: string;
}

function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

function resolveTsxCli(projectRoot: string): string {
  const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxCli)) {
    throw new Error('未找到 tsx，请先在项目目录执行 npm install');
  }
  return tsxCli;
}

/**
 * Resolve how the OS service manager should invoke `run`.
 * Supports compiled entry (`node bin/chat-devops.mjs`) and dev entry
 * (`tsx src/cli/index.ts`).
 */
export function resolveDaemonRunInvocation(extraRunArgs: string[] = []): DaemonRunInvocation {
  const entryPath = process.argv[1];
  if (!entryPath) {
    throw new Error('cannot determine CLI entry path (process.argv[1] is empty)');
  }

  const resolvedEntry = resolve(entryPath);
  const projectRoot = findProjectRoot(dirname(resolvedEntry));

  if (resolvedEntry.endsWith('.ts')) {
    const tsxCli = resolveTsxCli(projectRoot);
    return {
      program: process.execPath,
      runArgs: [tsxCli, resolvedEntry, 'run', ...extraRunArgs],
      cwd: projectRoot,
    };
  }

  return {
    program: process.execPath,
    runArgs: [resolvedEntry, 'run', ...extraRunArgs],
    cwd: projectRoot,
  };
}
