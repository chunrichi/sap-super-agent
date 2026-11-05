import { describe, expect, it } from 'vitest';
import type { ListHooksResponse } from '@sap-superagent/protocol';
import { api, startTestServer } from './helpers.js';

// ---------------------------------------------------------------------------
// S4 §1.4 management surface on a plain server: no hook config means no hooks,
// and the root hook routes keep the usual token rules instead of breaking the
// H0–S3 surface.
// ---------------------------------------------------------------------------

describe('hook management routes without a hook config', () => {
  it('returns an empty hook list to admins and enforces admin auth', async () => {
    const server = await startTestServer();
    try {
      const anonymous = await api(server, '/hooks');
      expect(anonymous.status).toBe(401);

      const asUser = await api(server, '/hooks', { token: server.userToken });
      expect(asUser.status).toBe(403);

      const asAdmin = await api<ListHooksResponse>(server, '/hooks', { token: server.adminToken });
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.hooks).toEqual([]);
      expect(typeof asAdmin.body.serverTime).toBe('string');
    } finally {
      await server.dispose();
    }
  });

  it('answers replay with actionable 404/400 instead of crashing', async () => {
    const server = await startTestServer();
    try {
      const missingKey = await api(server, '/hooks/not-configured/replay', {
        method: 'POST',
        token: server.adminToken,
        body: { eventId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q' },
      });
      expect(missingKey.status).toBe(400);
      expect(JSON.stringify(missingKey.body)).toContain('Idempotency-Key');

      const notConfigured = await api(server, '/hooks/not-configured/replay', {
        method: 'POST',
        token: server.adminToken,
        headers: { 'idempotency-key': 'replay-key' },
        body: { eventId: '01J8ZQ9W3K5M2V7X4C6B8N0P1Q' },
      });
      expect(notConfigured.status).toBe(404);
      expect(JSON.stringify(notConfigured.body)).toContain('is not configured');
    } finally {
      await server.dispose();
    }
  });
});
