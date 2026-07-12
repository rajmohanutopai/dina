/**
 * PLG-4 — the plugin dynamic registry (PLUGIN_ARCHITECTURE.md §6, §8,
 * §14; migration v18). Runs against the REAL SQLite engine.
 *
 * Covers:
 *   (1) install lifecycle: pending → activate (atomic commit point) →
 *       pause/resume → remove (explicit cascade)
 *   (2) identity is indexed, NOT unique — multi-install is legitimate
 *   (3) update fields: pending update persistable; applyUpdate keeps
 *       install_id anchoring (grants/config/vault never orphaned)
 *   (4) grants: creation guards (§8 — unconstrained HIGH standing
 *       rejected; malformed constraints rejected), atomic
 *       per-execution consumption, idempotent re-authorization,
 *       count/resource/value constraints, fail-closed on unparseable
 *       stored constraints, release, revocation cascade
 *   (5) decisions: owner-private append log
 *   (6) abandoned-pending sweep returns rows for device revocation
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { PLUGIN_NSIDS, type PluginManifest } from '@dina/protocol';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { SQLitePluginInstallRepository } from '../../src/plugins/registry';
import { SQLitePluginGrantRepository, parseConstraints } from '../../src/plugins/grants';
import { SQLitePluginDecisionRepository } from '../../src/plugins/decisions';

const T0 = 1_750_000_000_000;
const T0_SEC = Math.floor(T0 / 1000);

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;
let grants: SQLitePluginGrantRepository;
let decisions: SQLitePluginDecisionRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plg4-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  grants = new SQLitePluginGrantRepository(adapter);
  decisions = new SQLitePluginDecisionRepository(adapter);
});

afterEach(() => {
  try {
    adapter.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const manifest: PluginManifest = {
  $type: PLUGIN_NSIDS.release,
  plugin_id: 'com.acme.flightwatch',
  version: '1.2.0',
  display_name: 'Flight Watch',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.acme.flightwatch.watch',
      display_name: 'Watch a flight',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'unsupported' },
    },
  ],
};

function createPending(
  overrides: Partial<Parameters<typeof installs.createPending>[0]> = {},
): string {
  return installs.createPending({
    publisherDid: 'did:plc:acme',
    pluginId: 'com.acme.flightwatch',
    label: '',
    executionMode: 'runner',
    currentCid: 'bafyreicid1',
    currentVersion: '1.2.0',
    manifest,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { 'com.acme.flightwatch.watch': 'c'.repeat(64) },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' },
    pendingExpiresAtSec: T0_SEC + 900,
    nowMs: T0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// (1) lifecycle
// ---------------------------------------------------------------------------

describe('install lifecycle (§14)', () => {
  it('createPending → getById round-trips the pinned manifest + hashes + anchor', () => {
    const id = createPending();
    const row = installs.getById(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.manifest.plugin_id).toBe('com.acme.flightwatch');
    expect(row?.capabilityHashes['com.acme.flightwatch.watch']).toBe('c'.repeat(64));
    expect(row?.trustAnchor).toEqual({ kind: 'repo_proof' });
    expect(row?.configRevision).toBe(1);
    expect(row?.deviceDid).toBeUndefined();
  });

  it('activate is the single atomic commit point: attaches the device, only from pending', () => {
    const id = createPending();
    expect(installs.activate(id, 'did:key:zinstance', T0 + 1)).toBe(true);
    const row = installs.getById(id);
    expect(row?.status).toBe('active');
    expect(row?.deviceDid).toBe('did:key:zinstance');
    expect(row?.pendingExpiresAt).toBeUndefined();
    // Idempotence guard: a second activate is a no-op.
    expect(installs.activate(id, 'did:key:zother', T0 + 2)).toBe(false);
    expect(installs.getByDeviceDid('did:key:zinstance')?.installId).toBe(id);
  });

  it('pause/resume flip active ↔ paused and nothing else', () => {
    const id = createPending();
    expect(installs.pause(id, T0 + 1)).toBe(false); // pending → no
    installs.activate(id, undefined, T0 + 1);
    expect(installs.pause(id, T0 + 2)).toBe(true);
    expect(installs.getById(id)?.status).toBe('paused');
    expect(installs.resume(id, T0 + 3)).toBe(true);
    expect(installs.getById(id)?.status).toBe('active');
  });

  it('remove deletes install + grants + uses (explicit cascade; decisions survive)', () => {
    const id = createPending();
    installs.activate(id, undefined, T0 + 1);
    const grantId = grants.create(
      {
        installId: id,
        capability: 'com.acme.flightwatch.watch',
        approvedScopeHash: 'c'.repeat(64),
        grantType: 'standing',
      },
      'read',
      T0,
    );
    grants.authorizeAndConsume({
      installId: id,
      capability: 'com.acme.flightwatch.watch',
      approvedScopeHash: 'c'.repeat(64),
      executionId: 'exec-1',
      nowSec: T0_SEC,
    });
    decisions.record({ installId: id, decision: 'consent_granted', nowSec: T0_SEC });

    const removed = installs.remove(id);
    expect(removed?.installId).toBe(id);
    expect(installs.getById(id)).toBeNull();
    expect(grants.getById(grantId)).toBeNull();
    expect(
      adapter.query('SELECT * FROM plugin_grant_uses WHERE grant_id = ?', [grantId]),
    ).toHaveLength(0);
    // Decision log = records of the past, not authority — survives.
    expect(decisions.listByInstall(id, 10)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (2) identity is not unique
// ---------------------------------------------------------------------------

describe('multi-install (§3/§6: identity indexed, NOT unique)', () => {
  it('two installs of the same (publisherDid, plugin_id) coexist', () => {
    const a = createPending({ label: 'Downtown' });
    const b = createPending({ label: 'Home' });
    expect(a).not.toBe(b);
    const both = installs.listByIdentity('did:plc:acme', 'com.acme.flightwatch');
    expect(both).toHaveLength(2);
    expect(both.map((i) => i.label).sort()).toEqual(['Downtown', 'Home']);
  });
});

// ---------------------------------------------------------------------------
// (3) updates
// ---------------------------------------------------------------------------

describe('update fields (§14 dual boundary, persistable)', () => {
  it('setPendingUpdate persists the decision state; applyUpdate swaps version state in place', () => {
    const id = createPending();
    installs.activate(id, undefined, T0 + 1);
    expect(
      installs.setPendingUpdate(
        id,
        { cid: 'bafyreicid2', behaviorHash: 'b2'.repeat(32), decision: 'awaiting_consent' },
        T0 + 2,
      ),
    ).toBe(true);
    let row = installs.getById(id);
    expect(row?.pendingCid).toBe('bafyreicid2');
    expect(row?.pendingDecision).toBe('awaiting_consent');
    expect(row?.currentCid).toBe('bafyreicid1'); // old pin stays live (§14)

    expect(
      installs.applyUpdate(
        id,
        {
          cid: 'bafyreicid2',
          version: '1.3.0',
          manifest,
          installScopeHash: 's2'.repeat(32),
          capabilityHashes: { 'com.acme.flightwatch.watch': 'c2'.repeat(32) },
          behaviorHash: 'b2'.repeat(32),
          presentationHash: 'p2'.repeat(32),
        },
        T0 + 3,
      ),
    ).toBe(true);
    row = installs.getById(id);
    expect(row?.installId).toBe(id); // same anchor — nothing orphaned
    expect(row?.currentCid).toBe('bafyreicid2');
    expect(row?.currentVersion).toBe('1.3.0');
    expect(row?.pendingCid).toBeUndefined();
    expect(row?.pendingDecision).toBeUndefined();
  });

  it('bumpConfigRevision is monotonic (claim check six pins it)', () => {
    const id = createPending();
    expect(installs.bumpConfigRevision(id, T0 + 1)).toBe(2);
    expect(installs.bumpConfigRevision(id, T0 + 2)).toBe(3);
    expect(installs.bumpConfigRevision('nope', T0 + 3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (4) grants
// ---------------------------------------------------------------------------

describe('plugin grants (§8: enforceable or theater)', () => {
  let installId: string;
  beforeEach(() => {
    installId = createPending();
    installs.activate(installId, undefined, T0);
  });

  const KEY = {
    capability: 'com.acme.flightwatch.watch',
    approvedScopeHash: 'c'.repeat(64),
  };

  function authorize(
    executionId: string,
    extra: Partial<{ resource: string; value: number }> = {},
  ) {
    return grants.authorizeAndConsume({
      installId,
      ...KEY,
      executionId,
      nowSec: T0_SEC,
      ...extra,
    });
  }

  it('rejects an unconstrained standing grant for HIGH classes at creation', () => {
    for (const cls of ['booking', 'write', 'agentic']) {
      expect(() => grants.create({ installId, ...KEY, grantType: 'standing' }, cls, T0)).toThrow(
        /must be bounded|never offered/,
      );
    }
    // …but a constrained one is fine.
    expect(
      grants.create(
        {
          installId,
          ...KEY,
          grantType: 'standing',
          constraints: { version: 1, max_count: 5 },
        },
        'booking',
        T0,
      ),
    ).toMatch(/^plg_/);
    // …and read-class standing needs no constraint.
    expect(grants.create({ installId, ...KEY, grantType: 'standing' }, 'read', T0)).toMatch(
      /^plg_/,
    );
  });

  it('AUDIT D8: a window grant must carry an expiry; a HIGH grant must be bounded some way', () => {
    // A window grant with no expiry is a standing grant in disguise.
    expect(() => grants.create({ installId, ...KEY, grantType: 'window' }, 'read', T0)).toThrow(
      /window grant must carry an expiry/,
    );
    // HIGH-class: unbounded 'window' (had it been allowed) / 'once' is fine.
    expect(
      grants.create(
        { installId, ...KEY, grantType: 'window', expiresAt: T0_SEC + 3600 },
        'booking',
        T0,
      ),
    ).toMatch(/^plg_/);
    expect(grants.create({ installId, ...KEY, grantType: 'once' }, 'booking', T0)).toMatch(/^plg_/);
  });

  it('AUDIT D8: a "once" grant authorizes exactly ONE distinct execution (implicit max_count=1)', () => {
    grants.create({ installId, ...KEY, grantType: 'once' }, 'booking', T0);
    expect(
      grants.authorizeAndConsume({ installId, ...KEY, executionId: 'e1', nowSec: T0_SEC }).allowed,
    ).toBe(true);
    // Same execution re-authorizes free (lease recovery).
    expect(
      grants.authorizeAndConsume({ installId, ...KEY, executionId: 'e1', nowSec: T0_SEC }).allowed,
    ).toBe(true);
    // A NEW execution is denied — once means once.
    expect(
      grants.authorizeAndConsume({ installId, ...KEY, executionId: 'e2', nowSec: T0_SEC }),
    ).toEqual({ allowed: false, reason: 'count_exhausted' });
  });

  it('AUDIT D8: max_value has an enforced ceiling (a quintillion cap is not a cap)', () => {
    expect(() =>
      grants.create(
        { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_value: 1e18 } },
        'booking',
        T0,
      ),
    ).toThrow(/malformed|ceilings/);
  });

  it('AUDIT D8: an empty-string constraints_json fails CLOSED (a real grant stores NULL, not "")', () => {
    const g = grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 5 } },
      'booking',
      T0,
    );
    // Corrupt the column to an empty string (anomalous — create never writes '').
    adapter.execute('UPDATE plugin_grants SET constraints_json = ? WHERE grant_id = ?', ['', g]);
    expect(
      grants.authorizeAndConsume({ installId, ...KEY, executionId: 'e1', nowSec: T0_SEC }),
    ).toEqual({ allowed: false, reason: 'constraints_unparseable' });
  });

  it('rejects malformed constraints and ceiling violations at creation', () => {
    const bad: unknown[] = [
      { version: 2, max_count: 3 }, // unknown version
      { version: 1, max_count: 10_000_000 }, // above ceiling — a billion is not a constraint
      { version: 1, teleport: true }, // unknown key — fail closed
      { version: 1, max_count: 0 },
      { version: 1, max_value: -5 },
    ];
    for (const constraints of bad) {
      expect(() =>
        grants.create(
          { installId, ...KEY, grantType: 'standing', constraints: constraints as never },
          'read',
          T0,
        ),
      ).toThrow(/malformed|ceilings/);
    }
  });

  it('consumes once per LOGICAL EXECUTION: same execution_id re-authorizes free', () => {
    grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 2 } },
      'booking',
      T0,
    );
    expect(authorize('exec-1').allowed).toBe(true);
    // Lease-recovery retry: SAME execution — no second consume.
    expect(authorize('exec-1').allowed).toBe(true);
    expect(authorize('exec-2').allowed).toBe(true);
    // Third logical execution exhausts max_count=2.
    const third = authorize('exec-3');
    expect(third).toEqual({ allowed: false, reason: 'count_exhausted' });
  });

  it('releaseUse frees a reservation for a task that provably never executed', () => {
    grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 1 } },
      'booking',
      T0,
    );
    expect(authorize('exec-1').allowed).toBe(true);
    expect(authorize('exec-2').allowed).toBe(false);
    expect(grants.releaseUse('exec-1')).toBe(true);
    expect(authorize('exec-2').allowed).toBe(true);
  });

  it('resource allowlist + value cap constraints', () => {
    grants.create(
      {
        installId,
        ...KEY,
        grantType: 'standing',
        constraints: { version: 1, resources: ['restaurant:luigi'], max_value: 100 },
      },
      'booking',
      T0,
    );
    expect(authorize('e1', { resource: 'restaurant:luigi', value: 50 }).allowed).toBe(true);
    expect(authorize('e2', { resource: 'restaurant:other', value: 50 })).toEqual({
      allowed: false,
      reason: 'resource_not_allowed',
    });
    // Missing resource tag ≠ wildcard — fail toward denial.
    expect(authorize('e3', { value: 50 })).toEqual({
      allowed: false,
      reason: 'resource_not_allowed',
    });
    expect(authorize('e4', { resource: 'restaurant:luigi', value: 500 })).toEqual({
      allowed: false,
      reason: 'value_exceeds_cap',
    });
    // Undeclared value against a value cap — fail toward denial.
    expect(authorize('e5', { resource: 'restaurant:luigi' })).toEqual({
      allowed: false,
      reason: 'value_exceeds_cap',
    });
  });

  it('expired and revoked grants deny; scope-hash mismatch means no grant matches (structural re-consent)', () => {
    const g = grants.create(
      { installId, ...KEY, grantType: 'window', expiresAt: T0_SEC - 10 },
      'read',
      T0,
    );
    expect(authorize('e1')).toEqual({ allowed: false, reason: 'expired' });
    grants.revoke(g, T0_SEC);
    expect(authorize('e2')).toEqual({ allowed: false, reason: 'revoked' });

    const g2 = grants.create({ installId, ...KEY, grantType: 'standing' }, 'read', T0);
    expect(authorize('e3').allowed).toBe(true);
    // Scope growth: new hash → NOTHING matches → re-consent structurally (§8).
    expect(
      grants.authorizeAndConsume({
        installId,
        capability: KEY.capability,
        approvedScopeHash: 'different'.padEnd(64, 'x'),
        executionId: 'e4',
        nowSec: T0_SEC,
      }),
    ).toEqual({ allowed: false, reason: 'no_grant' });
    expect(grants.revoke(g2, T0_SEC)).toBe(true);
  });

  it('fails closed on stored constraints this node cannot parse (§8)', () => {
    const g = grants.create({ installId, ...KEY, grantType: 'standing' }, 'read', T0);
    // Simulate a future-version constraint object landing in the DB
    // (restored archive from a newer node).
    adapter.execute('UPDATE plugin_grants SET constraints_json = ? WHERE grant_id = ?', [
      JSON.stringify({ version: 99, quantum_budget: 3 }),
      g,
    ]);
    expect(authorize('e1')).toEqual({ allowed: false, reason: 'constraints_unparseable' });
  });

  it('revokeAllForInstall cascades (uninstall / device-revoke path)', () => {
    grants.create({ installId, ...KEY, grantType: 'standing' }, 'read', T0);
    grants.create(
      {
        installId,
        capability: 'other.cap',
        approvedScopeHash: 'z'.repeat(64),
        grantType: 'standing',
      },
      'read',
      T0,
    );
    expect(grants.revokeAllForInstall(installId, T0_SEC)).toBe(2);
    expect(authorize('e1')).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('parseConstraints accepts exactly the v1 vocabulary', () => {
    expect(parseConstraints({ version: 1, max_count: 3 })).not.toBeNull();
    expect(parseConstraints({ version: 1 })).not.toBeNull(); // parseable, but not "meaningful"
    expect(parseConstraints('{"version":1,"max_value":20}')).not.toBeNull();
    expect(parseConstraints('not json')).toBeNull();
    expect(parseConstraints({ version: 2 })).toBeNull();
    expect(parseConstraints({ version: 1, unknown_key: true })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (5) decisions
// ---------------------------------------------------------------------------

describe('plugin decisions (owner-private log)', () => {
  it('records and lists newest-first', () => {
    const id = createPending();
    decisions.record({ installId: id, decision: 'consent_granted', nowSec: T0_SEC });
    decisions.record({
      installId: id,
      capability: 'com.acme.flightwatch.watch',
      decision: 'invocation_denied',
      reason: 'constraints:count_exhausted',
      nowSec: T0_SEC + 5,
    });
    const list = decisions.listByInstall(id, 10);
    expect(list).toHaveLength(2);
    expect(list[0]!.decision).toBe('invocation_denied');
    expect(list[0]!.reason).toBe('constraints:count_exhausted');
    expect(decisions.listRecent(1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (6) abandoned-pending sweep
// ---------------------------------------------------------------------------

describe('first-N invocation counter (§8)', () => {
  it('records + reads per (install, capability); the gatekeeper first-N transition is now wired', () => {
    const id = createPending();
    installs.activate(id, undefined, T0);
    expect(installs.getInvocationCount(id, 'com.acme.flightwatch.watch')).toBe(0);
    expect(installs.recordInvocation(id, 'com.acme.flightwatch.watch')).toBe(1);
    expect(installs.recordInvocation(id, 'com.acme.flightwatch.watch')).toBe(2);
    expect(installs.recordInvocation(id, 'com.acme.flightwatch.watch')).toBe(3);
    // After the first 3, evaluatePluginIntent(priorInvocations: 3) goes silent.
    expect(installs.getInvocationCount(id, 'com.acme.flightwatch.watch')).toBe(3);
    // A different capability counts independently.
    expect(installs.getInvocationCount(id, 'other.cap')).toBe(0);
    // Cleared on uninstall (cascade).
    installs.remove(id);
    expect(installs.getInvocationCount(id, 'com.acme.flightwatch.watch')).toBe(0);
  });
});

describe('device binding (F8 pending bind + F9 unique active)', () => {
  it('F8: bindPendingDevice attaches a device to a PENDING install; only while pending', () => {
    const id = createPending();
    expect(installs.bindPendingDevice(id, 'did:key:zinst', T0 + 1)).toBe(true);
    expect(installs.getById(id)?.deviceDid).toBe('did:key:zinst');
    // Once active, bindPendingDevice no longer applies.
    installs.activate(id, 'did:key:zinst', T0 + 2);
    expect(installs.bindPendingDevice(id, 'did:key:zother', T0 + 3)).toBe(false);
    expect(installs.getById(id)?.deviceDid).toBe('did:key:zinst'); // unchanged
  });

  it('F9/P2-7: a second active install on a device is REFUSED (false), not thrown', () => {
    const a = createPending();
    const b = createPending();
    expect(installs.activate(a, 'did:key:zsame', T0)).toBe(true);
    // The partial unique index would raise SQLITE_CONSTRAINT_UNIQUE on a raw
    // write; activate pre-checks and returns its declared boolean instead of
    // throwing (P2-7). Silent double-binding is still impossible.
    expect(installs.activate(b, 'did:key:zsame', T0 + 1)).toBe(false);
    expect(installs.getById(b)?.status).toBe('pending'); // b untouched
    // The first install is untouched and is the deterministic lookup.
    expect(installs.getByDeviceDid('did:key:zsame')?.installId).toBe(a);
  });

  it('P2-7: resume onto a device already held by another active install returns false, not throws', () => {
    // `paused` was active on zshared, then paused. `other` is now active on the
    // same device. Resuming `paused` would violate the unique-active index.
    const paused = createPending();
    installs.activate(paused, 'did:key:zshared', T0);
    installs.pause(paused, T0 + 1);
    const other = createPending();
    expect(installs.activate(other, 'did:key:zshared', T0 + 2)).toBe(true);
    // Resume must return false (owner resolves the conflict), NOT throw.
    expect(installs.resume(paused, T0 + 3)).toBe(false);
    expect(installs.getById(paused)?.status).toBe('paused'); // unchanged
    // With the conflict gone, resume succeeds.
    installs.pause(other, T0 + 4);
    expect(installs.resume(paused, T0 + 5)).toBe(true);
  });

  it('F9: getByDeviceDid prefers the ACTIVE install deterministically', () => {
    // A paused install and an active install can share a device (the
    // unique index constrains ACTIVE rows only); lookup returns the active.
    const paused = createPending();
    installs.activate(paused, 'did:key:zdual', T0);
    installs.pause(paused, T0 + 1);
    const active = createPending();
    installs.activate(active, 'did:key:zdual', T0 + 2);
    expect(installs.getByDeviceDid('did:key:zdual')?.installId).toBe(active);
  });

  it('P1-3: listByDeviceDid returns EVERY install co-bound to a device, active-first', () => {
    // One active + one paused + one pending, all on the same device DID — the
    // index only constrains `active`, so getByDeviceDid returns just one row.
    // listByDeviceDid must enumerate all three so revocation disables them all.
    const active = createPending();
    installs.activate(active, 'did:key:zmulti', T0);
    const paused = createPending();
    installs.activate(paused, 'did:key:zmulti2', T0 + 1);
    installs.pause(paused, T0 + 2);
    // Re-bind the paused row onto the shared device (paused rows are unconstrained).
    adapter.execute('UPDATE plugin_installs SET device_did = ? WHERE install_id = ?', [
      'did:key:zmulti',
      paused,
    ]);
    const pending = createPending();
    installs.bindPendingDevice(pending, 'did:key:zmulti', T0 + 3);

    const all = installs.listByDeviceDid('did:key:zmulti');
    expect(all.map((i) => i.installId).sort()).toEqual([active, paused, pending].sort());
    // Active-first ordering.
    expect(all[0]!.installId).toBe(active);
    // getByDeviceDid still returns only the one active row — the gap P1-3 closes.
    expect(installs.getByDeviceDid('did:key:zmulti')?.installId).toBe(active);
    expect(installs.listByDeviceDid('')).toEqual([]);
  });
});

describe('abandoned-install sweep (§14)', () => {
  it('expires stale pendings and returns them (caller revokes any paired device)', () => {
    const stale = createPending({ pendingExpiresAtSec: T0_SEC - 10 });
    const fresh = createPending({ pendingExpiresAtSec: T0_SEC + 900 });
    // The dangerous case: pairing completed but consent never confirmed.
    // The device is bound to the PENDING row through the real seam.
    expect(installs.bindPendingDevice(stale, 'did:key:zorphan', T0)).toBe(true);
    const expired = installs.expireStalePending(T0_SEC);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.installId).toBe(stale);
    expect(expired[0]!.deviceDid).toBe('did:key:zorphan'); // caller must revokeDeviceDurable this
    expect(installs.getById(stale)).toBeNull();
    expect(installs.getById(fresh)).not.toBeNull();
    // Active installs are never swept.
    installs.activate(fresh, undefined, T0);
    expect(installs.expireStalePending(T0_SEC + 10_000)).toHaveLength(0);
  });
});
