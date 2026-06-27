import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], options);
}

/**
 * Truncate every argv element for logging — the prompt / system-prompt args can
 * be huge, and we only need to see the flags + a preview to confirm the json
 * mode flag (`--output-format stream-json` / `--mode json`) actually reached the
 * child. Used to diagnose "agent replied with no content" on Windows, where the
 * json flag can get swallowed when a large Unicode prompt is passed via the
 * `.cmd` shim.
 */
export function formatSpawnArgsForLog(args: readonly string[], maxLen = 80): string[] {
  return args.map((a) => (a.length > maxLen ? `${a.slice(0, maxLen)}…(${a.length} chars)` : a));
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  return crossSpawn.sync(command, [...args], options);
}

export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
