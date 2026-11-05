import type {
  ArtifactKind,
  ArtifactRef,
  ChecklistAssertion,
  StageTemplate,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// Decidable stage-completion assertions (docs/003 §2.2 / §2.7).
//
// A stage is only done when its output artifact passes the response schema AND
// every checklist assertion declared by the template. Assertions are pure: the
// caller supplies the output bytes/JSON, the input refs recorded when the stage
// became ready and the latest refs per kind. No IO, deterministic.
// ---------------------------------------------------------------------------

/** Required top-level sections per artifact kind (`sections_present`). */
export const ARTIFACT_REQUIRED_SECTIONS: Readonly<Record<ArtifactKind, readonly string[]>> = {
  requirement_analysis: [
    'summary',
    'goals',
    'scope',
    'assumptions',
    'openQuestions',
    'acceptanceCriteria',
    'risks',
  ],
  dev_spec: ['summary', 'changes', 'testPlan', 'risks'],
  test_doc: ['summary', 'cases', 'environment'],
  knowledge_entry: ['summary', 'tags', 'decisions'],
  free_note: ['summary'],
  // Code changes are diffs/patches, not structured JSON: nothing to assert here.
  code_change: [],
};

export interface ChecklistContext {
  stage: StageTemplate;
  demand: { acceptanceCriteria: readonly string[] };
  /** Raw artifact content as UTF-8 text. */
  outputText: string;
  /** Parsed output when it is a JSON object, otherwise `null`. */
  outputJson: unknown;
  /** Input refs recorded on the StageRun when it became ready. */
  inputRefs: readonly ArtifactRef[];
  /** Latest version currently available per artifact kind for the demand. */
  latestInputRefs: ReadonlyMap<ArtifactKind, ArtifactRef>;
  /** The stage's current output version is flagged stale by upstream updates. */
  outputStale: boolean;
}

export interface ChecklistAssertionResult {
  key: ChecklistAssertion;
  passed: boolean;
  detail: string;
}

export interface ChecklistResult {
  passed: boolean;
  results: ChecklistAssertionResult[];
  /** Human-readable failure lines (empty when everything passed). */
  failures: string[];
}

export interface StageCompletionInput extends ChecklistContext {
  schemaOk: boolean;
  schemaIssues?: readonly string[];
}

export interface StageCompletionResult {
  ok: boolean;
  checklist: ChecklistResult;
  failures: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Collapse whitespace/case so free-text criteria and anchors compare sanely. */
export function normalizeCriterionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface AcceptanceEntry {
  criterion: string;
  anchor: string | null;
}

function collectAcceptanceEntries(outputJson: unknown): AcceptanceEntry[] {
  const record = asRecord(outputJson);
  if (record === null) return [];
  const raw = record['acceptanceCriteria'];
  if (!Array.isArray(raw)) return [];
  const entries: AcceptanceEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      entries.push({ criterion: item, anchor: null });
      continue;
    }
    const itemRecord = asRecord(item);
    if (itemRecord === null) continue;
    const criterion = itemRecord['criterion'];
    const anchor = itemRecord['anchor'];
    if (typeof criterion !== 'string') continue;
    entries.push({
      criterion,
      anchor: typeof anchor === 'string' ? anchor : null,
    });
  }
  return entries;
}

function criterionMatches(entry: AcceptanceEntry, criterion: string): boolean {
  const target = normalizeCriterionText(criterion);
  const haystacks = [entry.criterion, ...(entry.anchor === null ? [] : [entry.anchor])];
  for (const haystackRaw of haystacks) {
    const haystack = normalizeCriterionText(haystackRaw);
    if (haystack.length === 0) continue;
    if (haystack.includes(target) || target.includes(haystack)) return true;
  }
  return false;
}

function sectionsPresent(context: ChecklistContext): ChecklistAssertionResult {
  const required = ARTIFACT_REQUIRED_SECTIONS[context.stage.outputArtifactKind];
  if (required.length === 0) {
    return {
      key: 'sections_present',
      passed: context.outputText.trim().length > 0,
      detail:
        context.outputText.trim().length > 0
          ? 'no structured sections required for this artifact kind'
          : 'output artifact content is empty',
    };
  }
  const record = asRecord(context.outputJson);
  if (record === null) {
    return {
      key: 'sections_present',
      passed: false,
      detail: `output is not a JSON object, cannot verify required sections: ${required.join(', ')}`,
    };
  }
  const missing: string[] = [];
  for (const section of required) {
    const value = record[section];
    if (value === undefined || value === null) missing.push(section);
    else if (typeof value === 'string' && value.trim().length === 0) missing.push(section);
  }
  return {
    key: 'sections_present',
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `required sections present: ${required.join(', ')}`
        : `missing required sections: ${missing.join(', ')}`,
  };
}

function inputsReferenced(context: ChecklistContext): ChecklistAssertionResult {
  const problems: string[] = [];
  for (const kind of context.stage.inputArtifactKinds) {
    const latest = context.latestInputRefs.get(kind);
    if (latest === undefined) {
      problems.push(`missing upstream artifact: ${kind}`);
      continue;
    }
    const recorded = context.inputRefs.find((ref) => ref.artifactId === latest.artifactId);
    if (recorded === undefined) {
      problems.push(`stage did not record its upstream ${kind} (${latest.artifactId})`);
      continue;
    }
    if (recorded.version !== latest.version) {
      problems.push(
        `upstream ${kind} has v${latest.version} but the stage was based on v${recorded.version}`,
      );
    }
  }
  return {
    key: 'inputs_referenced',
    passed: problems.length === 0,
    detail: problems.length === 0 ? 'all declared upstream artifacts exist and are current' : problems.join('; '),
  };
}

function notStale(context: ChecklistContext): ChecklistAssertionResult {
  const problems: string[] = [];
  if (context.outputStale) {
    problems.push('output artifact version is stale (an upstream artifact got a newer version)');
  }
  for (const kind of context.stage.inputArtifactKinds) {
    const latest = context.latestInputRefs.get(kind);
    const recorded = context.inputRefs.find(
      (ref) => latest !== undefined && ref.artifactId === latest.artifactId,
    );
    if (latest !== undefined && recorded !== undefined && recorded.version !== latest.version) {
      problems.push(`upstream ${kind} moved from v${recorded.version} to v${latest.version}`);
    }
  }
  return {
    key: 'not_stale',
    passed: problems.length === 0,
    detail: problems.length === 0 ? 'no upstream version drift' : problems.join('; '),
  };
}

function acceptanceCovered(context: ChecklistContext): ChecklistAssertionResult {
  const criteria = context.demand.acceptanceCriteria;
  if (criteria.length === 0) {
    return {
      key: 'acceptance_covered',
      passed: true,
      detail: 'demand declares no acceptance criteria',
    };
  }
  const entries = collectAcceptanceEntries(context.outputJson);
  if (entries.length === 0) {
    return {
      key: 'acceptance_covered',
      passed: false,
      detail: 'output is not structured or has no acceptanceCriteria entries to cover the demand',
    };
  }
  const missing = criteria.filter(
    (criterion) => !entries.some((entry) => criterionMatches(entry, criterion)),
  );
  return {
    key: 'acceptance_covered',
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${criteria.length} acceptance criteria are covered`
        : `uncovered acceptance criteria: ${missing.join(' | ')}`,
  };
}

const ASSERTIONS: Readonly<
  Record<ChecklistAssertion, (context: ChecklistContext) => ChecklistAssertionResult>
> = {
  sections_present: sectionsPresent,
  inputs_referenced: inputsReferenced,
  not_stale: notStale,
  acceptance_covered: acceptanceCovered,
};

export const CHECKLIST_ASSERTION_REGISTRY: Readonly<
  Record<ChecklistAssertion, (context: ChecklistContext) => ChecklistAssertionResult>
> = ASSERTIONS;

/** Evaluate the template's decidable assertions (docs/003 §2.2). */
export function evaluateChecklist(
  keys: readonly ChecklistAssertion[],
  context: ChecklistContext,
): ChecklistResult {
  const results: ChecklistAssertionResult[] = [];
  for (const key of keys) {
    const assertion = ASSERTIONS[key];
    results.push(assertion(context));
  }
  const failures = results
    .filter((result) => !result.passed)
    .map((result) => `${result.key}: ${result.detail}`);
  return { passed: failures.length === 0, results, failures };
}

/**
 * Full stage completion gate: response schema **and** checklist. Used for both
 * server-AI stages (schema validated before persisting) and vscode stages
 * (artifact submitted by the executor).
 */
export function evaluateStageCompletion(input: StageCompletionInput): StageCompletionResult {
  const checklist = evaluateChecklist(input.stage.checklist, input);
  const failures: string[] = [];
  if (!input.schemaOk) {
    const issues = (input.schemaIssues ?? []).filter((issue) => issue.trim().length > 0);
    failures.push(`schema: ${issues.length === 0 ? 'output does not match the declared schema' : issues.join('; ')}`);
  }
  failures.push(...checklist.failures);
  return { ok: failures.length === 0, checklist, failures };
}

/** `true` when the artifact content parses to a JSON object. */
export function parseStructuredOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

export { isNonEmptyString as checklistNonEmptyString };
