import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared JSON-output handling for server-AI stages (docs/003 §2.2, §5.1):
// models must return a single JSON object; anything else is a retryable stage
// failure and must never be persisted as a half-baked artifact.
// ---------------------------------------------------------------------------

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;

export class StageOutputError extends Error {
  readonly rawText: string;
  /** Model that produced the invalid output (filled in by the stage runner). */
  model: string | undefined;
  /** Usage/cost of the failed call, so the run ledger can still account for it. */
  tokens: number | undefined;
  costUsd: number | undefined;
  promptVersion: string | undefined;

  constructor(message: string, rawText: string) {
    super(message);
    this.name = 'StageOutputError';
    this.rawText = rawText;
  }
}

export function extractJsonText(rawText: string): string {
  const fenced = FENCED_JSON.exec(rawText);
  const candidate = (fenced?.[1] ?? rawText).trim();
  if (candidate.length === 0) {
    throw new StageOutputError('stage output is empty', rawText);
  }
  return candidate;
}

export function formatIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Parse + validate a stage's JSON output against its response schema. */
export function parseStageOutput<T>(schema: z.ZodType<T>, rawText: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch (error) {
    if (error instanceof StageOutputError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new StageOutputError(`${label} output is not valid JSON: ${detail}`, rawText);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new StageOutputError(
      `${label} output does not match schema: ${formatIssues(validated.error.issues)}`,
      rawText,
    );
  }
  return validated.data;
}
