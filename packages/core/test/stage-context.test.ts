import { describe, expect, it } from 'vitest';
import type { ArtifactKind, ArtifactRef } from '@sap-superagent/protocol';
import {
  StageInvariantError,
  assertOneStageRunPerStage,
  buildTaskContextMarkdown,
  collectInputRefs,
  missingInputArtifactKinds,
  stageRunKey,
} from '../src/index.js';
import {
  DEMAND_ID,
  ULID_A,
  ULID_B,
  boundTask,
  sampleContext,
  unboundTask,
} from './fixtures.js';

describe('stage invariants', () => {
  it('builds a stable stage run key', () => {
    expect(stageRunKey(DEMAND_ID, 'requirement_analysis')).toBe(
      `${DEMAND_ID}:requirement_analysis`,
    );
  });

  it('rejects two StageRuns for the same stage', () => {
    const run = { demandId: DEMAND_ID, stageKey: 'requirement_analysis' };
    expect(() => assertOneStageRunPerStage([run])).not.toThrow();
    expect(() => assertOneStageRunPerStage([run, run])).toThrow(StageInvariantError);
  });

  it('computes missing input artifact kinds', () => {
    const stage = {
      key: 'dev_implementation',
      name: '开发实现',
      executorKind: 'vscode' as const,
      inputArtifactKinds: ['requirement_analysis' as const],
      outputArtifactKind: 'code_change' as const,
      gate: 'none' as const,
      maxAttempts: 2,
      checklist: [],
    };
    const empty = { byKind: new Map<ArtifactKind, ArtifactRef>() };
    expect(missingInputArtifactKinds(stage, empty)).toEqual(['requirement_analysis']);
    const available = {
      byKind: new Map<ArtifactKind, ArtifactRef>([
        ['requirement_analysis', { artifactId: ULID_A, version: 1 }],
      ]),
    };
    expect(missingInputArtifactKinds(stage, available)).toEqual([]);
    expect(collectInputRefs(stage, available)).toEqual([{ artifactId: ULID_A, version: 1 }]);
  });
});

describe('task context markdown (docs/003 §5)', () => {
  it('renders demand, acceptance criteria, upstream artifacts and bounds', () => {
    const markdown = buildTaskContextMarkdown(sampleContext);
    expect(markdown).toContain(boundTask.title);
    expect(markdown).toContain(DEMAND_ID);
    expect(markdown).toContain('- [ ] 金额与 MARA 一致');
    expect(markdown).toContain(`\`${ULID_B}\` v1 (requirement_analysis)`);
    expect(markdown).toContain('repo: `z-sales`');
    expect(markdown).toContain('write_production_sap');
    expect(markdown).toContain('生成时间');
  });

  it('marks unbound tasks and empty lists explicitly', () => {
    const markdown = buildTaskContextMarkdown({
      ...sampleContext,
      task: unboundTask,
      workspaceBinding: null,
      inputArtifacts: [],
      demand: { ...sampleContext.demand, acceptanceCriteria: [] },
    });
    expect(markdown).toContain('未绑定仓库（通用任务箱）');
    expect(markdown).toContain('_无_');
  });
});
