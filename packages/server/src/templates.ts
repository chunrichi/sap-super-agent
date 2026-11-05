import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTemplate, templateVersionKey } from '@sap-superagent/core';
import {
  DEFAULT_TEMPLATE_ID,
  type StageTemplateFile,
  type TemplateRef,
} from '@sap-superagent/protocol';

// ---------------------------------------------------------------------------
// Template registry (docs/003 §2.7). File IO lives here; parsing/validation is
// pure core logic. Every `<templateId>.yaml` in the templates directory is
// validated at startup; multiple files may provide different versions of the
// same template id (a Demand pins `templateId + version` at creation time and
// keeps using that version while the file is still on disk).
// ---------------------------------------------------------------------------

export interface TemplateRegistry {
  readonly defaultTemplateId: string;
  readonly templatesDir: string;
  /** Highest loaded version for a template ID, or undefined when unknown. */
  get(templateId: string): StageTemplateFile | undefined;
  /** Exact pinned version, or undefined when that version file is absent. */
  getVersion(templateId: string, version: number): StageTemplateFile | undefined;
  /**
   * Template a demand is pinned to: exact version when present, otherwise the
   * highest loaded version (documented fallback so a restart cannot wedge an
   * in-flight demand; the caller may surface a warning event).
   */
  getForDemand(demand: { templateId: string; templateVersion: number }): StageTemplateFile | undefined;
  require(templateId: string): StageTemplateFile;
  /** Every loaded template version, sorted by template id then version. */
  list(): StageTemplateFile[];
  ref(template: StageTemplateFile): TemplateRef;
}

function readTemplateFiles(templatesDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(templatesDir)
      .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
      .sort();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot read templates directory "${templatesDir}" (${detail}). ` +
        'Pass startServer({ templatesDir }) or set SA_TEMPLATES_DIR.',
    );
  }
  if (entries.length === 0) {
    throw new Error(`no stage templates found in "${templatesDir}" (expected <templateId>.yaml).`);
  }
  return entries;
}

export function loadTemplates(templatesDir: string): TemplateRegistry {
  const entries = readTemplateFiles(templatesDir);
  const byVersion = new Map<string, StageTemplateFile>();
  const highestByTemplate = new Map<string, StageTemplateFile>();
  const all: StageTemplateFile[] = [];

  for (const entry of entries) {
    const template = parseTemplate(readFileSync(join(templatesDir, entry), 'utf8'));
    const key = templateVersionKey(template.templateId, template.version);
    if (byVersion.has(key)) {
      throw new Error(
        `duplicate template version ${key} in "${templatesDir}" (${entry}); ` +
          'each templateId@version may only be declared once.',
      );
    }
    byVersion.set(key, template);
    all.push(template);
    const previous = highestByTemplate.get(template.templateId);
    if (previous === undefined || previous.version < template.version) {
      highestByTemplate.set(template.templateId, template);
    }
  }

  const defaultTemplate = highestByTemplate.get(DEFAULT_TEMPLATE_ID);
  if (defaultTemplate === undefined) {
    throw new Error(
      `templates/${DEFAULT_TEMPLATE_ID}.yaml is missing under "${templatesDir}". ` +
        'Pass startServer({ templatesDir }) pointing at the repository templates directory.',
    );
  }

  all.sort((left, right) =>
    left.templateId === right.templateId
      ? left.version - right.version
      : left.templateId.localeCompare(right.templateId),
  );

  const get = (templateId: string): StageTemplateFile | undefined =>
    highestByTemplate.get(templateId);

  return {
    templatesDir,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    get,
    getVersion: (templateId, version) => byVersion.get(templateVersionKey(templateId, version)),
    getForDemand: (demand) =>
      byVersion.get(templateVersionKey(demand.templateId, demand.templateVersion)) ??
      get(demand.templateId),
    require: (templateId) => {
      const template = get(templateId);
      if (template === undefined) {
        throw new Error(`unknown template "${templateId}" (loaded: ${[...highestByTemplate.keys()].join(', ')})`);
      }
      return template;
    },
    list: () => [...all],
    ref: (template) => ({ templateId: template.templateId, version: template.version }),
  };
}
