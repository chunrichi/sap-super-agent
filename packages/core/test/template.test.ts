import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TemplateValidationError,
  findGate,
  findStage,
  parseTemplate,
  stageKeys,
  validateTemplate,
} from '../src/index.js';

const defaultTemplatePath = fileURLToPath(
  new URL('../../../templates/default.yaml', import.meta.url),
);

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

describe('template loader (H0 minimal subset of docs/003 §2.7)', () => {
  it('loads the committed templates/default.yaml', () => {
    const template = parseTemplate(readFileSync(defaultTemplatePath, 'utf8'));
    expect(template.templateId).toBe('default');
    expect(template.version).toBeGreaterThanOrEqual(1);
    expect(stageKeys(template)).toContain('requirement_analysis');
    expect(findStage(template, 'requirement_analysis')?.executorKind).toBe('server-ai');
    expect(findStage(template, 'dev_implementation')?.executorKind).toBe('vscode');
  });

  it('parses a valid inline template and exposes stages/gates', () => {
    const template = parseTemplate(validYaml);
    expect(template.stages).toHaveLength(1);
    expect(findGate(template, 'G1')?.role).toBe('consultant');
  });

  it('rejects invalid yaml', () => {
    expect(() => parseTemplate('stages: [')).toThrow(TemplateValidationError);
  });

  it('rejects unknown output artifact kinds', () => {
    expect(() =>
      validateTemplate({
        templateId: 'x',
        version: 1,
        stages: [
          {
            key: 'a',
            name: 'A',
            executorKind: 'server-ai',
            inputArtifactKinds: [],
            outputArtifactKind: 'unknown_kind',
            gate: 'none',
            maxAttempts: 1,
            checklist: [],
          },
        ],
        gates: [],
      }),
    ).toThrow(TemplateValidationError);
  });

  it('rejects undefined gate references with a readable issue path', () => {
    try {
      validateTemplate({
        templateId: 'x',
        version: 1,
        stages: [
          {
            key: 'a',
            name: 'A',
            executorKind: 'server-ai',
            inputArtifactKinds: [],
            outputArtifactKind: 'requirement_analysis',
            gate: { gateKey: 'G9', role: 'consultant' },
            maxAttempts: 1,
            checklist: [],
          },
        ],
        gates: [],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateValidationError);
      expect((error as TemplateValidationError).issues.join(' ')).toContain('stages.0.gate');
    }
  });
});
