import { z } from 'zod';
import { artifactKindSchema, executorKindSchema, roleSchema } from './enums.js';

// ---------------------------------------------------------------------------
// Stage templates (docs/003 §2.7)
//
// Templates are configuration, not code branches: a `templateId@version` pair is
// fixed on a Demand at creation time, so later template edits only affect new
// demands. See H1 for the full 3-stage / 6-stage presets.
// ---------------------------------------------------------------------------

export const STAGE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

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
    /** Declarative, decidable assertions evaluated on stage completion (H1). */
    checklist: z.array(z.string().min(1)),
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
      if (
        gateRef !== 'none' &&
        !template.gates.some((gate) => gate.gateKey === gateRef.gateKey)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `stage "${stage.key}" references unknown gate: ${gateRef.gateKey}`,
          path: ['stages', index, 'gate'],
        });
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
