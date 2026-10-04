/**
 * Inbound skill resolution, access mode and executor selection (design
 * §7.1, §7.2 step 7, §7.2a, §7.3).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { a2aPrincipal } from '../../src/a2a/clients';
import { resolveInboundSkill, selectA2AExecutor } from '../../src/a2a/inbound_resolve';
import { bindRunner } from '../../src/a2a/runner_bindings';
import { A2AStore } from '../../src/a2a/store';
import { registerDevice, resetDeviceRegistry } from '../../src/devices/registry';
import { resetServiceConfigState, setServiceConfig } from '../../src/service/service_config';
import { SQLiteServiceGrantRepository } from '../../src/service/service_grant_repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import type { InvocationEnvelope } from '@dina/a2a';
import type { ServiceConfig } from '@dina/protocol';

const NOW = 1_800_000_000_000;
const ME = a2aPrincipal(`ac_${'1'.repeat(32)}`);
const OTHER = a2aPrincipal(`ac_${'2'.repeat(32)}`);
const SCHEMAS = { eta_query: { params: { type: 'object', properties: { route_id: { type: 'string' } } }, result: { type: 'object' }, schemaHash: 'h' } };

let dir: string;
let db: NodeSQLiteAdapter;
let store: A2AStore;
let grants: SQLiteServiceGrantRepository;
let runnerDid: string;

beforeEach(() => {
  resetDeviceRegistry();
  resetServiceConfigState();
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-resolve-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: 'cc'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  store = new A2AStore(db);
  grants = new SQLiteServiceGrantRepository(db);
  runnerDid = registerDevice('Transit runner', 'z6MkTransitRunnerX', 'agent', 'runner').did;
  bindRunner(store, { lane: 'transit', device_did: runnerDid }, NOW);
});

afterEach(() => {
  resetDeviceRegistry();
  resetServiceConfigState();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function listing(discoverability: 'public' | 'unlisted' | 'known_only', over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    isDiscoverable: discoverability === 'public',
    discoverability,
    status: 'active',
    name: `Listing ${discoverability}`,
    capabilities: { eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' } },
    capabilitySchemas: SCHEMAS,
    ...over,
  };
}

function env(skill: string, over: Partial<InvocationEnvelope> = {}): InvocationEnvelope {
  const at = skill.indexOf('@');
  return {
    skill: at === -1 ? { capability: skill } : { capability: skill.slice(0, at), rkey: skill.slice(at + 1) },
    skillText: skill,
    params: { route_id: '42' },
    ...over,
  };
}

const resolve = (envelope: InvocationEnvelope, scope: string[] = [], principal = ME) =>
  resolveInboundSkill({ store, grants, principal, scope, envelope, nowMs: NOW });

describe('the action registry decides first', () => {
  it.each([
    ['com.acme.thing', 'custom_capability'],
    ['com.dinakernel.commerce.order_status', 'commerce_capability'],
    ['not_a_capability', 'unknown_capability'],
  ])('%s → %s', (capability, reason) => {
    expect(resolve(env(capability))).toEqual({ ok: false, reason });
  });
});

describe('listing resolution', () => {
  it('a bare capability resolves to the one public listing, alias-aware', () => {
    setServiceConfig(listing('public'), 'bus');
    setServiceConfig(listing('unlisted'), 'hidden');
    const out = resolve(env('bus_eta'));
    expect(out.ok && [out.resolved.rkey, out.resolved.mode, out.resolved.canonical, out.resolved.configuredKey]).toEqual([
      'bus',
      'public',
      'eta_query',
      'eta_query',
    ]);
  });

  it('two public listings make a bare capability ambiguous; none makes it unknown', () => {
    setServiceConfig(listing('public'), 'a');
    setServiceConfig(listing('public'), 'b');
    expect(resolve(env('eta_query'))).toEqual({ ok: false, reason: 'skill_ambiguous' });
    resetServiceConfigState();
    setServiceConfig(listing('unlisted'), 'hidden');
    expect(resolve(env('eta_query'))).toEqual({ ok: false, reason: 'skill_unknown' });
  });

  // Cold audit C3-3: one rule with the card, which leaves such a skill off (`ambiguous_skill`)
  describe('a capability one listing configures under two names is ambiguous for every call, by any name', () => {
    const both = (discoverability: 'public' | 'known_only' = 'public') =>
      listing(discoverability, {
        capabilities: {
          eta_query: { mcpServer: 'transit', mcpTool: 'get_eta', responsePolicy: 'auto', category: 'transit' },
          bus_eta: { mcpServer: 'transit', mcpTool: 'get_bus_eta', responsePolicy: 'auto', category: 'transit' },
        },
        capabilitySchemas: { ...SCHEMAS, bus_eta: { ...SCHEMAS.eta_query, schemaHash: 'h-bus' } },
      });

    it.each([
      ['the canonical name, qualified', 'eta_query@bus'],
      ['the configured alias, qualified', 'bus_eta@bus'],
      ['an alias the listing never configured, qualified', 'transit_eta@bus'],
      ['the canonical name, bare', 'eta_query'],
      ['an unconfigured alias, bare', 'transit_eta'],
    ])('%s', (_name, skill) => {
      setServiceConfig(both(), 'bus');
      expect(resolve(env(skill))).toEqual({ ok: false, reason: 'skill_ambiguous' });
    });

    it('through a grant on a known_only listing too', () => {
      setServiceConfig(both('known_only'), 'private');
      grants.create({ grantId: 'g-both', granteeDid: ME, serviceRkey: 'private', capability: 'eta_query', grantType: 'standing', createdAt: 1 });
      expect(resolve(env('eta_query', { grantId: 'g-both' }))).toEqual({ ok: false, reason: 'skill_ambiguous' });
      expect(resolve(env('bus_eta@private', { grantId: 'g-both' }))).toEqual({ ok: false, reason: 'skill_ambiguous' });
    });

    it('control: the same listing with one name for it resolves every name to that entry', () => {
      setServiceConfig(listing('public'), 'bus');
      for (const skill of ['eta_query@bus', 'bus_eta@bus', 'transit_eta@bus', 'eta_query']) {
        const out = resolve(env(skill));
        expect(out.ok && [out.resolved.rkey, out.resolved.configuredKey]).toEqual(['bus', 'eta_query']);
      }
    });
  });

  it('never resolves a Talk, paused or draft listing', () => {
    setServiceConfig(listing('public', { surface: 'talk' }), 'talk');
    setServiceConfig(listing('public', { status: 'paused' }), 'paused');
    setServiceConfig(listing('public', { status: 'draft' }), 'draft');
    for (const skill of ['eta_query', 'eta_query@talk', 'eta_query@paused', 'eta_query@draft']) {
      expect(resolve(env(skill))).toEqual({ ok: false, reason: 'skill_unknown' });
    }
  });
});

describe('access mode (total)', () => {
  it('public: the client’s scope decides; empty scope is every public skill', () => {
    setServiceConfig(listing('public'), 'bus');
    expect(resolve(env('eta_query'), []).ok).toBe(true);
    expect(resolve(env('eta_query'), ['eta_query@bus']).ok).toBe(true);
    expect(resolve(env('eta_query'), ['eta_query']).ok).toBe(true);
    expect(resolve(env('eta_query'), ['appointment_book'])).toEqual({ ok: false, reason: 'not_in_scope' });
  });

  it('unlisted by exact reference passes whatever the scope', () => {
    setServiceConfig(listing('unlisted'), 'hidden');
    const out = resolve(env('eta_query@hidden'), ['appointment_book']);
    expect(out.ok && out.resolved.mode).toBe('unlisted');
  });

  it('known_only only through this client’s live grant', () => {
    setServiceConfig(listing('known_only'), 'private');
    expect(resolve(env('eta_query@private'))).toEqual({ ok: false, reason: 'grant_not_authorized' });
    grants.create({ grantId: 'g-mine', granteeDid: ME, serviceRkey: 'private', capability: 'eta_query', grantType: 'standing', createdAt: 1 });
    grants.create({ grantId: 'g-theirs', granteeDid: OTHER, serviceRkey: 'private', capability: 'eta_query', grantType: 'standing', createdAt: 1 });
    const byRef = resolve(env('eta_query@private', { grantId: 'g-mine' }));
    expect(byRef.ok && [byRef.resolved.mode, byRef.resolved.grantId]).toEqual(['known_only', 'g-mine']);
    const byGrant = resolve(env('eta_query', { grantId: 'g-mine' }));
    expect(byGrant.ok && byGrant.resolved.rkey).toBe('private');
    expect(resolve(env('eta_query', { grantId: 'g-theirs' }))).toEqual({ ok: false, reason: 'grant_not_authorized' });
    grants.revoke('g-mine', 2);
    expect(resolve(env('eta_query@private', { grantId: 'g-mine' }))).toEqual({ ok: false, reason: 'grant_not_authorized' });
  });
});

describe('a grant on a public listing adds nothing', () => {
  it('the public rules and the scope decide, named or bare: a client scoped away is refused either way', () => {
    setServiceConfig(listing('public'), 'bus');
    grants.create({ grantId: 'g-pub', granteeDid: ME, serviceRkey: 'bus', capability: 'eta_query', grantType: 'standing', createdAt: 1 });
    const scopedAway = ['price_check'];
    expect(resolve(env('eta_query', { grantId: 'g-pub' }), scopedAway)).toEqual({ ok: false, reason: 'not_in_scope' });
    expect(resolve(env('eta_query@bus', { grantId: 'g-pub' }), scopedAway)).toEqual({ ok: false, reason: 'not_in_scope' });
    // In scope, it resolves as public, the grant unused.
    const inScope = resolve(env('eta_query', { grantId: 'g-pub' }), ['eta_query']);
    expect(inScope.ok && [inScope.resolved.mode, inScope.resolved.grantId]).toEqual(['public', undefined]);
  });
});

describe('executor selection (§7.3)', () => {
  it('an mcpServer lane runs only with a live runner binding, and pins its device as the PEP', () => {
    setServiceConfig(listing('public'), 'bus');
    const out = resolve(env('eta_query'));
    expect(out.ok && out.resolved.executor).toEqual({ kind: 'mcp_server', lane: 'transit', mcpTool: 'get_eta', pepDid: runnerDid });
    setServiceConfig(
      listing('public', { capabilities: { eta_query: { mcpServer: 'unbound', mcpTool: 'x', responsePolicy: 'auto', category: 'transit' } } }),
      'bus',
    );
    expect(resolve(env('eta_query'))).toEqual({ ok: false, reason: 'no_executor' });
  });

  it('an instruction and no mcpServer runs in-process; a reserved lane or an unsound plugin binding runs nowhere', () => {
    expect(selectA2AExecutor(store, { responsePolicy: 'auto', instruction: 'Answer.' }, 'read')).toEqual({ kind: 'tier1' });
    expect(selectA2AExecutor(store, { responsePolicy: 'auto', mcpServer: 'dina.local', mcpTool: 't' }, 'read')).toBeNull();
    expect(selectA2AExecutor(store, { responsePolicy: 'auto', mcpServer: 'a2a:ra-1', mcpTool: 't', instruction: 'x' }, 'read')).toBeNull();
    expect(
      selectA2AExecutor(store, { responsePolicy: 'auto', pluginInstallId: 'inst-1', pluginManifestCid: 'bafy', pluginCapabilityId: 'c' }, 'read'),
    ).toBeNull();
    expect(selectA2AExecutor(store, { responsePolicy: 'auto', pluginInstallId: 'inst-1', instruction: 'x' }, 'read')).toBeNull();
  });

  it('returns the pinned schema pair, or null when the listing publishes none', () => {
    setServiceConfig(listing('public'), 'bus');
    const out = resolve(env('eta_query'));
    expect(out.ok && out.resolved.schemas).toEqual(expect.objectContaining({ storedHash: 'h' }));
    setServiceConfig(listing('public', { capabilitySchemas: {} }), 'bus');
    const bare = resolve(env('eta_query'));
    expect(bare.ok && bare.resolved.schemas).toBeNull();
  });
});
