// Client preflight decision tests (docs/005 §2.5, docs/009 #6/#7/#8):
// local precondition failures block the claim and always carry a next action;
// nothing here auto-retries a write.
import { describe, expect, it } from 'vitest';
import {
  MINIMUM_ABAP_VERSION,
  describePreflightFailure,
  evaluatePreflight,
} from '../src/preflight.js';

const OK_INPUT = {
  workspaceTrusted: true,
  hasWorkspaceFolder: true,
} as const;

describe('evaluatePreflight', () => {
  it('passes when no precondition is violated', () => {
    const result = evaluatePreflight({ ...OK_INPUT, repoClean: null, abapAvailable: null });
    expect(result).toEqual({ ok: true, issues: [], blocked: false });
    expect(describePreflightFailure(result)).toBe('');
  });

  it('blocks an untrusted workspace and explains how to fix it', () => {
    const result = evaluatePreflight({ ...OK_INPUT, workspaceTrusted: false });
    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.issues[0]).toMatchObject({ code: 'workspace_untrusted' });
    expect(result.issues[0]?.action).toContain('信任');
    expect(describePreflightFailure(result)).toContain('受限模式');
  });

  it('blocks when no folder is open', () => {
    const result = evaluatePreflight({ ...OK_INPUT, hasWorkspaceFolder: false });
    expect(result.issues.map((issue) => issue.code)).toContain('no_workspace');
    expect(result.issues[0]?.action).toContain('打开');
  });

  it('reports dirty repos, a missing abap-cli and a too-old abap-cli', () => {
    expect(
      evaluatePreflight({ ...OK_INPUT, repoClean: false }).issues.map((issue) => issue.code),
    ).toContain('repo_dirty');

    const missing = evaluatePreflight({ ...OK_INPUT, abapAvailable: false });
    expect(missing.issues.map((issue) => issue.code)).toContain('abap_missing');

    const tooOld = evaluatePreflight({ ...OK_INPUT, abapAvailable: true, abapVersion: '2.1.9' });
    expect(tooOld.issues[0]).toMatchObject({ code: 'abap_version' });
    expect(tooOld.issues[0]?.action).toContain(MINIMUM_ABAP_VERSION);

    // A newer version is fine, including `v` prefixes and pre-release suffixes.
    expect(evaluatePreflight({ ...OK_INPUT, abapVersion: 'v2.2.0' }).ok).toBe(true);
    expect(evaluatePreflight({ ...OK_INPUT, abapVersion: '2.10.1-beta.1' }).ok).toBe(true);
  });

  it('reports SAP session loss and allowed-system mismatches without auto-retry', () => {
    const result = evaluatePreflight({
      ...OK_INPUT,
      sapSessionValid: false,
      allowedSystemMatches: false,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'sap_session_invalid',
      'allowed_system_mismatch',
    ]);
    expect(result.issues[0]?.action).toContain('登录');
    expect(result.issues[1]?.action).toContain('白名单');
  });

  it('collects every violation so the developer fixes them in one pass', () => {
    const result = evaluatePreflight({
      workspaceTrusted: false,
      hasWorkspaceFolder: false,
      repoClean: false,
      abapAvailable: false,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'no_workspace',
      'workspace_untrusted',
      'repo_dirty',
      'abap_missing',
    ]);
    expect(describePreflightFailure(result).split('\n')).toHaveLength(4);
  });
});
