import { describe, expect, it } from 'vitest';
import { stageTemplateFileSchema, stageTemplateSchema } from '../src/index.js';

const analysisStage = {
  key: 'requirement_analysis',
  name: '需求分析',
  executorKind: 'server-ai',
  inputArtifactKinds: [],
  outputArtifactKind: 'requirement_analysis',
  gate: 'none',
  maxAttempts: 2,
  checklist: ['sections_present'],
};

const devStage = {
  key: 'dev_implementation',
  name: '开发实现',
  executorKind: 'vscode',
  inputArtifactKinds: ['requirement_analysis'],
  outputArtifactKind: 'code_change',
  gate: 'none',
  maxAttempts: 2,
  checklist: ['inputs_referenced'],
};

const validTemplate = {
  templateId: 'default',
  version: 1,
  stages: [analysisStage, devStage],
  gates: [],
};

describe('stage template schema (docs/003 §2.7)', () => {
  it('accepts the H0 default template shape', () => {
    expect(stageTemplateFileSchema.safeParse(validTemplate).success).toBe(true);
  });

  it('rejects duplicate stage keys', () => {
    const duplicated = {
      ...validTemplate,
      stages: [analysisStage, analysisStage],
    };
    expect(stageTemplateFileSchema.safeParse(duplicated).success).toBe(false);
  });

  it('rejects a stage gate that is not declared in gates', () => {
    const withGate = {
      ...validTemplate,
      stages: [
        {
          ...analysisStage,
          gate: { gateKey: 'G1', role: 'consultant' },
        },
      ],
    };
    expect(stageTemplateFileSchema.safeParse(withGate).success).toBe(false);
  });

  it('accepts a gate reference that is declared', () => {
    const withGate = {
      ...validTemplate,
      stages: [
        {
          ...analysisStage,
          gate: { gateKey: 'G1', role: 'consultant' },
        },
      ],
      gates: [{ gateKey: 'G1', role: 'consultant', timeoutDays: 3 }],
    };
    expect(stageTemplateFileSchema.safeParse(withGate).success).toBe(true);
  });

  it('rejects unknown artifact kinds and executor kinds', () => {
    expect(
      stageTemplateFileSchema.safeParse({
        ...validTemplate,
        stages: [{ ...analysisStage, outputArtifactKind: 'design_doc' }],
      }).success,
    ).toBe(false);
    expect(
      stageTemplateFileSchema.safeParse({
        ...validTemplate,
        stages: [{ ...analysisStage, executorKind: 'ci' }],
      }).success,
    ).toBe(false);
  });

  it('rejects malformed stage keys and zero attempts', () => {
    expect(
      stageTemplateSchema.safeParse({ ...analysisStage, key: 'Stage-One' }).success,
    ).toBe(false);
    expect(
      stageTemplateSchema.safeParse({ ...analysisStage, maxAttempts: 0 }).success,
    ).toBe(false);
  });
});
