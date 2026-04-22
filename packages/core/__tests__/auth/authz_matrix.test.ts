/**
 * T1B.4 — Per-service authorization matrix.
 *
 * Category A: fixture-based. Verifies the authorization matrix matches
 * the server's auth middleware exactly.
 *
 * Source: core/test/authz_test.go
 */

import { isAuthorized, getAuthorizationMatrix } from '../../src/auth/authz';
import type { CallerType } from '../../src/auth/authz';
import { hasFixture, loadVectors } from '@dina/test-harness';

describe('Authorization Matrix', () => {
  // Allowed cases from ARCHITECTURE.md Section 18.4
  const allowedCases: Array<{ caller: CallerType; method: string; path: string; label: string }> = [
    { caller: 'brain', method: 'POST', path: '/v1/vault/query', label: 'Brain → vault/query' },
    { caller: 'brain', method: 'POST', path: '/v1/vault/store', label: 'Brain → vault/store' },
    {
      caller: 'brain',
      method: 'POST',
      path: '/v1/staging/ingest',
      label: 'Brain → staging/ingest',
    },
    { caller: 'brain', method: 'POST', path: '/v1/staging/claim', label: 'Brain → staging/claim' },
    {
      caller: 'admin',
      method: 'POST',
      path: '/v1/persona/unlock',
      label: 'Admin → persona/unlock',
    },
    { caller: 'admin', method: 'GET', path: '/v1/devices', label: 'Admin → devices' },
    { caller: 'admin', method: 'POST', path: '/v1/export', label: 'Admin → export' },
    {
      caller: 'connector',
      method: 'POST',
      path: '/v1/staging/ingest',
      label: 'Connector → staging/ingest',
    },
    {
      caller: 'brain',
      method: 'POST',
      path: '/v1/memory/topic/touch',
      label: 'Brain → memory/topic/touch',
    },
    { caller: 'brain', method: 'GET', path: '/v1/memory/toc', label: 'Brain → memory/toc' },
  ];

  for (const { caller, method, path, label } of allowedCases) {
    it(`allows: ${label}`, () => {
      expect(isAuthorized(caller, method, path)).toBe(true);
    });
  }

  // Denied cases
  const deniedCases: Array<{ caller: CallerType; method: string; path: string; label: string }> = [
    { caller: 'admin', method: 'POST', path: '/v1/vault/query', label: 'Admin x vault/query' },
    {
      caller: 'connector',
      method: 'POST',
      path: '/v1/vault/store',
      label: 'Connector x vault/store',
    },
    {
      caller: 'brain',
      method: 'POST',
      path: '/v1/persona/unlock',
      label: 'Brain x persona/unlock',
    },
    { caller: 'brain', method: 'POST', path: '/v1/export', label: 'Brain x export' },
    { caller: 'connector', method: 'GET', path: '/v1/devices', label: 'Connector x devices' },
    { caller: 'device', method: 'GET', path: '/v1/memory/toc', label: 'Device x memory/toc' },
    {
      caller: 'admin',
      method: 'POST',
      path: '/v1/memory/topic/touch',
      label: 'Admin x memory/topic/touch',
    },
    { caller: 'agent', method: 'GET', path: '/v1/memory/toc', label: 'Agent x memory/toc' },
    {
      caller: 'connector',
      method: 'POST',
      path: '/v1/memory/topic/touch',
      label: 'Connector x memory/topic/touch',
    },
  ];

  for (const { caller, method, path, label } of deniedCases) {
    it(`denies: ${label}`, () => {
      expect(isAuthorized(caller, method, path)).toBe(false);
    });
  }

  describe('fail-closed', () => {
    it('unknown path → denied', () => {
      expect(isAuthorized('brain', 'GET', '/v1/unknown/endpoint')).toBe(false);
    });

    it('connector cannot access vault', () => {
      expect(isAuthorized('connector', 'POST', '/v1/vault/query')).toBe(false);
    });

    it('agent cannot access staging/claim', () => {
      expect(isAuthorized('agent', 'POST', '/v1/staging/claim')).toBe(false);
    });
  });

  describe('healthz open to all', () => {
    const allCallers: CallerType[] = ['brain', 'admin', 'connector', 'device', 'agent'];
    for (const caller of allCallers) {
      it(`${caller} → /healthz allowed`, () => {
        expect(isAuthorized(caller, 'GET', '/healthz')).toBe(true);
      });
    }
  });

  describe('getAuthorizationMatrix', () => {
    it('returns non-empty matrix', () => {
      const matrix = getAuthorizationMatrix();
      expect(Object.keys(matrix).length).toBeGreaterThan(10);
    });

    it('vault/query allows brain', () => {
      const matrix = getAuthorizationMatrix();
      expect(matrix['/v1/vault/query']).toContain('brain');
    });

    it('staging/ingest allows connector', () => {
      const matrix = getAuthorizationMatrix();
      expect(matrix['/v1/staging/ingest']).toContain('connector');
    });

    it('memory allows brain only', () => {
      const matrix = getAuthorizationMatrix();
      expect(matrix['/v1/memory/']).toEqual(['brain']);
    });
  });

  // ------------------------------------------------------------------
  // Cross-language verification against Go fixtures
  // ------------------------------------------------------------------

  const fixture = 'auth/authorization_matrix.json';
  const fixtureAvailable = hasFixture(fixture);
  const fixtureSuite = fixtureAvailable ? describe : describe.skip;
  describe('path boundary safety (§A16)', () => {
    it('rejects /v1/vault/storefoo (not a valid sub-path of /v1/vault/store)', () => {
      // Without boundary checking, this would match the /v1/vault/store rule
      expect(isAuthorized('brain', 'POST', '/v1/vault/storefoo')).toBe(false);
    });

    it('accepts /v1/vault/store (exact match)', () => {
      expect(isAuthorized('brain', 'POST', '/v1/vault/store')).toBe(true);
    });

    it('accepts /v1/vault/store/batch (has / boundary)', () => {
      expect(isAuthorized('brain', 'POST', '/v1/vault/store/batch')).toBe(true);
    });

    it('rejects /v1/stagingfoo', () => {
      expect(isAuthorized('brain', 'POST', '/v1/stagingfoo')).toBe(false);
    });

    it('accepts /v1/staging/ingest', () => {
      expect(isAuthorized('brain', 'POST', '/v1/staging/ingest')).toBe(true);
    });

    it('rejects /v1/personasfoo', () => {
      expect(isAuthorized('brain', 'GET', '/v1/personasfoo')).toBe(false);
    });

    it('accepts prefixes that already end with /', () => {
      // /v1/vault/item/ rule ends with / — any continuation is valid
      expect(isAuthorized('brain', 'GET', '/v1/vault/item/abc123')).toBe(true);
    });

    it('rejects unknown paths (fail-closed)', () => {
      expect(isAuthorized('brain', 'POST', '/v1/totally/unknown')).toBe(false);
    });

    it('rejects /v1/memoryfoo (boundary)', () => {
      // Without boundary checking `/v1/memory/` would leak onto
      // sibling prefixes. Guard against that.
      expect(isAuthorized('brain', 'GET', '/v1/memoryfoo')).toBe(false);
    });

    it('accepts /v1/memory/topic/touch via prefix match', () => {
      expect(isAuthorized('brain', 'POST', '/v1/memory/topic/touch')).toBe(true);
    });

    it('accepts /v1/memory/toc via prefix match', () => {
      expect(isAuthorized('brain', 'GET', '/v1/memory/toc')).toBe(true);
    });
  });

  fixtureSuite('cross-language: authorization matrix (Go fixtures)', () => {
    // This fixture has flat vectors: { caller, path, allowed } — not standard inputs/expected
    const data = fixtureAvailable ? require(`../../../fixtures/${fixture}`) : { vectors: [] };

    for (const v of data.vectors as Array<{ caller: string; path: string; allowed: boolean }>) {
      const label = `${v.caller} → ${v.path} = ${v.allowed ? 'allowed' : 'denied'}`;
      it(label, () => {
        expect(isAuthorized(v.caller as CallerType, 'POST', v.path)).toBe(v.allowed);
      });
    }
  });
});
