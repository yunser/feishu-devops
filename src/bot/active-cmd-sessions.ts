import type { ShellSpawnHandle } from './run-shell';

export interface ActiveCmdSession {
  command: string;
  handle: ShellSpawnHandle;
}

export class ActiveCmdSessions {
  private readonly sessions = new Map<string, ActiveCmdSession>();

  register(scope: string, session: ActiveCmdSession): void {
    if (this.sessions.has(scope)) {
      throw new Error(`cmd session already active for scope: ${scope}`);
    }
    this.sessions.set(scope, session);
  }

  get(scope: string): ActiveCmdSession | undefined {
    return this.sessions.get(scope);
  }

  has(scope: string): boolean {
    return this.sessions.has(scope);
  }

  unregister(scope: string): void {
    this.sessions.delete(scope);
  }

  writeStdin(scope: string, text: string): boolean {
    const session = this.sessions.get(scope);
    if (!session) return false;
    session.handle.writeStdin(text);
    return true;
  }

  interrupt(scope: string): boolean {
    const session = this.sessions.get(scope);
    if (!session) return false;
    this.sessions.delete(scope);
    session.handle.kill();
    return true;
  }

  stopAll(): void {
    for (const scope of [...this.sessions.keys()]) {
      this.interrupt(scope);
    }
  }
}
