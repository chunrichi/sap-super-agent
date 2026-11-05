import {
  StageOutputError,
  renderAiStageMessages,
  resolveAiStageDefinition,
  runAiStage,
  type AiStageDefinition,
  type AiStageInput,
  type AiStageMessages,
  type AiStageUpstreamArtifact,
  type StageRunLedger,
} from '@sap-superagent/ai';
import { canTransitionDemand, findStage } from '@sap-superagent/core';
import {
  newUlid,
  type Demand,
  type SapAiJob,
  type StageRun,
  type StageTemplate,
  type StageTemplateFile,
} from '@sap-superagent/protocol';
import { readArtifactBytes } from '../artifact-store.js';
import { latestVersionsByKind } from '../db/artifacts.js';
import { getDemand, updateDemand } from '../db/demands.js';
import {
  getSapAiJob,
  getSapAiJobForAttempt,
  incrementSapAiJobLeaseExpiries,
  insertSapAiJob,
  isSapAiJobTerminal,
  listActiveSapAiJobs,
  listClaimedExpiredSapAiJobs,
  listOverAgeSapAiJobs,
  updateSapAiJob,
} from '../db/sap-ai-jobs.js';
import {
  getStageRun,
  listRunningServerAiStageRuns,
  recoverRunningServerAiStages,
  resetRunningServerAiStage,
  selectReadyServerAiStageRuns,
  updateStageRun,
} from '../db/stages.js';
import { writeTransaction, type TransactionContext } from '../db/transaction.js';
import {
  appendSapAiJobEvent,
  buildSapAiJobResultSummary,
  cancelSapAiJob,
  driveSapAiJobStageFailure,
  truncateSapAiJobError,
  type SapAiJobQueuedReason,
} from '../sap-ai/jobs.js';
import {
  completeServerAiStage,
  failStageAttempt,
  type ServerAiStageLedger,
} from '../stage-engine.js';
import type { ServerContext } from '../types.js';

// ---------------------------------------------------------------------------
// Server-AI stage runner (docs/003 §2.2, H1 §1.1; S5 §4.8.6): drains ready
// `server-ai` stage runs from the loaded template, resolves the stage by key in
// the AI stage registry, validates schema + checklist before persisting anything
// and then hands over to the gate/advance engine.
//
// S5: when `SA_SAP_AI_BATCH` is enabled and the stage key is delegated, the
// runner still owns the stage claim but stops calling the local provider: it
// renders the prompt (`renderAiStageMessages`), enqueues a `sap_ai_jobs` row and
// leaves the stage `running` until the SAP executor posts a result. The same
// tick also sweeps lease/max-age expiries and orphaned jobs. With the feature
// disabled everything below behaves exactly as H0–S4.
// ---------------------------------------------------------------------------

/** Keep prompts bounded: upstream content is truncated per artifact. */
const MAX_UPSTREAM_CHARS = 20_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class StageRunner {
  private readonly ctx: ServerContext;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight: Promise<void> | null = null;
  private readonly busy = new Set<string>();
  private stopped = false;

  constructor(ctx: ServerContext) {
    this.ctx = ctx;
  }

  start(): void {
    if (this.ctx.config.sapAi.enabled) {
      this.recoverSapAiMode();
    } else {
      const recovered = recoverRunningServerAiStages(this.ctx.db);
      if (recovered > 0) this.log(`recovered ${recovered} interrupted server-ai stage run(s)`);
    }
    this.timer = setInterval(() => this.poll(), this.ctx.config.stagePollMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tickInFlight !== null) await this.tickInFlight;
  }

  private poll(): void {
    if (this.stopped || this.tickInFlight !== null) return;
    if (this.busy.size > 0) return;
    const promise = this.tick()
      .catch((error: unknown) => this.log(`stage poll failed: ${errorMessage(error)}`))
      .finally(() => {
        this.tickInFlight = null;
      });
    this.tickInFlight = promise;
  }

  private async tick(): Promise<void> {
    // --- S5: lease/max-age/cancellation sweep precedes ready polling (§4.8.2) ---
    if (this.ctx.config.sapAi.enabled) this.sweepSapAiJobs();
    const processed = new Set<string>();
    while (!this.stopped) {
      const next = selectReadyServerAiStageRuns(this.ctx.db, 1)[0];
      if (next === undefined || this.busy.has(next.id) || processed.has(next.id)) return;
      processed.add(next.id);
      await this.runStage(next.id);
    }
  }

  private async runStage(stageRunId: string): Promise<void> {
    this.busy.add(stageRunId);
    try {
      await this.execute(stageRunId);
    } catch (error) {
      this.log(`stage ${stageRunId} crashed: ${errorMessage(error)}`);
    } finally {
      this.busy.delete(stageRunId);
    }
  }

  /** Resolve the template + AI stage definition for the run's stage key. */
  private resolve(
    stageRun: StageRun,
    demand: Demand,
  ): {
    template: StageTemplateFile;
    stageTemplate: StageTemplate;
    definition: AiStageDefinition;
  } | null {
    const template = this.ctx.templates.getForDemand(demand);
    if (template === undefined) return null;
    const stageTemplate = findStage(template, stageRun.stageKey);
    if (stageTemplate === undefined) return null;
    const definition = resolveAiStageDefinition(
      stageTemplate.key,
      stageTemplate.outputArtifactKind,
    );
    if (definition === undefined) return null;
    return { template, stageTemplate, definition };
  }

  /**
   * S5 delegation predicate (docs/003 §4.8.1): enabled + `server-ai` executor +
   * empty allow-list or a matching template stage key.
   */
  private isDelegated(stageTemplate: StageTemplate): boolean {
    const sapAi = this.ctx.config.sapAi;
    if (!sapAi.enabled) return false;
    if (stageTemplate.executorKind !== 'server-ai') return false;
    return sapAi.stageKeys === null || sapAi.stageKeys.includes(stageTemplate.key);
  }

  private collectUpstream(
    demand: Demand,
    stageTemplate: StageTemplate,
  ): AiStageUpstreamArtifact[] | null {
    const latest = latestVersionsByKind(this.ctx.db, demand.id);
    const upstream: AiStageUpstreamArtifact[] = [];
    for (const kind of stageTemplate.inputArtifactKinds) {
      const entry = latest.get(kind);
      if (entry === undefined) return null;
      let contentText = '';
      try {
        contentText = Buffer.from(
          readArtifactBytes(
            this.ctx.config.stateDir,
            entry.artifact.id,
            entry.version.version,
          ),
        )
          .toString('utf8')
          .slice(0, MAX_UPSTREAM_CHARS);
      } catch {
        contentText = '';
      }
      upstream.push({
        kind,
        artifactId: entry.artifact.id,
        version: entry.version.version,
        contentType: entry.version.contentType,
        contentText,
      });
    }
    return upstream;
  }

  private buildStageInput(
    definition: AiStageDefinition,
    demand: Demand,
    stageTemplate: StageTemplate,
    upstream: AiStageUpstreamArtifact[],
  ): AiStageInput {
    return {
      stageKey: definition.key,
      stageName: stageTemplate.name,
      promptVersion: definition.promptVersion,
      demand: {
        id: demand.id,
        title: demand.title,
        description: demand.description,
        acceptanceCriteria: demand.acceptanceCriteria,
        requester: {
          userId: demand.requester.userId,
          ...(demand.requester.orgUnit === undefined ? {} : { orgUnit: demand.requester.orgUnit }),
        },
        priority: demand.priority,
      },
      upstream,
    };
  }

  private async execute(stageRunId: string): Promise<void> {
    const initial = getStageRun(this.ctx.db, stageRunId);
    if (initial === null || initial.status !== 'ready') return;
    const demand = getDemand(this.ctx.db, initial.demandId);
    if (demand === null) return;
    const resolved = this.resolve(initial, demand);
    if (resolved === null) {
      this.markWaitingHuman(
        stageRunId,
        `no server-AI stage registered for "${initial.stageKey}" in template ${demand.templateId}@${demand.templateVersion}`,
      );
      return;
    }
    const { template, stageTemplate, definition } = resolved;
    const upstream = this.collectUpstream(demand, stageTemplate);
    if (upstream === null) {
      this.markWaitingHuman(stageRunId, `missing upstream artifacts for stage "${initial.stageKey}"`);
      return;
    }
    const stageInput = this.buildStageInput(definition, demand, stageTemplate, upstream);
    const delegated = this.isDelegated(stageTemplate);
    // Render before claiming: a missing prompt file must not leave a half-started
    // stage behind, and the job payload must be fully validated before enqueue.
    let messages: AiStageMessages | null = null;
    if (delegated) {
      try {
        messages = renderAiStageMessages(definition, stageInput);
      } catch (error) {
        this.markWaitingHuman(
          stageRunId,
          `cannot render the prompt for stage "${initial.stageKey}": ${errorMessage(error)}`,
        );
        return;
      }
    }

    const claimed = writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      const current = getStageRun(this.ctx.db, stageRunId);
      if (current === null || current.status !== 'ready') return null;
      const running: StageRun = {
        ...current,
        status: 'running',
        startedAt: tx.now,
        finishedAt: null,
        updatedAt: tx.now,
      };
      updateStageRun(this.ctx.db, running);
      tx.append({
        type: 'stage.started',
        subject: { type: 'stage_run', id: stageRunId },
        data: {
          stageRunId,
          demandId: current.demandId,
          stageKey: current.stageKey,
          attempt: current.attempt,
          executorKind: current.executorKind,
          promptVersion: definition.promptVersion,
        },
        demandId: current.demandId,
      });
      const currentDemand = getDemand(this.ctx.db, current.demandId);
      if (currentDemand !== null && canTransitionDemand(currentDemand.status, 'in_progress')) {
        updateDemand(this.ctx.db, { ...currentDemand, status: 'in_progress', updatedAt: tx.now });
        tx.append({
          type: 'demand.updated',
          subject: { type: 'demand', id: currentDemand.id },
          data: { demandId: currentDemand.id, status: 'in_progress', reason: 'first_stage_started' },
          demandId: currentDemand.id,
        });
      }
      if (delegated && messages !== null) {
        const job = this.createQueuedJob(tx, running, stageTemplate, definition, messages);
        appendSapAiJobEvent(tx, job, 'stage.ai_job.queued', {
          reason: running.attempt > 1 ? 'retry' : 'dispatch',
        });
        return { running, job };
      }
      return { running, job: null };
    });
    if (claimed === null) return;
    if (claimed.job !== null) {
      // SAP owns execution from here: the local provider must never be called.
      const { job } = claimed;
      this.log(
        `queued sap ai job ${job.id} for stage ${job.stageKey} attempt ${job.attempt} ` +
          `(promptVersion=${job.payload.promptVersion}, systemPromptChars=${job.payload.systemPrompt.length}, ` +
          `promptChars=${job.payload.prompt.length}, timeoutMs=${job.payload.timeoutMs})`,
      );
      return;
    }

    const startedAtMs = Date.now();
    try {
      const result = await runAiStage(definition, stageInput, this.ctx.aiProvider, {
        attempt: claimed.running.attempt,
      });
      this.completeStage(claimed.running, template, stageTemplate, result.output, result.ledger, startedAtMs);
    } catch (error) {
      this.failStage(claimed.running, template, stageTemplate, error, Date.now() - startedAtMs);
    }
  }

  /** Persist one queued job for a delegated attempt (docs/003 §4.8.3 payload). */
  private createQueuedJob(
    tx: TransactionContext,
    stageRun: StageRun,
    stageTemplate: StageTemplate,
    definition: AiStageDefinition,
    messages: AiStageMessages,
  ): SapAiJob {
    const job: SapAiJob = {
      id: newUlid(),
      stageRunId: stageRun.id,
      demandId: stageRun.demandId,
      attempt: stageRun.attempt,
      stageKey: stageRun.stageKey,
      state: 'queued',
      payload: {
        stageRunId: stageRun.id,
        demandId: stageRun.demandId,
        stageKey: stageRun.stageKey,
        stageName: stageTemplate.name,
        attempt: stageRun.attempt,
        promptVersion: definition.promptVersion,
        systemPrompt: messages.systemPrompt,
        prompt: messages.prompt,
        model: this.ctx.config.sapAi.model,
        outputSchema: definition.outputArtifactKind,
        timeoutMs: this.ctx.config.sapAi.timeoutMs,
      },
      claimId: null,
      leaseExpiresAt: null,
      result: null,
      lastError: null,
      createdAt: tx.now,
      updatedAt: tx.now,
    };
    insertSapAiJob(tx.db, job, 0);
    return job;
  }

  private completeStage(
    stageRun: StageRun,
    template: StageTemplateFile,
    stageTemplate: StageTemplate,
    output: unknown,
    ledger: StageRunLedger,
    startedAtMs: number,
  ): void {
    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      const current = getStageRun(this.ctx.db, stageRun.id);
      if (current === null || current.status !== 'running') return;
      const demand = getDemand(this.ctx.db, current.demandId);
      if (demand === null) return;
      completeServerAiStage(tx, this.ctx, {
        demand,
        template,
        stageTemplate,
        stageRun: current,
        output,
        ledger: {
          model: ledger.model,
          promptVersion: ledger.promptVersion,
          tokens: ledger.tokens,
          costUsd: ledger.costUsd,
          durationMs: ledger.durationMs,
          startedAt: new Date(startedAtMs).toISOString(),
        },
      });
    });
  }

  private failStage(
    stageRun: StageRun,
    template: StageTemplateFile,
    stageTemplate: StageTemplate,
    error: unknown,
    durationMs: number,
  ): void {
    const outputError = error instanceof StageOutputError ? error : null;
    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      const current = getStageRun(this.ctx.db, stageRun.id);
      if (current === null || current.status !== 'running') return;
      const demand = getDemand(this.ctx.db, current.demandId);
      if (demand === null) return;
      failStageAttempt(tx, this.ctx, {
        demand,
        template,
        stageRun: current,
        stageTemplate,
        reason: errorMessage(error),
        error: errorMessage(error),
        ledger: {
          model: outputError?.model ?? null,
          promptVersion: outputError?.promptVersion ?? null,
          schemaOk: false,
          tokens: outputError?.tokens ?? 0,
          costUsd: outputError?.costUsd ?? 0,
          durationMs,
          startedAt: current.startedAt ?? tx.now,
        },
      });
    });
  }

  private markWaitingHuman(stageRunId: string, message: string): void {
    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      const current = getStageRun(this.ctx.db, stageRunId);
      if (current === null || current.status !== 'ready') return;
      updateStageRun(this.ctx.db, {
        ...current,
        status: 'waiting_human',
        finishedAt: tx.now,
        updatedAt: tx.now,
      });
      tx.append({
        type: 'stage.failed',
        subject: { type: 'stage_run', id: current.id },
        data: {
          stageRunId: current.id,
          demandId: current.demandId,
          stageKey: current.stageKey,
          attempt: current.attempt,
          error: message,
          willRetry: false,
        },
        demandId: current.demandId,
      });
      tx.append({
        type: 'stage.waiting_human',
        subject: { type: 'stage_run', id: current.id },
        data: {
          stageRunId: current.id,
          demandId: current.demandId,
          stageKey: current.stageKey,
          attempt: current.attempt,
        },
        demandId: current.demandId,
      });
    });
  }

  // -------------------------------------------------------------------------
  // S5: SAP batch AI job lifecycle (docs/003 §4.8.2/§4.8.6)
  // -------------------------------------------------------------------------

  /** Restart recovery for SAP mode: requeue stale leases, recreate missing jobs. */
  private recoverSapAiMode(): void {
    const nowMs = this.ctx.clock();
    const requeued = this.recycleExpiredClaims(nowMs, 'recovered');
    const reconciled = this.recoverRunningStages(nowMs);
    if (requeued + reconciled > 0) {
      this.log(
        `sap ai restart recovery: ${requeued} claimed job(s) requeued, ${reconciled} running stage run(s) reconciled`,
      );
    }
  }

  /**
   * Recover every interrupted `running` server-AI stage. Delegated runs keep a
   * job: a missing job is recreated for the same attempt (idempotent, reason
   * `recovered`), a present job is left to the executor. Everything else keeps
   * the H0–S4 behaviour of going back to `ready`.
   */
  private recoverRunningStages(nowMs: number): number {
    const nowIso = new Date(nowMs).toISOString();
    let reconciled = 0;
    for (const stageRun of listRunningServerAiStageRuns(this.ctx.db)) {
      const demand = getDemand(this.ctx.db, stageRun.demandId);
      if (demand === null) {
        if (resetRunningServerAiStage(this.ctx.db, stageRun.id, nowIso)) reconciled += 1;
        continue;
      }
      const template = this.ctx.templates.getForDemand(demand);
      if (template === undefined) {
        if (resetRunningServerAiStage(this.ctx.db, stageRun.id, nowIso)) reconciled += 1;
        continue;
      }
      const stageTemplate = findStage(template, stageRun.stageKey);
      if (stageTemplate === undefined || !this.isDelegated(stageTemplate)) {
        if (resetRunningServerAiStage(this.ctx.db, stageRun.id, nowIso)) reconciled += 1;
        continue;
      }
      const definition = resolveAiStageDefinition(
        stageTemplate.key,
        stageTemplate.outputArtifactKind,
      );
      if (definition === undefined) {
        if (resetRunningServerAiStage(this.ctx.db, stageRun.id, nowIso)) reconciled += 1;
        continue;
      }
      // A job already exists for this attempt: queued/claimed is healthy.
      if (getSapAiJobForAttempt(this.ctx.db, stageRun.id, stageRun.attempt) !== null) continue;
      const upstream = this.collectUpstream(demand, stageTemplate);
      if (upstream === null) {
        if (resetRunningServerAiStage(this.ctx.db, stageRun.id, nowIso)) reconciled += 1;
        continue;
      }
      const stageInput = this.buildStageInput(definition, demand, stageTemplate, upstream);
      let messages: AiStageMessages;
      try {
        messages = renderAiStageMessages(definition, stageInput);
      } catch {
        if (resetRunningServerAiStage(this.ctx.db, stageRun.id, nowIso)) reconciled += 1;
        continue;
      }
      writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
        const fresh = getStageRun(this.ctx.db, stageRun.id);
        if (fresh === null || fresh.status !== 'running' || fresh.attempt !== stageRun.attempt) return;
        if (getSapAiJobForAttempt(this.ctx.db, fresh.id, fresh.attempt) !== null) return;
        const job = this.createQueuedJob(tx, fresh, stageTemplate, definition, messages);
        appendSapAiJobEvent(tx, job, 'stage.ai_job.queued', { reason: 'recovered' });
        this.log(
          `recreated sap ai job ${job.id} for running stage ${job.stageKey} attempt ${job.attempt}`,
        );
      });
      reconciled += 1;
    }
    return reconciled;
  }

  /** Per-tick SAP job sweep; runs before ready polling (docs/003 §4.8.2). */
  private sweepSapAiJobs(): void {
    const nowMs = this.ctx.clock();
    try {
      this.expireOverAgeJobs(nowMs);
      this.recycleExpiredClaims(nowMs, 'lease_expired');
      this.cancelOrphanedJobs();
    } catch (error) {
      this.log(`sap ai job sweep failed: ${errorMessage(error)}`);
    }
  }

  /** `claimed` leases past `SA_SAP_AI_JOB_LEASE_MS` go back to `queued`. */
  private recycleExpiredClaims(nowMs: number, reason: SapAiJobQueuedReason): number {
    const config = this.ctx.config.sapAi;
    const nowIso = new Date(nowMs).toISOString();
    let processed = 0;
    for (const candidate of listClaimedExpiredSapAiJobs(this.ctx.db, nowIso)) {
      writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
        const job = getSapAiJob(this.ctx.db, candidate.id);
        if (job === null || job.state !== 'claimed') return;
        if (job.leaseExpiresAt === null || job.leaseExpiresAt > tx.now) return;
        const expiries = incrementSapAiJobLeaseExpiries(this.ctx.db, job.id);
        const stageRun = getStageRun(this.ctx.db, job.stageRunId);
        if (expiries >= config.maxLeaseExpiries) {
          // Repeated lease expiry: fail the attempt (§4.8.2), never retry silently.
          const error = `SAP AI job lease expired ${expiries} time(s) (max ${config.maxLeaseExpiries})`;
          const outcome = driveSapAiJobStageFailure(tx, this.ctx, job, {
            reason: 'lease_expired',
            error,
            ledger: this.jobLedger(job, stageRun),
          });
          const updated: SapAiJob = {
            ...job,
            state: 'expired',
            leaseExpiresAt: null,
            lastError: truncateSapAiJobError(error),
            result: buildSapAiJobResultSummary({
              status: 'failed',
              error,
              usage: null,
              durationMs: null,
              completedAt: tx.now,
            }),
            updatedAt: tx.now,
          };
          updateSapAiJob(this.ctx.db, updated);
          appendSapAiJobEvent(tx, updated, 'stage.ai_job.failed', {
            reason: 'lease_expired',
            error,
            willRetry: outcome.willRetry,
            stageStatus: outcome.stageStatus,
          });
          this.log(`expired sap ai job ${updated.id} after lease expiry #${expiries}`);
          return;
        }
        const updated: SapAiJob = {
          ...job,
          state: 'queued',
          claimId: null,
          leaseExpiresAt: null,
          updatedAt: tx.now,
        };
        updateSapAiJob(this.ctx.db, updated);
        appendSapAiJobEvent(tx, updated, 'stage.ai_job.queued', { reason });
        this.log(`requeued sap ai job ${updated.id} after lease expiry #${expiries} (${reason})`);
        processed += 1;
      });
    }
    return processed;
  }

  /** Non-terminal jobs older than `SA_SAP_AI_JOB_MAX_AGE_MS` fail the attempt. */
  private expireOverAgeJobs(nowMs: number): void {
    const config = this.ctx.config.sapAi;
    const cutoffIso = new Date(nowMs - config.maxAgeMs).toISOString();
    for (const candidate of listOverAgeSapAiJobs(this.ctx.db, cutoffIso)) {
      writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
        const job = getSapAiJob(this.ctx.db, candidate.id);
        if (job === null || isSapAiJobTerminal(job.state)) return;
        const stageRun = getStageRun(this.ctx.db, job.stageRunId);
        const error = `SAP AI job exceeded max age of ${config.maxAgeMs}ms`;
        const outcome = driveSapAiJobStageFailure(tx, this.ctx, job, {
          reason: 'max_age_exceeded',
          error,
          ledger: this.jobLedger(job, stageRun),
        });
        const updated: SapAiJob = {
          ...job,
          state: 'expired',
          leaseExpiresAt: null,
          lastError: truncateSapAiJobError(error),
          result: buildSapAiJobResultSummary({
            status: 'failed',
            error,
            usage: null,
            durationMs: null,
            completedAt: tx.now,
          }),
          updatedAt: tx.now,
        };
        updateSapAiJob(this.ctx.db, updated);
        appendSapAiJobEvent(tx, updated, 'stage.ai_job.failed', {
          reason: 'max_age_exceeded',
          error,
          willRetry: outcome.willRetry,
          stageStatus: outcome.stageStatus,
        });
        this.log(`expired sap ai job ${updated.id} (max age exceeded)`);
      });
    }
  }

  /**
   * Cancel jobs whose stage left the same `running` attempt (cancelled, advanced
   * or finished): SAP must stop retrying (§4.8.2/§4.8.4).
   */
  private cancelOrphanedJobs(): void {
    for (const candidate of listActiveSapAiJobs(this.ctx.db)) {
      const stageRun = getStageRun(this.ctx.db, candidate.stageRunId);
      if (
        stageRun !== null &&
        stageRun.status === 'running' &&
        stageRun.attempt === candidate.attempt
      ) {
        continue;
      }
      writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
        const job = getSapAiJob(this.ctx.db, candidate.id);
        if (job === null || isSapAiJobTerminal(job.state)) return;
        const freshStage = getStageRun(this.ctx.db, job.stageRunId);
        if (
          freshStage !== null &&
          freshStage.status === 'running' &&
          freshStage.attempt === job.attempt
        ) {
          return;
        }
        const error =
          freshStage === null
            ? 'stage run no longer exists'
            : `stage is ${freshStage.status} at attempt ${freshStage.attempt} (job attempt ${job.attempt})`;
        cancelSapAiJob(tx, this.ctx, job, { error, stageStatus: freshStage?.status ?? null });
        this.log(`cancelled sap ai job ${job.id}: ${error}`);
      });
    }
  }

  /** Ledger for a job-driven stage failure (tokens=0: no usage was reported). */
  private jobLedger(
    job: SapAiJob,
    stageRun: StageRun | null,
    overrides: { tokens?: number; durationMs?: number; startedAt?: string } = {},
  ): ServerAiStageLedger {
    const startedAt = overrides.startedAt ?? stageRun?.startedAt ?? job.createdAt;
    const durationMs =
      overrides.durationMs ??
      Math.max(0, Date.parse(job.updatedAt) - Date.parse(startedAt));
    return {
      model: job.payload.model,
      promptVersion: job.payload.promptVersion,
      tokens: overrides.tokens ?? 0,
      costUsd: 0,
      durationMs,
      startedAt,
    };
  }

  private log(message: string): void {
    if (this.ctx.config.logger) console.error(`[stage-runner] ${message}`);
  }
}
