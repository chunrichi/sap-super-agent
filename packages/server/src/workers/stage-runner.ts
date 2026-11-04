import {
  REQUIREMENT_ANALYSIS_PROMPT_VERSION,
  runRequirementAnalysisStage,
  type RequirementAnalysisInput,
  type RequirementAnalysisOutput,
  type StageRunLedger,
} from '@sap-superagent/ai';
import {
  newUlid,
  type Artifact,
  type ArtifactVersion,
  type Demand,
  type StageRun,
  type StageTemplate,
  type StageTemplateFile,
} from '@sap-superagent/protocol';
import {
  canTransitionDemand,
  collectInputRefs,
  findStage,
  inputArtifactsReady,
  statusAfterFailedAttempt,
  type ArtifactAvailability,
} from '@sap-superagent/core';
import { artifactContentRef, checksumOfBytes, writeArtifactBytes } from '../artifact-store.js';
import {
  insertArtifact,
  insertArtifactVersion,
  latestArtifactRefsByKind,
} from '../db/artifacts.js';
import { getDemand, updateDemand } from '../db/demands.js';
import {
  getStageRun,
  getStageRunByKey,
  insertStageAttempt,
  recoverRunningServerAiStages,
  selectReadyServerAiStageRuns,
  updateStageRun,
} from '../db/stages.js';
import { writeTransaction, type TransactionContext } from '../db/transaction.js';
import type { ServerContext } from '../types.js';

const ARTIFACT_CONTENT_TYPE = 'application/json';
const AI_AUTHOR_ID = 'server-ai';

function toStageInput(demand: Demand): RequirementAnalysisInput {
  return {
    demand: {
      id: demand.id,
      title: demand.title,
      description: demand.description,
      acceptanceCriteria: demand.acceptanceCriteria,
      requester: {
        userId: demand.requester.userId,
        ...(demand.requester.orgUnit !== undefined ? { orgUnit: demand.requester.orgUnit } : {}),
      },
      priority: demand.priority,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drains `server-ai` stage runs on an interval. Each stage is claimed into
 * `running` in its own transaction, the model call happens outside any
 * transaction, and the result is persisted atomically (docs/003 §2.2).
 */
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
    const recovered = recoverRunningServerAiStages(this.ctx.db);
    if (recovered > 0) this.log(`recovered ${recovered} interrupted server-ai stage run(s)`);
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

  private async execute(stageRunId: string): Promise<void> {
    const initial = getStageRun(this.ctx.db, stageRunId);
    if (initial === null || initial.status !== 'ready') return;
    const demand = getDemand(this.ctx.db, initial.demandId);
    if (demand === null) return;
    const template = this.ctx.templates.get(demand.templateId);
    const stageTemplate = template === undefined ? undefined : findStage(template, initial.stageKey);
    if (template === undefined || stageTemplate === undefined) {
      this.markWaitingHuman(stageRunId, `template ${demand.templateId} has no stage "${initial.stageKey}"`);
      return;
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
      return running;
    });
    if (claimed === null) return;

    const startedAtMs = Date.now();
    try {
      const result = await runRequirementAnalysisStage(toStageInput(demand), this.ctx.aiProvider, {
        attempt: claimed.attempt,
      });
      this.completeStage(claimed, stageTemplate, demand, result.output, result.ledger, startedAtMs);
    } catch (error) {
      this.failStage(claimed, stageTemplate, errorMessage(error), Date.now() - startedAtMs);
    }
  }

  private completeStage(
    stageRun: StageRun,
    stageTemplate: StageTemplate,
    demand: Demand,
    output: RequirementAnalysisOutput,
    ledger: StageRunLedger,
    startedAtMs: number,
  ): void {
    const content = JSON.stringify(output, null, 2);
    const bytes = Buffer.from(content, 'utf8');
    const checksum = checksumOfBytes(bytes);
    const artifactId = newUlid();
    const contentRef = artifactContentRef(artifactId, 1);
    writeArtifactBytes(this.ctx.config.stateDir, artifactId, 1, bytes);
    const finishedAt = new Date().toISOString();

    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      const current = getStageRun(this.ctx.db, stageRun.id);
      if (current === null || current.status !== 'running') return;
      const artifact: Artifact = {
        id: artifactId,
        demandId: current.demandId,
        kind: stageTemplate.outputArtifactKind,
        stageKey: current.stageKey,
        stageRunId: current.id,
        state: 'generated',
        currentVersion: 1,
        title: stageTemplate.name,
        createdAt: tx.now,
        updatedAt: tx.now,
      };
      insertArtifact(this.ctx.db, artifact);
      const version: ArtifactVersion = {
        artifactId,
        version: 1,
        contentRef,
        contentType: ARTIFACT_CONTENT_TYPE,
        checksum,
        summary: typeof output['summary'] === 'string' ? output['summary'] : null,
        authorType: 'ai',
        authorId: AI_AUTHOR_ID,
        stale: false,
        createdAt: tx.now,
      };
      insertArtifactVersion(this.ctx.db, version);
      insertStageAttempt(this.ctx.db, {
        stageRunId: current.id,
        attempt: current.attempt,
        model: ledger.model,
        promptVersion: ledger.promptVersion,
        inputRefs: current.inputRefs,
        schemaOk: ledger.schemaOk,
        tokens: ledger.tokens,
        costUsd: ledger.costUsd,
        durationMs: ledger.durationMs,
        error: null,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt,
      });
      updateStageRun(this.ctx.db, {
        ...current,
        status: 'done',
        outputArtifactId: artifactId,
        finishedAt: tx.now,
        updatedAt: tx.now,
      });
      tx.append({
        type: 'artifact.created',
        subject: { type: 'artifact', id: artifactId },
        data: {
          artifactId,
          demandId: current.demandId,
          kind: artifact.kind,
          version: 1,
          checksum,
          contentRef,
          authorType: 'ai',
          authorId: AI_AUTHOR_ID,
          model: ledger.model,
        },
        demandId: current.demandId,
      });
      tx.append({
        type: 'stage.done',
        subject: { type: 'stage_run', id: current.id },
        data: {
          stageRunId: current.id,
          demandId: current.demandId,
          stageKey: current.stageKey,
          attempt: current.attempt,
          outputArtifactId: artifactId,
          tokens: ledger.tokens,
          costUsd: ledger.costUsd,
        },
        demandId: current.demandId,
      });
      const template = this.ctx.templates.get(demand.templateId);
      if (template !== undefined) this.advance(tx, demand.templateId, template, current.demandId, current.stageKey);
    });
  }

  private failStage(
    stageRun: StageRun,
    stageTemplate: StageTemplate,
    message: string,
    durationMs: number,
  ): void {
    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      const current = getStageRun(this.ctx.db, stageRun.id);
      if (current === null || current.status !== 'running') return;
      const maxAttempts = stageTemplate.maxAttempts;
      insertStageAttempt(this.ctx.db, {
        stageRunId: current.id,
        attempt: current.attempt,
        model: null,
        promptVersion: REQUIREMENT_ANALYSIS_PROMPT_VERSION,
        inputRefs: current.inputRefs,
        schemaOk: false,
        tokens: 0,
        costUsd: 0,
        durationMs: Math.max(0, durationMs),
        error: message,
        startedAt: current.startedAt ?? tx.now,
        finishedAt: tx.now,
      });
      const next = statusAfterFailedAttempt(current.attempt, maxAttempts);
      tx.append({
        type: 'stage.failed',
        subject: { type: 'stage_run', id: current.id },
        data: {
          stageRunId: current.id,
          demandId: current.demandId,
          stageKey: current.stageKey,
          attempt: current.attempt,
          error: message,
          willRetry: next === 'ready',
          nextAttempt: next === 'ready' ? current.attempt + 1 : null,
        },
        demandId: current.demandId,
      });
      if (next === 'ready') {
        updateStageRun(this.ctx.db, {
          ...current,
          status: 'ready',
          attempt: current.attempt + 1,
          startedAt: null,
          finishedAt: null,
          updatedAt: tx.now,
        });
        return;
      }
      updateStageRun(this.ctx.db, {
        ...current,
        status: 'waiting_human',
        finishedAt: tx.now,
        updatedAt: tx.now,
      });
      tx.append({
        type: 'stage.waiting_human',
        subject: { type: 'stage_run', id: current.id },
        data: {
          stageRunId: current.id,
          demandId: current.demandId,
          stageKey: current.stageKey,
          attempt: current.attempt,
          error: message,
        },
        demandId: current.demandId,
      });
    });
  }

  private advance(
    tx: TransactionContext,
    templateId: string,
    template: StageTemplateFile,
    demandId: string,
    doneStageKey: string,
  ): void {
    const index = template.stages.findIndex((stage) => stage.key === doneStageKey);
    const next = index < 0 ? undefined : template.stages[index + 1];
    const demand = getDemand(this.ctx.db, demandId);
    if (demand === null) return;
    if (next === undefined) {
      if (!canTransitionDemand(demand.status, 'review')) return;
      updateDemand(this.ctx.db, { ...demand, status: 'review', updatedAt: tx.now });
      tx.append({
        type: 'demand.updated',
        subject: { type: 'demand', id: demandId },
        data: { demandId, status: 'review', reason: 'all_stages_done' },
        demandId,
      });
      return;
    }
    const stageRun = getStageRunByKey(this.ctx.db, demandId, next.key);
    if (stageRun === null || stageRun.status !== 'pending') return;
    const byKind = latestArtifactRefsByKind(this.ctx.db, demandId);
    const availability: ArtifactAvailability = { byKind };
    if (!inputArtifactsReady(next, availability)) return;
    updateStageRun(this.ctx.db, {
      ...stageRun,
      status: 'ready',
      inputRefs: collectInputRefs(next, availability),
      updatedAt: tx.now,
    });
    tx.append({
      type: 'stage.ready',
      subject: { type: 'stage_run', id: stageRun.id },
      data: {
        stageRunId: stageRun.id,
        demandId,
        stageKey: next.key,
        executorKind: stageRun.executorKind,
        templateId,
      },
      demandId,
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
        data: { stageRunId: current.id, demandId: current.demandId, stageKey: current.stageKey },
        demandId: current.demandId,
      });
    });
  }

  private log(message: string): void {
    if (this.ctx.config.logger) console.error(`[stage-runner] ${message}`);
  }
}
