import { z } from 'zod';
import {
  artifactKindSchema,
  autonomyModeSchema,
  checklistAssertionSchema,
  executorKindSchema,
  roleSchema,
} from './enums.js';

// ---------------------------------------------------------------------------
// Stage templates (docs/003 §2.7)
//
// Templates are configuration, not code branches: a `templateId@version` pair is
// fixed on a Demand at creation time, so later template edits only affect new
// demands. See docs/003 §2.7 for the full 3-stage / 6-stage presets.
// ---------------------------------------------------------------------------

export const STAGE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Default gate timeout from docs/007 §0 (超时 3 天升级提醒). */
export const DEFAULT_GATE_TIMEOUT_DAYS = 3;

export const gateRefSchema = z.union([
  z.literal('none'),
  z
    .object({
      gateKey: z.string().min(1),
      role: roleSchema,
    })
    .strict(),
]);
export type GateRef = z.infer<typeof gateRefSchema>;

export const stageTemplateSchema = z
  .object({
    key: z.string().regex(STAGE_KEY_PATTERN, 'stage key must be lower_snake_case'),
    name: z.string().min(1),
    executorKind: executorKindSchema,
    inputArtifactKinds: z.array(artifactKindSchema),
    outputArtifactKind: artifactKindSchema,
    gate: gateRefSchema,
    maxAttempts: z.number().int().min(1).max(10),
    /**
     * `observe` (default for new server-AI stages, docs/005 §3.2) keeps the
     * generated artifact as a draft and parks the stage at `waiting_human`;
     * `auto` advances according to the gate rules. See docs/003 §2.7.
     */
    autonomy: autonomyModeSchema.default('auto'),
    /** Roles allowed to claim the stage's task (vscode stages only). */
    requiredRoles: z.array(roleSchema).default([]),
    /** Declarative, decidable assertions evaluated on stage completion (docs/003 §2.2). */
    checklist: z.array(checklistAssertionSchema),
  })
  .strict();
export type StageTemplate = z.infer<typeof stageTemplateSchema>;

export const gateTemplateSchema = z
  .object({
    gateKey: z.string().min(1),
    role: roleSchema,
    timeoutDays: z.number().int().positive(),
  })
  .strict();
export type GateTemplate = z.infer<typeof gateTemplateSchema>;

export const stageTemplateFileSchema = z
  .object({
    templateId: z.string().min(1),
    version: z.number().int().positive(),
    stages: z.array(stageTemplateSchema).min(1),
    gates: z.array(gateTemplateSchema),
  })
  .strict()
  .superRefine((template, ctx) => {
    const stageKeys = new Set<string>();
    for (const [index, stage] of template.stages.entries()) {
      if (stageKeys.has(stage.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate stage key: ${stage.key}`,
          path: ['stages', index, 'key'],
        });
      }
      stageKeys.add(stage.key);

      const gateRef = stage.gate;
      if (gateRef !== 'none') {
        const gate = template.gates.find((candidate) => candidate.gateKey === gateRef.gateKey);
        if (gate === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `stage "${stage.key}" references unknown gate: ${gateRef.gateKey}`,
            path: ['stages', index, 'gate'],
          });
        } else if (gate.role !== gateRef.role) {
          // Two sources of truth for the approver role would be ambiguous; keep
          // the gate definition authoritative and reject drifting stage refs.
          ctx.addIssue({
            code: 'custom',
            message: `stage "${stage.key}" gate ${gateRef.gateKey} role "${gateRef.role}" does not match gate definition role "${gate.role}"`,
            path: ['stages', index, 'gate', 'role'],
          });
        }
      }
    }

    const gateKeys = new Set<string>();
    for (const [index, gate] of template.gates.entries()) {
      if (gateKeys.has(gate.gateKey)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate gate key: ${gate.gateKey}`,
          path: ['gates', index, 'gateKey'],
        });
      }
      gateKeys.add(gate.gateKey);
    }

    const outputRefs = new Set<string>();
    for (const [index, stage] of template.stages.entries()) {
      if (outputRefs.has(stage.outputArtifactKind)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate output artifact kind: ${stage.outputArtifactKind}`,
          path: ['stages', index, 'outputArtifactKind'],
        });
      }
      outputRefs.add(stage.outputArtifactKind);
    }
  });
export type StageTemplateFile = z.infer<typeof stageTemplateFileSchema>;

/** The template a demand is pinned to (docs/003 §2.7). */
export const templateRefSchema = z
  .object({
    templateId: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();
export type TemplateRef = z.infer<typeof templateRefSchema>;

export const DEFAULT_TEMPLATE_ID = 'default';

/** Stage key of the first stage of the built-in default template (S0). */
export const REQUIREMENT_ANALYSIS_STAGE_KEY = 'requirement_analysis';
