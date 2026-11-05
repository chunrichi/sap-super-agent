import type {
  ArtifactKind,
  ArtifactRef,
  StageRun,
  StageTemplate,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// Stage invariants from docs/003 §2.2: one StageRun per (demand, stage), and a
// stage only becomes ready once all declared input artifacts exist.
// ---------------------------------------------------------------------------

export function stageRunKey(demandId: string, stageKey: string): string {
  return `${demandId}:${stageKey}`;
}

export class StageInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageInvariantError';
  }
}

/** A demand has exactly one StageRun per stage key. */
export function assertOneStageRunPerStage(
  stageRuns: readonly Pick<StageRun, 'demandId' | 'stageKey'>[],
): void {
  const seen = new Set<string>();
  for (const stageRun of stageRuns) {
    const key = stageRunKey(stageRun.demandId, stageRun.stageKey);
    if (seen.has(key)) {
      throw new StageInvariantError(`duplicate StageRun for ${key}`);
    }
    seen.add(key);
  }
}

export function findStageRun(
  stageRuns: readonly StageRun[],
  stageKey: string,
): StageRun | undefined {
  return stageRuns.find((stageRun) => stageRun.stageKey === stageKey);
}

export interface ArtifactAvailability {
  /** Newest available version per artifact kind. */
  byKind: ReadonlyMap<ArtifactKind, ArtifactRef>;
}

/** Returns the missing input artifact kinds; empty = the stage may become ready. */
export function missingInputArtifactKinds(
  stage: StageTemplate,
  availability: ArtifactAvailability,
): ArtifactKind[] {
  return stage.inputArtifactKinds.filter((kind) => !availability.byKind.has(kind));
}

export function inputArtifactsReady(
  stage: StageTemplate,
  availability: ArtifactAvailability,
): boolean {
  return missingInputArtifactKinds(stage, availability).length === 0;
}

export function collectInputRefs(
  stage: StageTemplate,
  availability: ArtifactAvailability,
): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const kind of stage.inputArtifactKinds) {
    const ref = availability.byKind.get(kind);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}
