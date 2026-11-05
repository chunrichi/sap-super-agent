import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TemplateValidationError,
  findGate,
  findStage,
  gateForStage,
  nextStage,
  parseTemplate,
  stageIndex,
  stageKeys,
  templateVersionKey,
  validateTemplate,
} from '../src/index.js';

const defaultTemplatePath = fileURLToPath(
  new URL('../../../templates/default.yaml', import.meta.url),
);
const pdoTemplatePath = fileURLToPath(new URL('../../../templates/pdo.yaml', import.meta.url));

const validYaml = `
templateId: test
version: 1
stages:
  - key: requirement_analysis
    name: 需求分析
    executorKind: server-ai
    inputArtifactKinds: []
    outputArtifactKind: requirement_analysis
    gate: none
    maxAttempts: 2
    checklist: [sections_present]
gates:
  - gateKey: G1
    role: consultant
    timeoutDays: 3
`;

function stageFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'a',
    name: 'A',
    executorKind: 'server-ai',
    inputArtifactKinds: [],
    outputArtifactKind: 'requirement_analysis',
    gate: 'none',
    maxAttempts: 1,
    checklist: [],
    ...overrides,
  };
}

describe('template loader (docs/003 §2.7)', () => {
  it('loads the committed templates/default.yaml as the S1 3-stage template', () => {
    const template = parseTemplate(readFileSync(defaultTemplatePath, 'utf8'));
    expect(template.templateId).toBe('default');
    expect(template.version).toBe(1);
    expect(stageKeys(template)).toEqual([
      'requirement_analysis',
      'dev_implementation',
      'acceptance_archive',
    ]);
    expect(findStage(template, 'requirement_analysis')?.executorKind).toBe('server-ai');
    expect(findStage(template, 'dev_implementation')?.executorKind).toBe('vscode');

    const analysis = findStage(template, 'requirement_analysis');
    const dev = findStage(template, 'dev_implementation');
    const archive = findStage(template, 'acceptance_archive');
    expect(analysis?.gate).toEqual({ gateKey: 'G1', role: 'consultant' });
    expect(dev?.gate).toEqual({ gateKey: 'G3', role: 'consultant' });
    expect(archive?.gate).toEqual({ gateKey: 'G4', role: 'requester' });
    expect(analysis?.autonomy).toBe('observe');
    expect(dev?.requiredRoles).toEqual(['developer']);
    expect(analysis?.checklist).toEqual(['sections_present', 'acceptance_covered']);
    expect(gateForStage(template, dev!)?.timeoutDays).toBe(3);
  });

  it('loads the committed templates/pdo.yaml as the 6-stage / G1–G5 preset', () => {
    const template = parseTemplate(readFileSync(pdoTemplatePath, 'utf8'));
    expect(template.templateId).toBe('pdo');
    expect(stageKeys(template)).toEqual([
      'intake',
      'requirement_analysis',
      'dev_spec',
      'dev_implementation',
      'test_acceptance',
      'knowledge_archive',
    ]);
    expect(template.gates.map((gate) => gate.gateKey)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
    expect(findStage(template, 'intake')?.gate).toBe('none');
    expect(findStage(template, 'intake')?.autonomy).toBe('observe');
    expect(findStage(template, 'dev_implementation')?.executorKind).toBe('vscode');
  });

  it('parses a valid inline template and exposes stages/gates', () => {
    const template = parseTemplate(validYaml);
    expect(template.stages).toHaveLength(1);
    expect(findGate(template, 'G1')?.role).toBe('consultant');
    // New fields are optional and default to auto / no required roles.
    expect(template.stages[0]?.autonomy).toBe('auto');
    expect(template.stages[0]?.requiredRoles).toEqual([]);
  });

  it('orders stages and resolves the next stage / version key', () => {
    const template = parseTemplate(readFileSync(defaultTemplatePath, 'utf8'));
    expect(stageIndex(template, 'dev_implementation')).toBe(1);
    expect(stageIndex(template, 'missing')).toBe(-1);
    expect(nextStage(template, 'requirement_analysis')?.key).toBe('dev_implementation');
    expect(nextStage(template, 'acceptance_archive')).toBeUndefined();
    expect(templateVersionKey('default', 2)).toBe('default@2');
  });

  it('rejects invalid yaml', () => {
    expect(() => parseTemplate('stages: [')).toThrow(TemplateValidationError);
  });

  it('rejects unknown output artifact kinds', () => {
    expect(() =>
      validateTemplate({
        templateId: 'x',
        version: 1,
        stages: [stageFixture({ outputArtifactKind: 'unknown_kind' })],
        gates: [],
      }),
    ).toThrow(TemplateValidationError);
  });

  it('rejects unknown checklist assertions', () => {
    expect(() =>
      validateTemplate({
        templateId: 'x',
        version: 1,
        stages: [stageFixture({ checklist: ['looks_good'] })],
        gates: [],
      }),
    ).toThrow(TemplateValidationError);
  });

  it('rejects duplicate output artifact kinds (one version chain per kind)', () => {
    try {
      validateTemplate({
        templateId: 'x',
        version: 1,
        stages: [
          stageFixture({ key: 'a', outputArtifactKind: 'requirement_analysis' }),
          stageFixture({ key: 'b', outputArtifactKind: 'requirement_analysis' }),
        ],
        gates: [],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateValidationError);
      expect((error as TemplateValidationError).issues.join(' ')).toContain('duplicate output artifact kind');
    }
  });

  it('rejects undefined gate references with a readable issue path', () => {
    try {
      validateTemplate({
        templateId: 'x',
        version: 1,
        stages: [stageFixture({ gate: { gateKey: 'G9', role: 'consultant' } })],
        gates: [],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateValidationError);
      expect((error as TemplateValidationError).issues.join(' ')).toContain('stages.0.gate');
    }
  });

  it('rejects a stage gate whose role drifts from the gate definition', () => {
    try {
      validateTemplate({
        templateId: 'x',
        version: 1,
        stages: [stageFixture({ gate: { gateKey: 'G1', role: 'developer' } })],
        gates: [{ gateKey: 'G1', role: 'consultant', timeoutDays: 3 }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateValidationError);
      expect((error as TemplateValidationError).issues.join(' ')).toContain('does not match gate definition');
    }
  });
});
