import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/index.js';
import { api, startTestServer, TEMPLATES_DIR, type TestServer } from './helpers.js';

// ---------------------------------------------------------------------------
// Template system (H1 §1.1, docs/003 §2.7): startup validation, version pinning
// and the read-only GET /templates surface.
// ---------------------------------------------------------------------------

describe('stage template registry', () => {
  it('loads the committed default (3 stages) and pdo (6 stages) presets', () => {
    const registry = loadTemplates(TEMPLATES_DIR);
    expect(registry.defaultTemplateId).toBe('default');
    expect(registry.list().map((template) => `${template.templateId}@${template.version}`)).toEqual([
      'default@1',
      'pdo@1',
    ]);
    expect(registry.require('default').stages).toHaveLength(3);
    expect(registry.require('pdo').stages).toHaveLength(6);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('pins a demand to its exact template version and falls back when it is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-templates-'));
    try {
      const defaultYaml = readFileSync(join(TEMPLATES_DIR, 'default.yaml'), 'utf8');
      writeFileSync(join(dir, 'default.yaml'), defaultYaml);
      // A second file provides a newer version of the same template id.
      writeFileSync(join(dir, 'default-v2.yaml'), defaultYaml.replace('version: 1', 'version: 2'));
      writeFileSync(
        join(dir, 'pdo.yaml'),
        readFileSync(join(TEMPLATES_DIR, 'pdo.yaml'), 'utf8'),
      );
      const registry = loadTemplates(dir);
      expect(registry.get('default')?.version).toBe(2);
      expect(registry.getVersion('default', 1)?.version).toBe(1);
      expect(registry.getForDemand({ templateId: 'default', templateVersion: 1 })?.version).toBe(1);
      expect(registry.getForDemand({ templateId: 'default', templateVersion: 2 })?.version).toBe(2);
      // Missing pinned version -> highest loaded version (documented fallback).
      expect(registry.getForDemand({ templateId: 'default', templateVersion: 99 })?.version).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate template versions and a directory without a default template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-templates-'));
    try {
      const defaultYaml = readFileSync(join(TEMPLATES_DIR, 'default.yaml'), 'utf8');
      writeFileSync(join(dir, 'a.yaml'), defaultYaml);
      writeFileSync(join(dir, 'b.yaml'), defaultYaml);
      expect(() => loadTemplates(dir)).toThrow(/duplicate template version default@1/);

      rmSync(join(dir, 'b.yaml'));
      writeFileSync(join(dir, 'a.yaml'), defaultYaml.replace('templateId: default', 'templateId: other'));
      expect(() => loadTemplates(dir)).toThrow(/templates\/default\.yaml is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates every template file at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-templates-'));
    try {
      copyFileSync(join(TEMPLATES_DIR, 'default.yaml'), join(dir, 'default.yaml'));
      writeFileSync(join(dir, 'broken.yaml'), 'templateId: broken\nversion: 1\nstages: []\n');
      expect(() => loadTemplates(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('template API (docs/003 §2.7)', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.dispose();
  });

  it('serves GET /templates to user and admin tokens only', async () => {
    const response = await api<{
      templates: Array<{ templateId: string; version: number; stages: unknown[] }>;
      defaultTemplateId: string;
      serverTime: string;
    }>(server, '/api/v1/templates', { token: server.userToken });
    expect(response.status).toBe(200);
    expect(response.body.defaultTemplateId).toBe('default');
    expect(response.body.templates.map((template) => template.templateId)).toEqual([
      'default',
      'pdo',
    ]);
    expect(response.body.templates.map((template) => template.stages.length)).toEqual([3, 6]);

    const anonymous = await api(server, '/api/v1/templates');
    expect(anonymous.status).toBe(401);
  });

  it('pins templateId + version at demand creation; switching templates leaves in-flight demands alone', async () => {
    const first = await api<{
      demand: { id: string; templateId: string; templateVersion: number };
      stages: Array<{ stageKey: string }>;
    }>(server, '/api/v1/demands', {
      method: 'POST',
      token: server.userToken,
      body: {
        title: 'R-9101 default 需求',
        description: '默认三阶段模板',
        acceptanceCriteria: ['金额与 MARA 一致'],
        requester: { userId: 'REQ001' },
      },
    });
    expect(first.status).toBe(200);
    expect(first.body.demand.templateId).toBe('default');
    expect(first.body.demand.templateVersion).toBe(1);
    expect(first.body.stages).toHaveLength(3);

    const second = await api<{
      demand: { id: string; templateId: string };
      stages: Array<{ stageKey: string }>;
    }>(server, '/api/v1/demands', {
      method: 'POST',
      token: server.userToken,
      body: {
        title: 'R-9102 pdo 需求',
        description: '六阶段 PDO 预设',
        acceptanceCriteria: ['金额与 MARA 一致'],
        requester: { userId: 'REQ001' },
        templateId: 'pdo',
      },
    });
    expect(second.status).toBe(200);
    expect(second.body.demand.templateId).toBe('pdo');
    expect(second.body.stages).toHaveLength(6);
    expect(second.body.stages.map((stage) => stage.stageKey)).toEqual([
      'intake',
      'requirement_analysis',
      'dev_spec',
      'dev_implementation',
      'test_acceptance',
      'knowledge_archive',
    ]);

    const inFlight = await api<{
      demand: { templateId: string; templateVersion: number };
      stages: Array<{ stageKey: string }>;
    }>(server, `/api/v1/demands/${first.body.demand.id}`, { token: server.userToken });
    expect(inFlight.body.demand.templateId).toBe('default');
    expect(inFlight.body.demand.templateVersion).toBe(1);
    expect(inFlight.body.stages.map((stage) => stage.stageKey)).toEqual([
      'requirement_analysis',
      'dev_implementation',
      'acceptance_archive',
    ]);
  });

  it('rejects an unknown template with 400', async () => {
    const response = await api<{ error: { code: string } }>(server, '/api/v1/demands', {
      method: 'POST',
      token: server.userToken,
      body: {
        title: 'R-9103 未知模板',
        description: 'x',
        requester: { userId: 'REQ001' },
        templateId: 'nope',
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('bad_request');
  });
});
