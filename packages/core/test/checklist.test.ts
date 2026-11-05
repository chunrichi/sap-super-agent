import { describe, expect, it } from 'vitest';
import type { ArtifactKind, ArtifactRef, StageTemplate } from '@sap-superagent/protocol';
import {
  ARTIFACT_REQUIRED_SECTIONS,
  evaluateChecklist,
  evaluateStageCompletion,
  normalizeCriterionText,
  parseStructuredOutput,
  type ChecklistContext,
} from '../src/index.js';
import { ULID_A, ULID_B } from './fixtures.js';

function stage(overrides: Partial<StageTemplate> = {}): StageTemplate {
  return {
    key: 'dev_spec',
    name: '开发说明',
    executorKind: 'server-ai',
    inputArtifactKinds: ['requirement_analysis'],
    outputArtifactKind: 'dev_spec',
    gate: 'none',
    maxAttempts: 2,
    autonomy: 'observe',
    requiredRoles: [],
    checklist: [],
    ...overrides,
  };
}

function refs(entries: Array<[ArtifactKind, ArtifactRef]>): Map<ArtifactKind, ArtifactRef> {
  return new Map(entries);
}

function context(overrides: Partial<ChecklistContext> = {}): ChecklistContext {
  const outputJson = {
    summary: '开发说明',
    changes: [{ file: 'z.prog.abap', description: '新增取数逻辑' }],
    testPlan: ['单测', '集成测试'],
    risks: ['无'],
    acceptanceCriteria: [
      { criterion: '金额与 MARA 一致', anchor: '金额与 MARA 一致' },
      { criterion: '空结果返回 0', anchor: '空结果返回 0' },
    ],
  };
  return {
    stage: stage(),
    demand: { acceptanceCriteria: ['金额与 MARA 一致', '空结果返回 0'] },
    outputText: JSON.stringify(outputJson),
    outputJson,
    inputRefs: [{ artifactId: ULID_A, version: 1 }],
    latestInputRefs: refs([['requirement_analysis', { artifactId: ULID_A, version: 1 }]]),
    outputStale: false,
    ...overrides,
  };
}

describe('checklist assertions (docs/003 §2.2 / §2.7)', () => {
  it('passes all four assertions for a complete, current output', () => {
    const result = evaluateChecklist(
      ['sections_present', 'inputs_referenced', 'not_stale', 'acceptance_covered'],
      context(),
    );
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.results.map((entry) => entry.key)).toEqual([
      'sections_present',
      'inputs_referenced',
      'not_stale',
      'acceptance_covered',
    ]);
  });

  it('sections_present rejects JSON missing a required section', () => {
    const result = evaluateChecklist(['sections_present'], context({ outputJson: { summary: 'x' } }));
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toContain('changes');
  });

  it('sections_present rejects non-JSON output for structured kinds but accepts code_change', () => {
    const structured = evaluateChecklist(
      ['sections_present'],
      context({ outputJson: null, outputText: 'not json' }),
    );
    expect(structured.passed).toBe(false);

    const code = evaluateChecklist(
      ['sections_present'],
      context({
        stage: stage({ outputArtifactKind: 'code_change', checklist: ['sections_present'] }),
        outputJson: null,
        outputText: 'diff --git a/x b/x',
      }),
    );
    expect(code.passed).toBe(true);
    expect(ARTIFACT_REQUIRED_SECTIONS.code_change).toEqual([]);
  });

  it('inputs_referenced fails when the stage was based on an older upstream version', () => {
    const result = evaluateChecklist(
      ['inputs_referenced'],
      context({
        inputRefs: [{ artifactId: ULID_A, version: 1 }],
        latestInputRefs: refs([['requirement_analysis', { artifactId: ULID_A, version: 2 }]]),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toContain('v2');
  });

  it('inputs_referenced fails when a declared upstream artifact is missing', () => {
    const result = evaluateChecklist(
      ['inputs_referenced'],
      context({ inputRefs: [], latestInputRefs: new Map() }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toContain('missing upstream artifact');
  });

  it('not_stale fails on upstream drift and on an explicitly stale output', () => {
    const drift = evaluateChecklist(
      ['not_stale'],
      context({
        inputRefs: [{ artifactId: ULID_A, version: 1 }],
        latestInputRefs: refs([['requirement_analysis', { artifactId: ULID_A, version: 3 }]]),
      }),
    );
    expect(drift.passed).toBe(false);

    const stale = evaluateChecklist(['not_stale'], context({ outputStale: true }));
    expect(stale.passed).toBe(false);
    expect(stale.failures.join(' ')).toContain('stale');
  });

  it('acceptance_covered maps every demand criterion to a structured output entry', () => {
    const covered = evaluateChecklist(['acceptance_covered'], context());
    expect(covered.passed).toBe(true);

    const uncovered = evaluateChecklist(
      ['acceptance_covered'],
      context({ demand: { acceptanceCriteria: ['金额与 MARA 一致', '必须支持多币种'] } }),
    );
    expect(uncovered.passed).toBe(false);
    expect(uncovered.failures.join(' ')).toContain('多币种');

    const noCriteria = evaluateChecklist(
      ['acceptance_covered'],
      context({ demand: { acceptanceCriteria: [] } }),
    );
    expect(noCriteria.passed).toBe(true);
  });

  it('normalizes free-text criteria for matching', () => {
    expect(normalizeCriterionText('  金额与 MARA   一致 ')).toBe('金额与 mara 一致');
    expect(parseStructuredOutput('{"a":1}')).toEqual({ a: 1 });
    expect(parseStructuredOutput('plain text')).toBeNull();
  });

  it('evaluateStageCompletion requires schema and checklist together', () => {
    const schemaFailed = evaluateStageCompletion({
      ...context(),
      schemaOk: false,
      schemaIssues: ['summary: Required'],
    });
    expect(schemaFailed.ok).toBe(false);
    expect(schemaFailed.failures.join(' ')).toContain('schema');

    const checklistFailed = evaluateStageCompletion({
      ...context(),
      schemaOk: true,
      stage: stage({ checklist: ['not_stale'] }),
      outputStale: true,
    });
    expect(checklistFailed.ok).toBe(false);

    const ok = evaluateStageCompletion({
      ...context(),
      schemaOk: true,
      stage: stage({ checklist: ['sections_present', 'acceptance_covered'] }),
    });
    expect(ok.ok).toBe(true);
    expect(ok.failures).toEqual([]);
  });

  it('reports mixed input refs without throwing on duplicate kinds', () => {
    // Same artifact id for two kinds is nonsensical but must not crash the check.
    const result = evaluateChecklist(
      ['inputs_referenced'],
      context({
        inputRefs: [{ artifactId: ULID_B, version: 1 }],
        latestInputRefs: refs([['requirement_analysis', { artifactId: ULID_A, version: 1 }]]),
      }),
    );
    expect(result.passed).toBe(false);
  });
});
