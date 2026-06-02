/**
 * Provider-side service-grant repository (`service_grants`, v10).
 *
 * The binding tests ARE the security core: `isAuthorized` is true only for the
 * exact grantee DID, exact listing rkey, exact capability, optionally pinned to
 * the grant_id — and only while the grant is active (not expired, not revoked).
 * Run against the real NodeSQLiteAdapter + a close/reopen restart.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { NodeSQLiteAdapter } from '@dina/storage-node';
import {
  SQLiteServiceGrantRepository,
  type ServiceGrant,
} from '../../src/service/service_grant_repository';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-svc-grants-'));
  const dbPath = path.join(dir, 'identity.sqlite');
  const passphraseHex = randomBytes(32).toString('hex');
  const openOne = () => {
    const a = new NodeSQLiteAdapter({
      path: dbPath,
      passphraseHex,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(a, IDENTITY_MIGRATIONS);
    return a;
  };
  let adapter = openOne();
  return {
    repo: () => new SQLiteServiceGrantRepository(adapter),
    reopen: () => {
      adapter.close();
      adapter = openOne();
      return new SQLiteServiceGrantRepository(adapter);
    },
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* idempotent */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function grant(over: Partial<ServiceGrant> = {}): ServiceGrant {
  return {
    grantId: over.grantId ?? `grant-${randomBytes(4).toString('hex')}`,
    granteeDid: over.granteeDid ?? 'did:plc:emma',
    serviceRkey: over.serviceRkey ?? 'private-1',
    capability: over.capability ?? 'eta_query',
    grantType: over.grantType ?? 'standing',
    ...(over.constraints !== undefined ? { constraints: over.constraints } : {}),
    ...(over.expiresAt !== undefined ? { expiresAt: over.expiresAt } : {}),
    ...(over.revokedAt !== undefined ? { revokedAt: over.revokedAt } : {}),
    createdAt: over.createdAt ?? 1_700_000_000,
  };
}

const NOW = 1_700_000_100;

describe('SQLiteServiceGrantRepository', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.cleanup());

  it('authorizes the exact grantee + rkey + capability', () => {
    const r = h.repo();
    r.create(grant({ grantId: 'g1' }));
    expect(
      r.isAuthorized({
        granteeDid: 'did:plc:emma',
        serviceRkey: 'private-1',
        capability: 'eta_query',
        nowSec: NOW,
      }),
    ).toBe(true);
  });

  it('rejects a DIFFERENT grantee (the load-bearing bind)', () => {
    const r = h.repo();
    r.create(grant({ grantId: 'g1', granteeDid: 'did:plc:emma' }));
    expect(
      r.isAuthorized({
        granteeDid: 'did:plc:bob',
        serviceRkey: 'private-1',
        capability: 'eta_query',
        nowSec: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a different rkey or capability', () => {
    const r = h.repo();
    r.create(grant({ grantId: 'g1' }));
    expect(
      r.isAuthorized({ granteeDid: 'did:plc:emma', serviceRkey: 'other', capability: 'eta_query', nowSec: NOW }),
    ).toBe(false);
    expect(
      r.isAuthorized({ granteeDid: 'did:plc:emma', serviceRkey: 'private-1', capability: 'price_check', nowSec: NOW }),
    ).toBe(false);
  });

  it('pins to grant_id when provided', () => {
    const r = h.repo();
    r.create(grant({ grantId: 'g1' }));
    const base = { granteeDid: 'did:plc:emma', serviceRkey: 'private-1', capability: 'eta_query', nowSec: NOW };
    expect(r.isAuthorized({ ...base, grantId: 'g1' })).toBe(true);
    expect(r.isAuthorized({ ...base, grantId: 'nope' })).toBe(false);
  });

  it('rejects an expired grant', () => {
    const r = h.repo();
    r.create(grant({ grantId: 'g1', expiresAt: NOW - 1 }));
    expect(
      r.isAuthorized({ granteeDid: 'did:plc:emma', serviceRkey: 'private-1', capability: 'eta_query', nowSec: NOW }),
    ).toBe(false);
  });

  it('rejects a revoked grant', () => {
    const r = h.repo();
    r.create(grant({ grantId: 'g1' }));
    expect(r.revoke('g1', NOW)).toBe(true);
    expect(
      r.isAuthorized({ granteeDid: 'did:plc:emma', serviceRkey: 'private-1', capability: 'eta_query', nowSec: NOW }),
    ).toBe(false);
    expect(r.revoke('g1', NOW)).toBe(false); // already revoked
  });

  it('survives a restart (durable)', () => {
    h.repo().create(grant({ grantId: 'g1' }));
    const r2 = h.reopen();
    expect(
      r2.isAuthorized({ granteeDid: 'did:plc:emma', serviceRkey: 'private-1', capability: 'eta_query', nowSec: NOW }),
    ).toBe(true);
  });

  it('getById + listByGrantee round-trip', () => {
    const r = h.repo();
    r.create(grant({ grantId: 'g1', capability: 'eta_query' }));
    r.create(grant({ grantId: 'g2', capability: 'price_check' }));
    expect(r.getById('g1')?.capability).toBe('eta_query');
    expect(r.getById('nope')).toBeNull();
    expect(r.listByGrantee('did:plc:emma').map((g) => g.grantId).sort()).toEqual(['g1', 'g2']);
  });
});
