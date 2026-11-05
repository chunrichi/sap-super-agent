import type { z } from 'zod';
import {
  approvalSchema,
  artifactChainSchema,
  artifactSchema,
  artifactVersionSchema,
  assignmentSchema,
  demandSchema,
  executorSchema,
  leaseSchema,
  notificationSchema,
  stageAttemptSchema,
  stageRunSchema,
  taskSchema,
  taskSummarySchema,
  taskTransferSchema,
  workspaceBindingSchema,
} from './entities.js';
import { apiErrorBodySchema } from './errors.js';
import {
  eventEnvelopeSchema,
  eventsResponseSchema,
  wsTaskOfferedFrameSchema,
} from './events.js';
import {
  approvalDecisionBodySchema,
  approvalDecisionResponseSchema,
  claimTaskResponseSchema,
  createDemandArtifactResponseSchema,
  createDemandBodySchema,
  createDemandResponseSchema,
  demandDetailResponseSchema,
  heartbeatResponseSchema,
  healthResponseSchema,
  listApprovalsResponseSchema,
  listNotificationsResponseSchema,
  markNotificationReadResponseSchema,
  registerExecutorBodySchema,
  registerExecutorResponseSchema,
  taskContextSchema,
  taskDetailResponseSchema,
  transferTaskBodySchema,
  transferTaskResponseSchema,
  withdrawApprovalResponseSchema,
} from './requests.js';
import { stageTemplateFileSchema, stageTemplateSchema } from './templates.js';
// --- S5: SAP-batch AI executor contract (docs/003 §4.8) ---
import {
  sapAiJobClaimBodySchema,
  sapAiJobClaimResponseSchema,
  sapAiJobHeartbeatBodySchema,
  sapAiJobHeartbeatResponseSchema,
  sapAiJobRequeueBodySchema,
  sapAiJobRequeueResponseSchema,
  sapAiJobResultBodySchema,
  sapAiJobResultResponseSchema,
  sapAiJobsNextBodySchema,
  sapAiJobsResponseSchema,
  sapAiJobsStatusSchema,
  sapAiJobSchema,
} from './ai-jobs.js';
// --- S4: generic Hook schemas (docs/008) ---
import {
  hookDefinitionSchema,
  hookEnvelopeSchema,
  hookReceiptBodySchema,
  hookReceiptResponseSchema,
  hookReplayBodySchema,
  hookReplayResponseSchema,
  hooksConfigFileSchema,
  listHooksResponseSchema,
} from './hooks.js';

/**
 * Registry consumed by `scripts/contract-gen.mjs` to snapshot JSON Schema into
 * `contracts/json-schema/`. Only plain zod schemas belong here: `.superRefine`
 * validators (template file, artifact submit body, list-templates response) are
 * not representable as JSON Schema and are validated by zod at runtime instead.
 */
export const contractSchemas = {
  'workspace-binding': workspaceBindingSchema,
  demand: demandSchema,
  'stage-run': stageRunSchema,
  'stage-attempt': stageAttemptSchema,
  task: taskSchema,
  'task-summary': taskSummarySchema,
  assignment: assignmentSchema,
  'task-transfer': taskTransferSchema,
  artifact: artifactSchema,
  'artifact-version': artifactVersionSchema,
  'artifact-chain': artifactChainSchema,
  approval: approvalSchema,
  notification: notificationSchema,
  executor: executorSchema,
  lease: leaseSchema,
  'event-envelope': eventEnvelopeSchema,
  'events-response': eventsResponseSchema,
  'ws-task-offered-frame': wsTaskOfferedFrameSchema,
  'error-body': apiErrorBodySchema,
  'stage-template': stageTemplateSchema,
  'create-demand-body': createDemandBodySchema,
  'create-demand-response': createDemandResponseSchema,
  'demand-detail-response': demandDetailResponseSchema,
  'register-executor-body': registerExecutorBodySchema,
  'register-executor-response': registerExecutorResponseSchema,
  'heartbeat-response': heartbeatResponseSchema,
  'task-detail-response': taskDetailResponseSchema,
  'task-context': taskContextSchema,
  'claim-task-response': claimTaskResponseSchema,
  'transfer-task-body': transferTaskBodySchema,
  'transfer-task-response': transferTaskResponseSchema,
  'list-approvals-response': listApprovalsResponseSchema,
  'approval-decision-body': approvalDecisionBodySchema,
  'approval-decision-response': approvalDecisionResponseSchema,
  'withdraw-approval-response': withdrawApprovalResponseSchema,
  'list-notifications-response': listNotificationsResponseSchema,
  'mark-notification-read-response': markNotificationReadResponseSchema,
  'create-demand-artifact-response': createDemandArtifactResponseSchema,
  'health-response': healthResponseSchema,
  // --- S4: generic Hook contract (docs/008 §2/§4/§6) ---
  'hook-envelope': hookEnvelopeSchema,
  'hook-definition': hookDefinitionSchema,
  'hooks-config': hooksConfigFileSchema,
  'hook-receipt-body': hookReceiptBodySchema,
  'hook-receipt-response': hookReceiptResponseSchema,
  'hook-status': listHooksResponseSchema,
  'hook-replay-body': hookReplayBodySchema,
  'hook-replay-response': hookReplayResponseSchema,
  // --- S5: SAP-batch AI executor (docs/003 §4.8) ---
  'sap-ai-job': sapAiJobSchema,
  'sap-ai-jobs-response': sapAiJobsResponseSchema,
  'sap-ai-jobs-next-body': sapAiJobsNextBodySchema,
  'sap-ai-job-claim-body': sapAiJobClaimBodySchema,
  'sap-ai-job-claim-response': sapAiJobClaimResponseSchema,
  'sap-ai-job-heartbeat-body': sapAiJobHeartbeatBodySchema,
  'sap-ai-job-heartbeat-response': sapAiJobHeartbeatResponseSchema,
  'sap-ai-job-result-body': sapAiJobResultBodySchema,
  'sap-ai-job-result-response': sapAiJobResultResponseSchema,
  'sap-ai-job-requeue-body': sapAiJobRequeueBodySchema,
  'sap-ai-job-requeue-response': sapAiJobRequeueResponseSchema,
  'sap-ai-jobs-status': sapAiJobsStatusSchema,
} satisfies Record<string, z.ZodType>;

export type ContractSchemaName = keyof typeof contractSchemas;

// Re-exported for callers that only need the full template-file validator.
export { stageTemplateFileSchema };
