/**
 * Inbound A2A clients (design §5.1, §5.2): registration mints a bearer shown
 * once and stored only as its hash; bearer verification answers every way a
 * token can fail; rotation ends the old token in the same commit; revocation
 * ends the client, its credentials and every grant issued to it; grants are
 * `service_grants` rows for `surface:'services'` listings only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  A2A_BEARER_LIFETIME_MS,
  LAST_USED_RESOLUTION_MS,
  a2aPrincipal,
  authenticateA2ABearer,
  clientIdOfPrincipal,
  createA2AClient,
  getA2AClient,
  issueA2AGrant,
  listA2AClients,
  listA2AGrants,
  revokeA2AClient,
  revokeA2AGrant,
  rotateA2AClientToken,
} from '../../src/a2a/clients';
import { A2AStore } from '../../src/a2a/store';
import { resetServiceConfigState, setServiceConfig } from '../../src/service/service_config';
import { SQLiteServiceGrantRepository } from '../../src/service/service_grant_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { ServiceConfig } from '@dina/protocol';

const NOW = 1_800_000_000_000;

let dir: string;
let db: NodeSQLiteAdapter;
let store: A2AStore;
let grants: SQLiteServiceGrantRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-clients-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'ef'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new A2AStore(db);
  grants = new SQLiteServiceGrantRepository(db);
  resetServiceConfigState();
});

afterEach(() => {
  resetServiceConfigState();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function register(over: Record<string, unknown> = {}) {
  const out = createA2AClient(store, { display_name: 'Acme booking agent', ...over }, NOW);
  if (!out.ok) throw new Error(out.reason);
  return out;
}

describe('registration', () => {
  it('mints a bearer shown once, stores only its hash, and names the principal', () => {
    const { client, token } = register({ scope: ['eta_query', 'appointment_book@salon', 'eta_query'] });
    expect(token).toMatch(/^dina_a2a_[A-Za-z0-9_-]{43}$/);
    expect(client.principal).toBe(`a2a:${client.client_id}`);
    expect(clientIdOfPrincipal(client.principal)).toBe(client.client_id);
    expect(client.scope).toEqual(['appointment_book@salon', 'eta_query']);
    expect(client.token_expires_at).toBe(NOW + A2A_BEARER_LIFETIME_MS);
    // The token is nowhere in the database or in any view.
    const dump = JSON.stringify([db.query('SELECT * FROM a2a_clients'), db.query('SELECT * FROM a2a_credential_bindings'), listA2AClients(store)]);
    expect(dump).not.toContain(token);
    expect(db.query('SELECT binding_type FROM a2a_credential_bindings')).toEqual([{ binding_type: 'bearer' }]);
  });

  it.each([
    [{ display_name: '' }, 'name_required'],
    [{ display_name: 'x'.repeat(65) }, 'name_too_long'],
    [{ scope: 'eta_query' }, 'scope_malformed'],
    [{ scope: ['eta query'] }, 'scope_malformed'],
    [{ scope: Array.from({ length: 65 }, (_, i) => `cap_${i}`) }, 'scope_too_large'],
    [{ expected_did: 'not-a-did' }, 'expected_did_malformed'],
  ])('refuses %j as %s', (over, reason) => {
    expect(createA2AClient(store, { display_name: 'Agent', ...over }, NOW)).toEqual({ ok: false, reason });
  });

  it('cleans the display name of hidden and control characters', () => {
    const { client } = register({ display_name: 'Acme‮ agent\u0007' });
    expect(client.display_name).toBe('Acme agent');
  });
});

describe('bearer verification', () => {
  it('accepts the live token, case-insensitive scheme, and resolves the principal', () => {
    const { client, token } = register();
    const ok = authenticateA2ABearer(store, `bearer ${token}`, NOW + 1);
    expect(ok).toEqual(expect.objectContaining({ ok: true, principal: a2aPrincipal(client.client_id) }));
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['Basic abc', 'malformed'],
    ['Bearer short', 'malformed'],
    [`Bearer dina_a2a_${'A'.repeat(43)}`, 'unknown'],
  ])('refuses %j as %s', (header, reason) => {
    register();
    expect(authenticateA2ABearer(store, header, NOW)).toEqual({ ok: false, reason });
  });

  it('refuses an expired token, and a revoked client’s', () => {
    const a = register();
    expect(authenticateA2ABearer(store, `Bearer ${a.token}`, NOW + A2A_BEARER_LIFETIME_MS)).toEqual({ ok: false, reason: 'expired' });
    const b = register();
    revokeA2AClient(store, grants, b.client.client_id, NOW);
    expect(authenticateA2ABearer(store, `Bearer ${b.token}`, NOW)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('stamps last_used_at at most once a minute', () => {
    const { client, token } = register();
    authenticateA2ABearer(store, `Bearer ${token}`, NOW + 10);
    authenticateA2ABearer(store, `Bearer ${token}`, NOW + 20);
    expect(getA2AClient(store, client.client_id)?.last_used_at).toBe(NOW + 10);
    authenticateA2ABearer(store, `Bearer ${token}`, NOW + 10 + LAST_USED_RESOLUTION_MS);
    expect(getA2AClient(store, client.client_id)?.last_used_at).toBe(NOW + 10 + LAST_USED_RESOLUTION_MS);
  });
});

describe('rotation and revocation', () => {
  it('rotation ends the old token in the same commit and keeps the history', () => {
    const { client, token } = register();
    const rotated = rotateA2AClientToken(store, client.client_id, NOW + 5);
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(authenticateA2ABearer(store, `Bearer ${token}`, NOW + 6)).toEqual({ ok: false, reason: 'unknown' });
    expect(authenticateA2ABearer(store, `Bearer ${rotated.token}`, NOW + 6).ok).toBe(true);
    const history = db.query<{ revoked_at: number | null }>('SELECT revoked_at FROM a2a_credential_bindings ORDER BY id');
    expect(history.map((h) => h.revoked_at)).toEqual([NOW + 5, null]);
  });

  it('revocation ends the client, its credentials and every grant issued to it', () => {
    setServiceConfig(knownOnlyListing(), 'private');
    const { client, token } = register();
    const issued = issueA2AGrant(store, grants, { client_id: client.client_id, service_rkey: 'private', capability: 'eta_query' }, NOW);
    if (!issued.ok) throw new Error(issued.reason);
    const principal = a2aPrincipal(client.client_id);
    const nowSec = Math.floor(NOW / 1000);
    expect(grants.isAuthorized({ granteeDid: principal, serviceRkey: 'private', capability: 'eta_query', nowSec })).toBe(true);
    expect(revokeA2AClient(store, grants, client.client_id, NOW + 1)).toEqual({ ok: true, grants_revoked: 1 });
    expect(grants.isAuthorized({ granteeDid: principal, serviceRkey: 'private', capability: 'eta_query', nowSec })).toBe(false);
    expect(authenticateA2ABearer(store, `Bearer ${token}`, NOW + 2).ok).toBe(false);
    expect(db.query('SELECT 1 FROM a2a_credential_bindings WHERE revoked_at IS NULL')).toHaveLength(0);
    expect(rotateA2AClientToken(store, client.client_id, NOW + 3)).toEqual({ ok: false, reason: 'revoked' });
    expect(revokeA2AClient(store, grants, client.client_id, NOW + 3)).toEqual({ ok: false, reason: 'revoked' });
  });
});

function knownOnlyListing(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    isDiscoverable: false,
    discoverability: 'known_only',
    status: 'active',
    name: 'Private ETA',
    capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
    ...over,
  };
}

describe('grants (§5.2)', () => {
  it('issues a grant for a capability as the listing configured it, and lists it', () => {
    setServiceConfig(knownOnlyListing(), 'private');
    const { client } = register();
    const issued = issueA2AGrant(store, grants, { client_id: client.client_id, service_rkey: 'private', capability: 'bus_eta' }, NOW);
    expect(issued.ok && issued.grant.capability).toBe('eta_query');
    expect(listA2AGrants(grants, client.client_id).map((g) => g.grantId)).toEqual([issued.ok ? issued.grant.grantId : '']);
  });

  it.each([
    ['client_not_found', { client_id: 'ac_' + '0'.repeat(32) }],
    ['listing_not_found', { service_rkey: 'nope' }],
    ['capability_not_configured', { capability: 'appointment_book' }],
    ['expiry_malformed', { expires_at: 5 }],
  ])('refuses %s', (reason, over) => {
    setServiceConfig(knownOnlyListing(), 'private');
    const { client } = register();
    expect(issueA2AGrant(store, grants, { client_id: client.client_id, service_rkey: 'private', capability: 'eta_query', ...over }, NOW)).toEqual({
      ok: false,
      reason,
    });
  });

  it('refuses a Talk listing, and a revoked client', () => {
    setServiceConfig(knownOnlyListing({ surface: 'talk' }), 'talk');
    setServiceConfig(knownOnlyListing(), 'private');
    const { client } = register();
    expect(issueA2AGrant(store, grants, { client_id: client.client_id, service_rkey: 'talk', capability: 'eta_query' }, NOW)).toEqual({
      ok: false,
      reason: 'not_services_surface',
    });
    revokeA2AClient(store, grants, client.client_id, NOW);
    expect(issueA2AGrant(store, grants, { client_id: client.client_id, service_rkey: 'private', capability: 'eta_query' }, NOW)).toEqual({
      ok: false,
      reason: 'client_revoked',
    });
  });

  it('revokes only grants issued to an A2A client', () => {
    setServiceConfig(knownOnlyListing(), 'private');
    const { client } = register();
    const issued = issueA2AGrant(store, grants, { client_id: client.client_id, service_rkey: 'private', capability: 'eta_query' }, NOW);
    grants.create({ grantId: 'd2d-grant', granteeDid: 'did:plc:friend', serviceRkey: 'private', capability: 'eta_query', grantType: 'standing', createdAt: 1 });
    expect(revokeA2AGrant(grants, 'd2d-grant', NOW)).toBe(false);
    expect(revokeA2AGrant(grants, issued.ok ? issued.grant.grantId : '', NOW)).toBe(true);
  });
});
