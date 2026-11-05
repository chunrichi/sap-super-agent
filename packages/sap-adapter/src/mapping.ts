import type { Approval, DemandStatus, Priority, StageRun } from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// Field/mapping layer between the control plane (docs/003) and the SAP ICF
// JSON projection (docs/004 §2.1 / §3.2). This module is the single source of
// truth for the SAP `STATUS` projection so neither side re-implements it.
// ---------------------------------------------------------------------------

/** Business-facing SAP `ZSA_DEMAND-STATUS` values (docs/004 §2.1). */
export const SAP_DEMAND_STATUS = {
  awaitingAnalysis: '待分析',
  analysing: '分析中',
  awaitingConfirmation: '待确认',
  developing: '开发中',
  awaitingAcceptance: '待验收',
  completed: '已完成',
  cancelled: '已取消',
  rejected: '已驳回',
} as const;

export type SapDemandStatus = (typeof SAP_DEMAND_STATUS)[keyof typeof SAP_DEMAND_STATUS];

export const SAP_DEMAND_STATUS_VALUES: readonly SapDemandStatus[] = Object.values(SAP_DEMAND_STATUS);

export interface SapStatusProjection {
  status: SapDemandStatus;
  statusText: SapDemandStatus;
}

type StageView = Pick<StageRun, 'status' | 'executorKind' | 'stageKey'>;
type ApprovalView = Pick<Approval, 'state'>;

export interface StatusProjectionInput {
  demand: Pick<{ status: DemandStatus }, 'status'>;
  /** Ordered stage runs of the demand (template order). */
  stages: readonly StageView[];
  /** Optional gate records; a pending approval projects to 待确认. */
  approvals?: readonly ApprovalView[];
  /** Explicit override (e.g. reconcile readback) — kept internal to mapping. */
}

function isServerAiStage(stage: StageView): boolean {
  return stage.executorKind === 'server-ai';
}

function isVscodeStage(stage: StageView): boolean {
  return stage.executorKind === 'vscode';
}

/**
 * Project control-plane state onto the SAP business status (docs/004 §2.1).
 *
 * Order matters and is the documented order:
 * terminal demand → pending approval → server-ai running → dev stage running/
 * waiting for dispatch → submitted (awaiting analysis) → all done (review).
 */
export function projectSapStatus(input: StatusProjectionInput): SapStatusProjection {
  const { demand, stages } = input;
  const status: SapDemandStatus = (() => {
    if (demand.status === 'done') return SAP_DEMAND_STATUS.completed;
    if (demand.status === 'cancelled') return SAP_DEMAND_STATUS.cancelled;
    if (demand.status === 'rejected') return SAP_DEMAND_STATUS.rejected;

    if ((input.approvals ?? []).some((approval) => approval.state === 'pending')) {
      return SAP_DEMAND_STATUS.awaitingConfirmation;
    }
    if (stages.some((stage) => isServerAiStage(stage) && stage.status === 'running')) {
      return SAP_DEMAND_STATUS.analysing;
    }
    // A gate reached by any stage is waiting on a human decision.
    if (stages.some((stage) => stage.status === 'waiting_human')) {
      return SAP_DEMAND_STATUS.awaitingConfirmation;
    }
    if (
      stages.some(
        (stage) =>
          isVscodeStage(stage) && (stage.status === 'ready' || stage.status === 'running'),
      )
    ) {
      return SAP_DEMAND_STATUS.developing;
    }
    if (demand.status === 'review') return SAP_DEMAND_STATUS.awaitingAcceptance;
    if (stages.length > 0 && stages.every((stage) => stage.status === 'done')) {
      return SAP_DEMAND_STATUS.awaitingAcceptance;
    }
    if (stages.some((stage) => isServerAiStage(stage) && stage.status === 'ready')) {
      return SAP_DEMAND_STATUS.analysing;
    }
    return SAP_DEMAND_STATUS.awaitingAnalysis;
  })();
  return { status, statusText: status };
}

/**
 * Best-effort reverse mapping used by reconcile reports only. It never drives
 * execution state: SAP stores the projection, not the truth (docs/004 §1).
 */
export function sapStatusToDemandStatus(status: string): DemandStatus | null {
  switch (status) {
    case SAP_DEMAND_STATUS.awaitingAnalysis:
    case SAP_DEMAND_STATUS.analysing:
    case SAP_DEMAND_STATUS.awaitingConfirmation:
    case SAP_DEMAND_STATUS.developing:
      return 'in_progress';
    case SAP_DEMAND_STATUS.awaitingAcceptance:
      return 'review';
    case SAP_DEMAND_STATUS.completed:
      return 'done';
    case SAP_DEMAND_STATUS.cancelled:
      return 'cancelled';
    case SAP_DEMAND_STATUS.rejected:
      return 'rejected';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// SAP ICF JSON shapes (docs/004 §2 / §3.2). Kept permissive on input (SAP may
// add fields) and strict on output.
// ---------------------------------------------------------------------------

export interface SapDemandRecord {
  demandId: string;
  demandNo?: string | null;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string[] | null;
  requesterUserId?: string | null;
  orgUnit?: string | null;
  priority?: string | null;
  status?: string | null;
  statusText?: string | null;
  repoKey?: string | null;
  projectKey?: string | null;
  templateId?: string | null;
  /** SAP-side optimistic-concurrency version (If-Match / ETag projection). */
  version?: number | null;
  createdAt?: string | null;
  changedAt?: string | null;
  stageKey?: string | null;
}

export interface SapArtifactRecord {
  artifactId: string;
  demandId: string;
  stageKey: string;
  stageRunId?: string | null;
  kind: string;
  version: number;
  checksum: string;
  contentRef: string;
  contentType?: string | null;
  status?: string | null;
  authorType?: string | null;
  authorId?: string | null;
  createdAt?: string | null;
}

export interface SapApprovalRecord {
  approvalId: string;
  demandId: string;
  stageKey?: string | null;
  gateKey: string;
  state: string;
  requiredRole?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  comment?: string | null;
}

export interface SapDemandCreateInput {
  demandId: string;
  no?: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requester: { userId: string; orgUnit?: string };
  priority: Priority;
  templateId?: string;
  /** `null` = unbound demand (general task inbox), docs/003 §3 rule 4. */
  workspaceBinding: { repo: string; projectKey?: string; baseBranch?: string } | null;
  source: 'sap';
}

const PRIORITIES: readonly Priority[] = ['high', 'normal', 'low'];

function asPriority(value: string | null | undefined): Priority {
  return PRIORITIES.find((candidate) => candidate === value) ?? 'normal';
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Map a SAP demand snapshot onto the control-plane `POST /demands` shape
 * (docs/003 §4.3). `demandId` stays the SAP UUID C32 — the control plane never
 * re-generates it (docs/003 §4.1).
 */
export function mapSapDemandToControlPlane(record: SapDemandRecord): SapDemandCreateInput {
  const demandId = cleanText(record.demandId);
  if (!/^[0-9a-fA-F]{32}$/.test(demandId)) {
    throw new Error(`sap demandId must be a 32-char UUID C32 (received "${demandId}")`);
  }
  const title = cleanText(record.title);
  if (title.length === 0) throw new Error('sap demand title must not be empty');
  const requesterUserId = cleanText(record.requesterUserId);
  if (requesterUserId.length === 0) throw new Error('sap demand requesterUserId must not be empty');

  const orgUnit = cleanText(record.orgUnit);
  const repoKey = cleanText(record.repoKey);
  const projectKey = cleanText(record.projectKey);
  const no = cleanText(record.demandNo);
  const templateId = cleanText(record.templateId);
  return {
    demandId: demandId.toLowerCase(),
    ...(no.length === 0 ? {} : { no }),
    title: title.slice(0, 200),
    description: cleanText(record.description),
    acceptanceCriteria: (record.acceptanceCriteria ?? []).filter((item) => item.length > 0).slice(0, 50),
    requester: {
      userId: requesterUserId,
      ...(orgUnit.length === 0 ? {} : { orgUnit }),
    },
    priority: asPriority(record.priority ?? null),
    ...(templateId.length === 0 ? {} : { templateId }),
    workspaceBinding:
      repoKey.length === 0
        ? null
        : {
            repo: repoKey,
            ...(projectKey.length === 0 ? {} : { projectKey }),
          },
    source: 'sap',
  };
}

export interface SapWritebackArtifact {
  artifactId: string;
  stageKey: string | null;
  stageRunId: string | null;
  kind: string;
  version: number;
  checksum: string;
  contentRef: string;
  contentType: string;
  status: string;
}

export interface SapWritebackPatch {
  status: SapDemandStatus;
  statusText: SapDemandStatus;
  stageKey: string | null;
  artifacts?: readonly SapWritebackArtifact[];
  approval?: {
    gateKey: string | null;
    state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
    decidedBy: string | null;
    comment: string | null;
    decidedAt: string | null;
  };
}

/** Whitelisted PATCH body (docs/004 §3.2: status projection + artifact metadata only). */
export function buildSapWritebackPatch(input: {
  projection: SapStatusProjection;
  stageKey?: string | null;
  artifacts?: readonly SapWritebackArtifact[];
  approval?: SapWritebackPatch['approval'];
}): SapWritebackPatch {
  return {
    status: input.projection.status,
    statusText: input.projection.statusText,
    stageKey: input.stageKey ?? null,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  };
}

/** Fields the control plane must never write back to SAP (business-owned). */
export const SAP_WRITEBACK_FORBIDDEN_FIELDS: readonly string[] = [
  'title',
  'description',
  'acceptanceCriteria',
  'requester',
  'repoKey',
  'projectKey',
  'priority',
];

/** Guard used by the writeback worker/tests to prove the whitelist (docs/004 §3.2). */
export function assertWhitelistedWriteback(patch: Record<string, unknown>): void {
  const allowed = new Set(['status', 'statusText', 'stageKey', 'artifacts', 'approval']);
  for (const key of Object.keys(patch)) {
    if (SAP_WRITEBACK_FORBIDDEN_FIELDS.includes(key)) {
      throw new Error(`writeback must not modify business field "${key}"`);
    }
    if (!allowed.has(key)) throw new Error(`writeback field "${key}" is not whitelisted`);
  }
}
