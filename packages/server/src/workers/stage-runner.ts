import {
  StageOutputError,
  resolveAiStageDefinition,
  runAiStage,
  type AiStageDefinition,
  type AiStageInput,
  type AiStageUpstreamArtifact,
  type StageRunLedger,
} from '@sap-superagent/ai';
import { canTransitionDemand, evaluateStageCompletion, findStage } from '@sap-superagent/core';
import {
  type Demand,
  type StageRun,
  type StageTemplate,
  type StageTemplateFile,
} from '@sap-superagent/protocol';
import { readArtifactBytes } from '../artifact-store.js';
import { latestArtifactRefsByKind, latestVersionsByKind } from '../db/artifacts.js';
import { getDemand, updateDemand } from '../db/demands.js';
import {
  getStageRun,
  insertStageAttempt,
  recoverRunningServerAiStages,
  selectReadyServerAiStageRuns,
  updateStageRun,
} from '../db/stages.js';
import { writeTransaction } from '../db/transaction.js';
import { completeStageAfterArtifact, failStageAttempt, persistStageArtifact } from '../stage-engine.js';
import type { ServerContext } from '../types.js';

// ---------------------------------------------------------------------------
// Server-AI stage runner (docs/003 §2.2, H1 §1.1): drains ready `server-ai`
// stage runs from the loaded template, resolves the stage by key in the AI
// stage registry, validates schema + checklist before persisting anything and
// then hands over to the gate/advance engine.
// ---------------------------------------------------------------------------

const AI_AUTHOR_ID = 'server-ai';
const ARTIFACT_CONTENT_TYPE = 'application/json';
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
      return running;
    });
    if (claimed === null) return;

    const stageInput: AiStageInput = {
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

    const startedAtMs = Date.now();
    try {
      const result = await runAiStage(definition, stageInput, this.ctx.aiProvider, {
        attempt: claimed.attempt,
      });
      this.completeStage(claimed, template, stageTemplate, result.output, result.ledger, startedAtMs);
    } catch (error) {
      this.failStage(claimed, template, stageTemplate, error, Date.now() - startedAtMs);
    }
  }

  private completeStage(
    stageRun: StageRun,
    template: StageTemplateFile,
    stageTemplate: StageTemplate,
    output: unknown,
    ledger: StageRunLedger,
    startedAtMs: number,
  ): void {
    const contentText = JSON.stringify(output, null, 2);
    const structured = typeof output === 'object' && output !== null ? output : null;
    writeTransaction(this.ctx.db, (events) => this.ctx.hub.broadcast(events), (tx) => {
      const current = getStageRun(this.ctx.db, stageRun.id);
      if (current === null || current.status !== 'running') return;
      const demand = getDemand(this.ctx.db, current.demandId);
      if (demand === null) return;
      const latestInputRefs = latestArtifactRefsByKind(this.ctx.db, demand.id);
      const completion = evaluateStageCompletion({
        stage: stageTemplate,
        demand,
        outputText: contentText,
        outputJson: structured,
        inputRefs: current.inputRefs,
        latestInputRefs,
        outputStale: false,
        schemaOk: true,
      });
      const ledgerRecord = {
        model: ledger.model,
        promptVersion: ledger.promptVersion,
        schemaOk: true,
        tokens: ledger.tokens,
        costUsd: ledger.costUsd,
        durationMs: ledger.durationMs,
        startedAt: new Date(startedAtMs).toISOString(),
      };
      if (!completion.ok) {
        const reason = `checklist: ${completion.failures.join('; ')}`;
        failStageAttempt(tx, this.ctx, {
          demand,
          template,
          stageRun: current,
          stageTemplate,
          reason,
          error: reason,
          ledger: ledgerRecord,
        });
        return;
      }
      insertStageAttempt(this.ctx.db, {
        stageRunId: current.id,
        attempt: current.attempt,
        model: ledger.model,
        promptVersion: ledger.promptVersion,
        inputRefs: current.inputRefs,
        schemaOk: true,
        tokens: ledger.tokens,
        costUsd: ledger.costUsd,
        durationMs: ledger.durationMs,
        error: null,
        startedAt: ledgerRecord.startedAt,
        finishedAt: tx.now,
      });
      const summary =
        typeof (output as Record<string, unknown>)['summary'] === 'string'
          ? ((output as Record<string, unknown>)['summary'] as string)
          : null;
      const persisted = persistStageArtifact(tx, this.ctx, {
        demand,
        template,
        stageRun: current,
        stageTemplate,
        output: {
          contentText,
          contentType: ARTIFACT_CONTENT_TYPE,
          authorType: 'ai',
          authorId: AI_AUTHOR_ID,
          summary,
          title: stageTemplate.name,
        },
      });
      completeStageAfterArtifact(tx, this.ctx, {
        demand,
        template,
        stageRun: current,
        stageTemplate,
        artifact: persisted.artifact,
        artifactVersion: persisted.artifactVersion,
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

  private log(message: string): void {
    if (this.ctx.config.logger) console.error(`[stage-runner] ${message}`);
  }
}
