import { endAssignment, releaseAssignmentsForExecutor } from '../lease.js';
import { listExpiredActiveAssignments } from '../db/assignments.js';
import { pruneEvents } from '../db/events.js';
import { getExecutor, listStaleExecutors, updateExecutor } from '../db/executors.js';
import { pruneIdempotencyRecords } from '../db/idempotency.js';
import { writeTransaction } from '../db/transaction.js';
import { publish } from '../http/route-utils.js';
import type { ServerContext } from '../types.js';

function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Periodic sweep (docs/003 §3): expired leases return tasks to the pool,
 * silent executors go offline and release their work, and retention prunes the
 * event log and idempotency keys.
 */
export class Sweepers {
  private readonly ctx: ServerContext;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(ctx: ServerContext) {
    this.ctx = ctx;
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), this.ctx.config.heartbeatSweepMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) await this.inFlight;
  }

  sweep(): void {
    const nowMs = this.ctx.clock();
    this.expireLeases(isoAt(nowMs));
    this.takeOfflineExecutors(isoAt(nowMs - this.ctx.config.presenceTtlMs));
    pruneEvents(this.ctx.db, isoAt(nowMs - this.ctx.config.eventRetentionMs));
    pruneIdempotencyRecords(this.ctx.db, isoAt(nowMs - this.ctx.config.idempotencyTtlMs));
  }

  private poll(): void {
    if (this.stopped || this.inFlight !== null) return;
    const promise = Promise.resolve()
      .then(() => this.sweep())
      .catch((error: unknown) => {
        if (this.ctx.config.logger) console.error('[sweeper]', error);
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = promise;
  }

  private expireLeases(nowIso: string): void {
    const expired = listExpiredActiveAssignments(this.ctx.db, nowIso);
    if (expired.length === 0) return;
    writeTransaction(this.ctx.db, publish(this.ctx), (tx) => {
      for (const assignment of expired) {
        endAssignment(tx, assignment, 'expired', 'assignment.expired', {
          reason: 'lease_expired',
        });
      }
    });
  }

  private takeOfflineExecutors(cutoffIso: string): void {
    for (const record of listStaleExecutors(this.ctx.db, cutoffIso)) {
      writeTransaction(this.ctx.db, publish(this.ctx), (tx) => {
        const fresh = getExecutor(this.ctx.db, record.executor.id);
        if (fresh === null || fresh.executor.presence === 'offline') return;
        if (fresh.lastHeartbeatAt !== null && fresh.lastHeartbeatAt >= cutoffIso) return;
        updateExecutor(
          this.ctx.db,
          { ...fresh.executor, presence: 'offline', updatedAt: tx.now },
          fresh.lastHeartbeatAt,
        );
        releaseAssignmentsForExecutor(tx, fresh.executor.id, 'presence_expired');
        tx.append({
          type: 'executor.offline',
          subject: { type: 'executor', id: fresh.executor.id },
          data: {
            executorId: fresh.executor.id,
            user: fresh.executor.user,
            reason: 'heartbeat_timeout',
          },
        });
      });
    }
  }
}
