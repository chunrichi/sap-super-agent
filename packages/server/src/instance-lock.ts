import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Single-instance lock for M1 state directories (H0 §1.4 "单实例锁（文件锁即可）").
// The lock file contains the holder PID so a crashed process can be reclaimed
// instead of requiring manual cleanup.
// ---------------------------------------------------------------------------

const LOCK_FILE_NAME = '.instance.lock';

export class InstanceLockedError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | null;

  constructor(lockPath: string, holderPid: number | null) {
    const holder = holderPid === null ? 'another process' : `pid ${holderPid}`;
    super(
      `state directory is already in use by ${holder} (${lockPath}); ` +
        'stop that control plane or pass a different --state-dir',
    );
    this.name = 'InstanceLockedError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class StateDirLock {
  readonly lockPath: string;
  private held = false;

  constructor(stateDir: string) {
    this.lockPath = join(stateDir, LOCK_FILE_NAME);
  }

  acquire(): void {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    // Two attempts: one for the normal case, one after clearing a stale lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        try {
          writeSync(
            fd,
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          );
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holderPid = this.readHolderPid();
        // A live holder always wins, including a second server in this process
        // (unit tests): one state directory = one control-plane instance.
        if (holderPid !== null && isProcessAlive(holderPid)) {
          throw new InstanceLockedError(this.lockPath, holderPid);
        }
        // Stale lock (crashed process / reused PID): remove it and retry once.
        try {
          unlinkSync(this.lockPath);
        } catch {
          // A racing process may have removed it first; the retry will decide.
        }
      }
    }
    throw new InstanceLockedError(this.lockPath, this.readHolderPid());
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already removed (e.g. manual cleanup); nothing to do.
    }
  }

  private readHolderPid(): number | null {
    try {
      const raw = readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: unknown };
      return typeof parsed.pid === 'number' ? parsed.pid : null;
    } catch {
      return null;
    }
  }
}
