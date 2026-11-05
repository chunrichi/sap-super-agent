import { parse } from 'yaml';
import {
  stageTemplateFileSchema,
  type GateTemplate,
  type StageTemplate,
  type StageTemplateFile,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// Template loader (docs/003 §2.7). Parsing is pure; the server owns file IO.
// ---------------------------------------------------------------------------

export class TemplateValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid stage template: ${issues.join('; ')}`);
    this.name = 'TemplateValidationError';
    this.issues = issues;
  }
}

export function validateTemplate(raw: unknown): StageTemplateFile {
  const parsed = stageTemplateFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TemplateValidationError(
      parsed.error.issues.map((issue) => {
        const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}

export function parseTemplate(yamlText: string): StageTemplateFile {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (error) {
    throw new TemplateValidationError([
      `yaml parse error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return validateTemplate(raw);
}

export function findStage(
  template: StageTemplateFile,
  stageKey: string,
): StageTemplate | undefined {
  return template.stages.find((stage) => stage.key === stageKey);
}

export function requireStage(template: StageTemplateFile, stageKey: string): StageTemplate {
  const stage = findStage(template, stageKey);
  if (stage === undefined) {
    throw new Error(`stage "${stageKey}" is not part of template ${template.templateId}`);
  }
  return stage;
}

export function findGate(
  template: StageTemplateFile,
  gateKey: string,
): GateTemplate | undefined {
  return template.gates.find((gate) => gate.gateKey === gateKey);
}

export function stageKeys(template: StageTemplateFile): string[] {
  return template.stages.map((stage) => stage.key);
}

/** Stable key for a pinned template version (`default@1`). */
export function templateVersionKey(templateId: string, version: number): string {
  return `${templateId}@${version}`;
}

/** 0-based position of a stage inside the template order, `-1` when unknown. */
export function stageIndex(template: StageTemplateFile, stageKey: string): number {
  return template.stages.findIndex((stage) => stage.key === stageKey);
}

/** The stage declared after `stageKey`, or undefined for the last stage. */
export function nextStage(
  template: StageTemplateFile,
  stageKey: string,
): StageTemplate | undefined {
  const index = stageIndex(template, stageKey);
  if (index < 0) return undefined;
  return template.stages[index + 1];
}

/** Gate definition for a stage, `undefined` when the stage has no human gate. */
export function gateForStage(
  template: StageTemplateFile,
  stage: StageTemplate,
): GateTemplate | undefined {
  return stage.gate === 'none' ? undefined : findGate(template, stage.gate.gateKey);
}
