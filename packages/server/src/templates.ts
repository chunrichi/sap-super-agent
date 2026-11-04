import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTemplate } from '@sap-superagent/core';
import {
  DEFAULT_TEMPLATE_ID,
  type StageTemplateFile,
  type TemplateRef,
} from '@sap-superagent/protocol';

export interface TemplateRegistry {
  readonly defaultTemplateId: string;
  /** Highest loaded version for a template ID, or undefined when unknown. */
  get(templateId: string): StageTemplateFile | undefined;
  require(templateId: string): StageTemplateFile;
  ref(template: StageTemplateFile): TemplateRef;
  readonly templatesDir: string;
}

export function loadTemplates(templatesDir: string): TemplateRegistry {
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

  const loaded = new Map<string, StageTemplateFile>();
  for (const entry of entries) {
    const template = parseTemplate(readFileSync(join(templatesDir, entry), 'utf8'));
    const previous = loaded.get(template.templateId);
    if (previous === undefined || previous.version < template.version) {
      loaded.set(template.templateId, template);
    }
  }

  const defaultTemplate = loaded.get(DEFAULT_TEMPLATE_ID);
  if (defaultTemplate === undefined) {
    throw new Error(
      `templates/${DEFAULT_TEMPLATE_ID}.yaml is missing under "${templatesDir}". ` +
        'Pass startServer({ templatesDir }) pointing at the repository templates directory.',
    );
  }

  return {
    templatesDir,
    defaultTemplateId: DEFAULT_TEMPLATE_ID,
    get: (templateId) => loaded.get(templateId),
    require: (templateId) => {
      const template = loaded.get(templateId);
      if (template === undefined) {
        throw new Error(`unknown template "${templateId}" (loaded: ${[...loaded.keys()].join(', ')})`);
      }
      return template;
    },
    ref: (template) => ({ templateId: template.templateId, version: template.version }),
  };
}
