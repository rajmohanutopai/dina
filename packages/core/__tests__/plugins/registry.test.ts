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
    // Default reason is owner-initiated (manual) → plainly resumable.
    expect(installs.getById(id)?.pauseReason).toBe('manual');
    expect(installs.resume(id, T0 + 3)).toBe(true);
    expect(installs.getById(id)?.status).toBe('active');
    expect(installs.getById(id)?.pauseReason).toBeUndefined(); // cleared on resume
  });

  it('round-9 #16: a plain resume refuses a device-revoke / restore / advisory hold', () => {
    for (const reason of ['device_revoked', 'restore', 'advisory'] as const) {
      const id = createPending();
      installs.activate(id, undefined, T0 + 1);
      expect(installs.pause(id, T0 + 2, reason)).toBe(true);
      expect(installs.getById(id)?.pauseReason).toBe(reason);
      // A generic resume must NOT revive a hold that needs a recovery flow.
      expect(installs.resume(id, T0 + 3)).toBe(false);
      expect(installs.getById(id)?.status).toBe('paused');
    }
    // A manual pause is still resumable.
    const m = createPending();
    installs.activate(m, undefined, T0 + 1);
    expect(installs.pause(m, T0 + 2, 'manual')).toBe(true);
    expect(installs.resume(m, T0 + 3)).toBe(true);
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
        constraints: { version: 1, max_count: 100 }, // Round-8 #1: standing needs a bound
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
          // Round-12 #8: the manifest must agree with the scalar columns —
          // carry the new version so rowToInstall doesn't quarantine the row.
          manifest: { ...manifest, version: '1.3.0' },
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

  it('round-9 #17: applyUpdate/setPendingUpdate honor an optional CAS (stale write is refused)', () => {
    const id = createPending();
    installs.activate(id, undefined, T0 + 1);
    const rev = installs.getById(id)!.configRevision;
    const upd = {
      cid: 'bafyreicid2',
      version: '1.3.0',
      manifest: { ...manifest, version: '1.3.0' }, // Round-12 #8: consistent scalar/manifest
      installScopeHash: 's2'.repeat(32),
      capabilityHashes: { 'com.acme.flightwatch.watch': 'c2'.repeat(32) },
      behaviorHash: 'b2'.repeat(32),
      presentationHash: 'p2'.repeat(32),
    };
    // A CAS that no longer matches (stale config_revision / wrong status) refuses.
    expect(installs.applyUpdate(id, upd, T0 + 2, { configRevision: rev + 99 })).toBe(false);
    expect(installs.applyUpdate(id, upd, T0 + 2, { status: 'pending' })).toBe(false);
    expect(installs.applyUpdate(id, upd, T0 + 2, { currentCid: 'bafyreiWRONG' })).toBe(false);
    expect(installs.getById(id)?.currentCid).toBe('bafyreicid1'); // untouched by stale writes
    // A matching CAS lands.
    expect(installs.applyUpdate(id, upd, T0 + 3, { configRevision: rev, status: 'active' })).toBe(
      true,
    );
    expect(installs.getById(id)?.currentCid).toBe('bafyreicid2');
    // setPendingUpdate CAS likewise: wrong pin refuses, right pin lands.
    const pend = {
      cid: 'bafyreicid4',
      behaviorHash: 'b4'.repeat(32),
      decision: 'awaiting_consent' as const,
    };
    expect(installs.setPendingUpdate(id, pend, T0 + 4, { currentCid: 'bafyreiWRONG' })).toBe(false);
    expect(installs.setPendingUpdate(id, pend, T0 + 5, { currentCid: 'bafyreicid2' })).toBe(true);
    expect(installs.getById(id)?.pendingCid).toBe('bafyreicid4');
    // No CAS supplied → keys by install_id alone (back-compat).
    expect(installs.applyUpdate(id, upd, T0 + 6)).toBe(true);
  });

  it('round-9 #19: one corrupt install row is quarantined, not fatal to the whole listing', () => {
    const good1 = createPending({ label: 'Good 1' });
    const bad = createPending({ label: 'Corrupt' });
    const good2 = createPending({ label: 'Good 2' });
    // Damage the bad row's manifest JSON — a divergent-node restore or bit-rot.
    adapter.execute('UPDATE plugin_installs SET manifest_json = ? WHERE install_id = ?', [
      '{not valid json',
      bad,
    ]);
    // list() must NOT throw; it returns the two healthy rows and drops the bad one.
    const all = installs.list();
    expect(all.map((i) => i.installId).sort()).toEqual([good1, good2].sort());
    // A direct getById on the corrupt row fails closed to null (quarantined).
    expect(installs.getById(bad)).toBeNull();
    // The healthy rows still load individually.
    expect(installs.getById(good1)?.label).toBe('Good 1');
  });
});

describe('round-14 registry hardening', () => {
  it('#17: pending_expires_at projects as a coerced number (mirrors the validation gate)', () => {
    const id = createPending({ pendingExpiresAtSec: T0_SEC + 900 });
    // The projection now coerces via Number() to match the validation gate — a
    // divergent adapter that returns pending_expires_at as a string no longer
    // gets DROPPED (which would read as "no expiry" and never lapse). The Node
    // SQLite path stores/returns it as an INTEGER, so we assert the coerced
    // projection round-trips here; the string case is the cross-adapter defense.
    expect(installs.getById(id)?.pendingExpiresAt).toBe(T0_SEC + 900);
  });

  it('#6: rawDeviceDid returns the bound device on a CORRUPT row where getById is null', () => {
    const id = createPending();
    installs.activate(id, 'did:key:zdevice', T0 + 1);
    expect(installs.getById(id)?.deviceDid).toBe('did:key:zdevice');
    // Corrupt the manifest → getById quarantines to null, but the raw scalar
    // getter still surfaces the device so declineConsent/uninstall can tear the
    // stuck row down instead of orphaning the paired device.
    adapter.execute('UPDATE plugin_installs SET manifest_json = ? WHERE install_id = ?', [
      '{bad json',
      id,
    ]);
    expect(installs.getById(id)).toBeNull();
    expect(installs.rawDeviceDid(id)).toBe('did:key:zdevice');
    expect(installs.rawStatus(id)).toBe('active');
    // No such row / no device → null.
    expect(installs.rawDeviceDid('nonexistent')).toBeNull();
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

  it('round-8 #1: an unconstrained standing grant is rejected for a custom capability, whatever the declared class', () => {
    // KEY is a CUSTOM (reverse-DNS) capability, so its declared class is a
    // consent label, not proof (§8) — a `read` declaration is as unverifiable as
    // `booking`. An unbounded standing grant runs silent, so ALL classes require
    // a bound for a custom capability.
    for (const cls of ['booking', 'write', 'agentic', 'read', 'quote']) {
      expect(() => grants.create({ installId, ...KEY, grantType: 'standing' }, cls, T0)).toThrow(
        /must be bounded|never offered/,
      );
    }
    // …but a BOUNDED standing grant is fine, whatever the declared class.
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
    // An expiry is also a valid bound.
    expect(
      grants.create(
        { installId, ...KEY, grantType: 'standing', expiresAt: T0_SEC + 3600 },
        'read',
        T0,
      ),
    ).toMatch(/^plg_/);
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

  it('round-7 #4: a NaN or negative value cannot defeat a max_value cap', () => {
    grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_value: 100 } },
      'booking',
      T0,
    );
    // NaN slips past `value > max` (NaN comparisons are false) — must be denied.
    expect(authorize('e-nan', { value: NaN })).toEqual({
      allowed: false,
      reason: 'value_exceeds_cap',
    });
    // A negative value is not a real transaction value — denied.
    expect(authorize('e-neg', { value: -100 })).toEqual({
      allowed: false,
      reason: 'value_exceeds_cap',
    });
    // A finite, non-negative, in-cap value authorizes.
    expect(authorize('e-ok', { value: 50 }).allowed).toBe(true);
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
    const first = authorize('exec-1');
    expect(first.allowed).toBe(true);
    const grantId = first.allowed ? first.grantId : '';
    expect(authorize('exec-2').allowed).toBe(false);
    // Round-11 #7: release is keyed on the SPECIFIC (grantId, executionId).
    expect(grants.releaseUse(grantId, 'exec-1')).toBe(true);
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
    // Round-9 #1: a grant can no longer be born already-expired (create-time
    // rejects a past expiry). Create with a valid future window, then authorize
    // AFTER it closes to exercise the expiry-deny path.
    const g = grants.create(
      { installId, ...KEY, grantType: 'window', expiresAt: T0_SEC + 10 },
      'read',
      T0,
    );
    expect(
      grants.authorizeAndConsume({ installId, ...KEY, executionId: 'e1', nowSec: T0_SEC + 20 }),
    ).toEqual({ allowed: false, reason: 'expired' });
    grants.revoke(g, T0_SEC);
    expect(authorize('e2')).toEqual({ allowed: false, reason: 'revoked' });

    const g2 = grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 100 } },
      'read',
      T0,
    );
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
    const g = grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 100 } },
      'read',
      T0,
    );
    // Simulate a future-version constraint object landing in the DB
    // (restored archive from a newer node).
    adapter.execute('UPDATE plugin_grants SET constraints_json = ? WHERE grant_id = ?', [
      JSON.stringify({ version: 99, quantum_budget: 3 }),
      g,
    ]);
    expect(authorize('e1')).toEqual({ allowed: false, reason: 'constraints_unparseable' });
  });

  it('revokeAllForInstall cascades (uninstall / device-revoke path)', () => {
    grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 100 } },
      'read',
      T0,
    );
    grants.create(
      {
        installId,
        capability: 'other.cap',
        approvedScopeHash: 'z'.repeat(64),
        grantType: 'standing',
        constraints: { version: 1, max_count: 100 }, // Round-8 #1: standing needs a bound
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

  it('round-9 #1/#12: a supplied expiry must be a real bound (finite integer seconds, future, in-window)', () => {
    const mk = (expiresAt: number): string =>
      grants.create({ installId, ...KEY, grantType: 'standing', expiresAt }, 'read', T0);
    // NaN would defeat the expiry check entirely (NaN <= nowSec is always false)
    // yet satisfy the presence-based "bounded" rule — a never-expiring grant.
    expect(() => mk(Number.NaN)).toThrow(/expiresAt/);
    expect(() => mk(Number.POSITIVE_INFINITY)).toThrow(/expiresAt/);
    // A millisecond value mistaken for seconds is ~50,000× too far in the future.
    expect(() => mk(T0)).toThrow(/expiresAt/); // T0 is ms; as seconds it's year ~57000
    // A non-integer, a past expiry, and one beyond the policy window all fail.
    expect(() => mk(T0_SEC + 0.5)).toThrow(/expiresAt/);
    expect(() => mk(T0_SEC - 1)).toThrow(/expiresAt/);
    expect(() => mk(T0_SEC + 400 * 24 * 60 * 60)).toThrow(/expiresAt/); // > ~1 year
    // A sane near-future expiry (seconds) is accepted.
    expect(() => mk(T0_SEC + 3600)).not.toThrow();
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

  it('round-9 #3: bindPendingDevice refuses a device already on another install (no cross-install collateral revoke)', () => {
    const first = createPending();
    const second = createPending();
    expect(installs.bindPendingDevice(first, 'did:key:zshare', T0 + 1)).toBe(true);
    // A second pending cannot grab the same device — declining `first` would
    // otherwise durably revoke the device and kill `second`'s runner.
    expect(installs.bindPendingDevice(second, 'did:key:zshare', T0 + 2)).toBe(false);
    expect(installs.getById(second)?.deviceDid).toBeUndefined();
    // Re-binding the SAME device to the SAME install is idempotent (true).
    expect(installs.bindPendingDevice(first, 'did:key:zshare', T0 + 3)).toBe(true);
    // Nor can a pending overwrite a DIFFERENT device already bound to its row.
    expect(installs.bindPendingDevice(first, 'did:key:zother', T0 + 4)).toBe(false);
    expect(installs.getById(first)?.deviceDid).toBe('did:key:zshare'); // unchanged
    // An active install on a device also blocks a new pending bind.
    const activeInst = createPending();
    installs.activate(activeInst, 'did:key:zactive', T0 + 5);
    const late = createPending();
    expect(installs.bindPendingDevice(late, 'did:key:zactive', T0 + 6)).toBe(false);
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
    // Co-bind the pending row via raw SQL — the real bindPendingDevice seam now
    // REFUSES a device already on another install (round-9 #3); this test is
    // about listByDeviceDid enumerating however the co-binding arose (e.g. a
    // restore or a legacy row), which revocation must disable in full.
    adapter.execute('UPDATE plugin_installs SET device_did = ? WHERE install_id = ?', [
      'did:key:zmulti',
      pending,
    ]);

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
  it('round-11 #16: listStalePending selects (not deletes) stale pendings; remove is the delete step', () => {
    // The convenience `expireStalePending` was removed — it deleted the
    // pending row WITHOUT the device-revoke-first ordering that the real
    // sweep (sweepAbandonedInstalls) enforces, orphaning the device. The
    // correct primitives are listStalePending → (revoke device) → remove.
    const stale = createPending({ pendingExpiresAtSec: T0_SEC - 10 });
    const fresh = createPending({ pendingExpiresAtSec: T0_SEC + 900 });
    // The dangerous case: pairing completed but consent never confirmed.
    // The device is bound to the PENDING row through the real seam.
    expect(installs.bindPendingDevice(stale, 'did:key:zorphan', T0)).toBe(true);

    // SELECT only — the row is NOT gone yet, so a device-revoke failure can
    // leave it as a retry anchor.
    const selected = installs.listStalePending(T0_SEC);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.installId).toBe(stale);
    expect(selected[0]!.deviceDid).toBe('did:key:zorphan'); // caller must revokeDeviceDurable this
    expect(installs.getById(stale)).not.toBeNull();

    // The caller deletes only after revoking the device durably.
    expect(installs.remove(stale)?.installId).toBe(stale);
    expect(installs.getById(stale)).toBeNull();
    expect(installs.getById(fresh)).not.toBeNull();

    // Active installs are never selected.
    installs.activate(fresh, undefined, T0);
    expect(installs.listStalePending(T0_SEC + 10_000)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// round-10 refinements
// ---------------------------------------------------------------------------

describe('round-10 refinements', () => {
  it('#5: escalatePauseReason upgrades a manual hold to device_revoked; resume then refuses', () => {
    const id = createPending();
    installs.activate(id, undefined, T0 + 1);
    expect(installs.pause(id, T0 + 2, 'manual')).toBe(true);
    // A device revoke over an already-paused install escalates the hold.
    expect(installs.escalatePauseReason(id, 'device_revoked', T0 + 3)).toBe(true);
    expect(installs.getById(id)?.pauseReason).toBe('device_revoked');
    expect(installs.resume(id, T0 + 4)).toBe(false); // no longer plainly resumable
    // Never DOWNGRADES a stronger existing hold.
    expect(installs.escalatePauseReason(id, 'device_revoked', T0 + 5)).toBe(false);
  });

  it('#8: bindPendingDevice refuses a device already on a PAUSED install', () => {
    const paused = createPending();
    installs.activate(paused, 'did:key:zshared', T0);
    installs.pause(paused, T0 + 1); // paused, still bound to zshared
    const fresh = createPending();
    // Round-9 only excluded active+pending; the paused hole let this through.
    expect(installs.bindPendingDevice(fresh, 'did:key:zshared', T0 + 2)).toBe(false);
    expect(installs.getById(fresh)?.deviceDid).toBeUndefined();
  });

  it('#13: a semantically-corrupt row (parses, wrong shape) is quarantined like a syntax error', () => {
    const good = createPending({ label: 'Good' });
    const nullManifest = createPending({ label: 'NullManifest' });
    const arrHashes = createPending({ label: 'ArrHashes' });
    // Both parse as valid JSON but are the wrong SHAPE.
    adapter.execute('UPDATE plugin_installs SET manifest_json = ? WHERE install_id = ?', [
      'null',
      nullManifest,
    ]);
    adapter.execute('UPDATE plugin_installs SET capability_hashes_json = ? WHERE install_id = ?', [
      '[]',
      arrHashes,
    ]);
    const all = installs.list();
    expect(all.map((i) => i.installId)).toEqual([good]);
    expect(installs.getById(nullManifest)).toBeNull();
    expect(installs.getById(arrHashes)).toBeNull();
  });

  it('#14: listRawByDeviceDid still returns a corrupt row that listByDeviceDid drops', () => {
    const id = createPending();
    installs.activate(id, 'did:key:zcorrupt', T0);
    adapter.execute('UPDATE plugin_installs SET trust_anchor_json = ? WHERE install_id = ?', [
      '{not json',
      id,
    ]);
    // The full mapper quarantines it (invisible to Settings/UI)...
    expect(installs.listByDeviceDid('did:key:zcorrupt')).toHaveLength(0);
    // ...but authority cleanup can still see + act on it.
    const raw = installs.listRawByDeviceDid('did:key:zcorrupt');
    expect(raw).toHaveLength(1);
    expect(raw[0]).toEqual({ installId: id, status: 'active' });
  });

  it('#17: an update CAS can assert pending_cid IS NULL (guarding first-pending creation)', () => {
    const id = createPending();
    installs.activate(id, undefined, T0 + 1);
    const pend = {
      cid: 'bafyreiNEW',
      behaviorHash: 'b'.repeat(64),
      decision: 'awaiting_consent' as const,
    };
    // Nothing pending yet → the null-CAS lands.
    expect(installs.setPendingUpdate(id, pend, T0 + 2, { pendingCid: null })).toBe(true);
    expect(installs.getById(id)?.pendingCid).toBe('bafyreiNEW');
    // A concurrent second "first pending" (null-CAS) is now refused.
    expect(
      installs.setPendingUpdate(id, { ...pend, cid: 'bafyreiOTHER' }, T0 + 3, { pendingCid: null }),
    ).toBe(false);
    expect(installs.getById(id)?.pendingCid).toBe('bafyreiNEW'); // unchanged
  });

  it('#18: resume folds the reason gate into the write (a hold escalated after the read is not clobbered)', () => {
    const id = createPending();
    installs.activate(id, undefined, T0 + 1);
    installs.pause(id, T0 + 2, 'manual');
    // Escalate to an advisory hold (simulating a concurrent change) — a resume
    // whose read saw 'manual' must still be blocked by the write predicate.
    installs.escalatePauseReason(id, 'advisory', T0 + 3);
    expect(installs.resume(id, T0 + 4)).toBe(false);
    expect(installs.getById(id)?.status).toBe('paused');
    expect(installs.getById(id)?.pauseReason).toBe('advisory');
  });
});

// ---------------------------------------------------------------------------
// round-11 refinements
// ---------------------------------------------------------------------------

describe('round-11 refinements', () => {
  const KEY = {
    capability: 'com.acme.flightwatch.watch',
    approvedScopeHash: 'c'.repeat(64),
  };

  it('#1: a replayed execution_id carrying DIFFERENT params is invocation_mismatch, not a free re-auth', () => {
    const installId = createPending();
    installs.activate(installId, undefined, T0);
    grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_value: 100 } },
      'booking',
      T0,
    );
    // First consume binds execution 'e1' to value 50.
    expect(
      grants.authorizeAndConsume({
        installId,
        ...KEY,
        executionId: 'e1',
        nowSec: T0_SEC,
        value: 50,
      }).allowed,
    ).toBe(true);
    // A genuine lease-recovery retry replays the SAME params → free re-auth.
    expect(
      grants.authorizeAndConsume({
        installId,
        ...KEY,
        executionId: 'e1',
        nowSec: T0_SEC,
        value: 50,
      }).allowed,
    ).toBe(true);
    // Reusing 'e1' with a DIFFERENT value would smuggle a distinct invocation
    // past the value-cap check under a spent reservation — denied.
    expect(
      grants.authorizeAndConsume({
        installId,
        ...KEY,
        executionId: 'e1',
        nowSec: T0_SEC,
        value: 99,
      }),
    ).toEqual({ allowed: false, reason: 'invocation_mismatch' });
  });

  it('#15: a new grant for the same scope tombstones the prior one (revoke of the newest is terminal)', () => {
    const installId = createPending();
    installs.activate(installId, undefined, T0);
    const g1 = grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 5 } },
      'booking',
      T0,
    );
    // A second consent for the SAME scope supersedes the first.
    const g2 = grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 5 } },
      'booking',
      T0 + 1,
    );
    expect(grants.getById(g1)?.revokedAt).toBeGreaterThan(0); // tombstoned
    expect(grants.getById(g2)?.revokedAt).toBeUndefined(); // sole live grant
    // Revoking the newest leaves NOTHING live — the newest-first scan must not
    // fall through to the older (tombstoned) g1.
    expect(grants.revoke(g2, T0_SEC + 5)).toBe(true);
    expect(
      grants.authorizeAndConsume({ installId, ...KEY, executionId: 'e1', nowSec: T0_SEC + 6 }),
    ).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('#14: a corrupt constraints_json projects constraintsCorrupt, not a silent unconstrained grant', () => {
    const installId = createPending();
    installs.activate(installId, undefined, T0);
    const g = grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 3 } },
      'booking',
      T0,
    );
    // Corrupt the stored blob (divergent-node restore / bit-rot).
    adapter.execute('UPDATE plugin_grants SET constraints_json = ? WHERE grant_id = ?', [
      '{bad',
      g,
    ]);
    const proj = grants.getById(g);
    expect(proj?.constraintsCorrupt).toBe(true);
    expect(proj?.constraints).toBeUndefined(); // never projected as a real bound
    // The projection now agrees with the fail-closed authorization decision.
    expect(
      grants.authorizeAndConsume({ installId, ...KEY, executionId: 'e1', nowSec: T0_SEC }),
    ).toEqual({ allowed: false, reason: 'constraints_unparseable' });
  });

  it('#2: hasLiveGrant reports liveness for a scope without consuming a use', () => {
    const installId = createPending();
    installs.activate(installId, undefined, T0);
    expect(grants.hasLiveGrant(installId, KEY.capability, KEY.approvedScopeHash, T0_SEC)).toBe(
      false,
    );
    const g = grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 2 } },
      'booking',
      T0,
    );
    expect(grants.hasLiveGrant(installId, KEY.capability, KEY.approvedScopeHash, T0_SEC)).toBe(
      true,
    );
    // A read-only probe consumes nothing.
    expect(adapter.query('SELECT 1 FROM plugin_grant_uses WHERE grant_id = ?', [g])).toHaveLength(
      0,
    );
    // Revocation makes it not-live.
    grants.revoke(g, T0_SEC + 1);
    expect(grants.hasLiveGrant(installId, KEY.capability, KEY.approvedScopeHash, T0_SEC + 2)).toBe(
      false,
    );
  });

  it('#9: a manifest capability that lacks a string id quarantines the row (getById → null)', () => {
    const id = createPending();
    adapter.execute('UPDATE plugin_installs SET manifest_json = ? WHERE install_id = ?', [
      JSON.stringify({ ...manifest, capabilities: [{ display_name: 'no id' }] }),
      id,
    ]);
    expect(installs.getById(id)).toBeNull();
  });

  it('#9: capability_hashes with a non-string value quarantines the row', () => {
    const id = createPending();
    adapter.execute('UPDATE plugin_installs SET capability_hashes_json = ? WHERE install_id = ?', [
      JSON.stringify({ 'com.acme.flightwatch.watch': 123 }),
      id,
    ]);
    expect(installs.getById(id)).toBeNull();
  });

  it('#10: a semantically-corrupt install row AND its grants are still removable', () => {
    const id = createPending();
    installs.activate(id, undefined, T0);
    grants.create({ installId: id, ...KEY, grantType: 'once' }, 'read', T0);
    // Corrupt the row so getById quarantines it (returns null).
    adapter.execute('UPDATE plugin_installs SET manifest_json = ? WHERE install_id = ?', [
      '{bad json',
      id,
    ]);
    expect(installs.getById(id)).toBeNull();
    // remove() still cascades keyed on the raw install_id — row + grant go.
    installs.remove(id);
    expect(adapter.query('SELECT 1 FROM plugin_installs WHERE install_id = ?', [id])).toHaveLength(
      0,
    );
    expect(adapter.query('SELECT 1 FROM plugin_grants WHERE install_id = ?', [id])).toHaveLength(0);
  });

  it('#12: applyUpdate refuses to flip the execution mode; a same-mode update applies', () => {
    const id = createPending(); // executionMode 'runner'
    installs.activate(id, undefined, T0);
    const base = {
      installScopeHash: 's'.repeat(64),
      capabilityHashes: { 'com.acme.flightwatch.watch': 'c'.repeat(64) },
      behaviorHash: 'b'.repeat(64),
      presentationHash: 'p'.repeat(64),
    };
    const flipped: PluginManifest = { ...manifest, execution: { mode: 'interpreted' } };
    expect(
      installs.applyUpdate(
        id,
        { cid: 'bafyreicid2', version: '1.3.0', manifest: flipped, ...base },
        T0 + 5,
      ),
    ).toBe(false); // execution_mode pin mismatches → refused
    expect(installs.getById(id)?.currentVersion).toBe('1.2.0'); // unchanged
    // Round-12 #8: same-mode update must also carry the new version in the
    // manifest so the scalar/manifest cross-check passes.
    const sameMode: PluginManifest = {
      ...manifest,
      execution: { mode: 'runner' },
      version: '1.3.0',
    };
    expect(
      installs.applyUpdate(
        id,
        { cid: 'bafyreicid3', version: '1.3.0', manifest: sameMode, ...base },
        T0 + 6,
      ),
    ).toBe(true);
    expect(installs.getById(id)?.currentVersion).toBe('1.3.0');
  });
});

// ---------------------------------------------------------------------------
// round-12 refinements
// ---------------------------------------------------------------------------

describe('round-12 refinements', () => {
  const KEY = {
    capability: 'com.acme.flightwatch.watch',
    approvedScopeHash: 'c'.repeat(64),
  };

  it('#1: the invocation digest binds the FULL params — a same-execution_id replay with different params is invocation_mismatch', () => {
    const installId = createPending();
    installs.activate(installId, undefined, T0);
    grants.create(
      { installId, ...KEY, grantType: 'standing', constraints: { version: 1, max_count: 5 } },
      'booking',
      T0,
    );
    const base = { installId, ...KEY, executionId: 'e1', nowSec: T0_SEC };
    // First consume binds e1 to these exact params.
    expect(
      grants.authorizeAndConsume({ ...base, params: { recipient: 'alice', amount: 5 } }).allowed,
    ).toBe(true);
    // A genuine retry replays the SAME params → free re-auth.
    expect(
      grants.authorizeAndConsume({ ...base, params: { recipient: 'alice', amount: 5 } }).allowed,
    ).toBe(true);
    // Reusing e1 with a DIFFERENT recipient (resource+value unchanged) is a
    // distinct invocation smuggled under the execution_id — denied (Round-11 #1
    // only bound resource+value; this proves the widening).
    expect(
      grants.authorizeAndConsume({ ...base, params: { recipient: 'mallory', amount: 5 } }),
    ).toEqual({ allowed: false, reason: 'invocation_mismatch' });
  });

  it('#7: applyUpdate resets the first-N invocation counter (re-consent restarts the cards)', () => {
    const id = createPending();
    installs.activate(id, undefined, T0);
    installs.recordInvocation(id, KEY.capability);
    installs.recordInvocation(id, KEY.capability);
    expect(installs.getInvocationCount(id, KEY.capability)).toBe(2);
    // A manifest update = a new consent surface → the counter restarts.
    expect(
      installs.applyUpdate(
        id,
        {
          cid: 'bafyreicid9',
          version: '2.0.0',
          manifest: { ...manifest, version: '2.0.0' },
          installScopeHash: 's9'.repeat(32),
          capabilityHashes: { [KEY.capability]: 'c9'.repeat(32) },
          behaviorHash: 'b9'.repeat(32),
          presentationHash: 'p9'.repeat(32),
        },
        T0 + 5,
      ),
    ).toBe(true);
    expect(installs.getInvocationCount(id, KEY.capability)).toBe(0);
  });

  it('#8: a row whose scalar plugin_id/version/execution_mode disagree with the manifest is quarantined', () => {
    const id = createPending();
    // The column says one plugin_id, the manifest another — inconsistent authority.
    adapter.execute('UPDATE plugin_installs SET plugin_id = ? WHERE install_id = ?', [
      'com.evil.other',
      id,
    ]);
    expect(installs.getById(id)).toBeNull();

    const id2 = createPending();
    adapter.execute('UPDATE plugin_installs SET current_version = ? WHERE install_id = ?', [
      '9.9.9',
      id2,
    ]);
    expect(installs.getById(id2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// round-13 refinements
// ---------------------------------------------------------------------------

describe('round-13 refinements', () => {
  it('#16: a row with an INVALID trust anchor (unknown kind / missing field) is quarantined', () => {
    const id = createPending();
    adapter.execute('UPDATE plugin_installs SET trust_anchor_json = ? WHERE install_id = ?', [
      '{"kind":"made_up"}',
      id,
    ]);
    expect(installs.getById(id)).toBeNull();

    const id2 = createPending();
    adapter.execute('UPDATE plugin_installs SET trust_anchor_json = ? WHERE install_id = ?', [
      '{"kind":"org_key"}', // missing orgDid
      id2,
    ]);
    expect(installs.getById(id2)).toBeNull();
  });

  it('#23: a negative/fractional config_revision or invalid timestamp is quarantined', () => {
    const neg = createPending();
    adapter.execute('UPDATE plugin_installs SET config_revision = ? WHERE install_id = ?', [
      -5,
      neg,
    ]);
    expect(installs.getById(neg)).toBeNull();

    const frac = createPending();
    adapter.execute('UPDATE plugin_installs SET config_revision = ? WHERE install_id = ?', [
      0.7,
      frac,
    ]);
    expect(installs.getById(frac)).toBeNull();

    const badTs = createPending();
    adapter.execute('UPDATE plugin_installs SET pending_expires_at = ? WHERE install_id = ?', [
      -1,
      badTs,
    ]);
    expect(installs.getById(badTs)).toBeNull();
  });
});
