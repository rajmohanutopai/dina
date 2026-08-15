/**
 * Real export/import (issues.txt §3).
 *
 * Seeds identity + two persona SQLCipher DBs with real rows, exports an
 * archive, then imports into a SEPARATE clean set of DBs and verifies the
 * rows came back — the clean-install restore the spec mandates. Also
 * covers: secret exclusion, wrong passphrase, corrupt bytes, unsupported
 * version, the clean-install guard, and the "data + no data source →
 * throws" production guarantee.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { computePluginDigests, normalizePluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  COMMERCE_RESTORE_PENDING_KEY,
  isCommerceRestorePending,
  markCommerceRestorePending,
} from '../../src/commerce/restore_marker';
import {
  createArchive,
  importArchive,
  readManifest,
  setArchiveDataSource,
  verifyArchive,
  type ArchiveDataSource,
  type ArchivePersonaSource,
} from '../../src/export/archive';
import { commerceRecordDigest } from '@dina/commerce-protocol';

import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS, PERSONA_MIGRATIONS } from '../../src/storage/schemas';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const PASS = 'correct horse battery staple';
const WRONG = 'incorrect zebra';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dina-archive-'));
}
function openId(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({
    path: p,
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(a, IDENTITY_MIGRATIONS);
  return a;
}
function openPersona(p: string): NodeSQLiteAdapter {
  const a = new NodeSQLiteAdapter({
    path: p,
    passphraseHex: PASSHEX,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(a, PERSONA_MIGRATIONS);
  return a;
}
const PASSHEX = randomBytes(32).toString('hex');

function seedIdentity(a: DatabaseAdapter): void {
  a.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', ['theme', 'dark', 1]);
  // A secret — must NOT appear in the archive.
  a.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', [
    'gemini_api_key',
    'SECRET-123',
    1,
  ]);
  a.execute(
    `INSERT INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['rem-1', 'r1', 'call mom', 9_999, 'general', 'manual', '', 'user', '', '', 'pending', 0, 1],
  );
  // A published multi-listing service config (v8) — MUST be backed up/restored.
  a.execute(
    'INSERT INTO service_configs (rkey, config_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ['route-42', '{"name":"Bus 42"}', 1, 1],
  );
  // A received known_only offer (v9) — contact metadata, MUST be backed up.
  a.execute(
    `INSERT INTO contact_service_offers (grant_id, provider_did, capability, service_uri, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      'g-recv',
      'did:plc:bus',
      'eta_query',
      'at://did:plc:bus/com.dinakernel.service.profile/self',
      1,
      1,
    ],
  );
  // An ISSUED grant (v10) — active authority; MUST be EXCLUDED from the archive
  // (same posture as agent_persona_grants — re-issue offers after migration).
  a.execute(
    `INSERT INTO service_grants (grant_id, grantee_did, service_rkey, capability, grant_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['grant-secret', 'did:plc:emma', 'route-42', 'eta_query', 'standing', 1],
  );
}
function seedVaultItem(
  a: DatabaseAdapter,
  id: string,
  text: string,
  embedding: Uint8Array | null = null,
): void {
  a.execute(
    'INSERT INTO vault_items (id, content_l0, timestamp, created_at, updated_at, embedding) VALUES (?,?,?,?,?,?)',
    [id, text, 1, 1, 1, embedding],
  );
}

interface Bundle {
  id: NodeSQLiteAdapter;
  personas: Map<string, { tier: string; adapter: NodeSQLiteAdapter }>;
  dir: string;
}
function freshBundle(personas: [string, string][]): Bundle {
  const dir = tmpDir();
  const id = openId(path.join(dir, 'identity.sqlite'));
  const map = new Map<string, { tier: string; adapter: NodeSQLiteAdapter }>();
  for (const [name, tier] of personas) {
    map.set(name, { tier, adapter: openPersona(path.join(dir, `${name}.sqlite`)) });
  }
  return { id, personas: map, dir };
}
function closeBundle(b: Bundle): void {
  try {
    b.id.close();
  } catch {
    /* */
  }
  for (const { adapter } of b.personas.values()) {
    try {
      adapter.close();
    } catch {
      /* */
    }
  }
  fs.rmSync(b.dir, { recursive: true, force: true });
}

function dataSourceFor(b: Bundle): ArchiveDataSource {
  return {
    identityAdapter: () => b.id,
    personaSources: async (): Promise<ArchivePersonaSource[]> =>
      [...b.personas.entries()].map(([name, { tier, adapter }]) => ({ name, tier, adapter })),
    openPersonaForRestore: async (name, tier) => {
      const existing = b.personas.get(name);
      if (existing) return existing.adapter;
      const adapter = openPersona(path.join(b.dir, `${name}.sqlite`));
      b.personas.set(name, { tier, adapter });
      return adapter;
    },
    hasExistingUserData: async () =>
      b.id.query('SELECT 1 FROM reminders LIMIT 1').length > 0 ||
      b.id.query("SELECT 1 FROM kv_store WHERE key NOT LIKE '%api_key%' LIMIT 1").length > 0,
  };
}

afterEach(() => setArchiveDataSource(null));

// A VALID manifest — round-10 #15 drops plugin_installs whose manifest fails
// validation on restore, so fixtures must carry a real one.
const VALID_MANIFEST_JSON = JSON.stringify({
  $type: 'com.dinakernel.plugin.release',
  plugin_id: 'com.acme.fw',
  version: '1.0.0',
  display_name: 'FW',
  execution: { mode: 'runner' },
  capabilities: [
    {
      id: 'com.acme.fw.watch',
      display_name: 'Watch',
      interaction: 'query',
      action_class: 'read',
      privacy_class: 'personal',
      kinds: ['tool'],
      effects: { idempotency: 'unsupported' },
    },
  ],
});

// Round-11 #11: import now recomputes the canonical digest columns from the
// manifest and drops any plugin_install whose stored siblings disagree. The
// fixture must therefore carry the REAL digests, not placeholders.
const MANIFEST_DIGESTS = computePluginDigests(
  normalizePluginManifest(JSON.parse(VALID_MANIFEST_JSON)),
  sha256,
);
const VALID_CAP_HASHES_JSON = JSON.stringify(MANIFEST_DIGESTS.perCapability);

/**
 * A REAL status receipt: a record and the digest that record produces.
 *
 * The round-trip used to insert `'c'.repeat(64)` with `record_json: '{}'`,
 * which the import preflight now refuses as forged — correctly, since no node
 * could have written it. A round-trip fixture has to carry what a node would
 * actually have stored, or it proves the pipe rather than the contents.
 */
const STATUS_RECEIPT = (() => {
  const base = { purchase_order_id: 'po-1', state: 'accepted', status_digest: '' };
  const digest = commerceRecordDigest('status', base, (data) => sha256(data));
  return { digest, recordJson: JSON.stringify({ ...base, status_digest: digest }) };
})();

/**
 * The order and quote receipts the round-trip fixture used to omit.
 *
 * It called itself "a full, coherent commerce set" while filing an order
 * under `'a'.repeat(64)` and a quote head under `'b'.repeat(64)` — digests no
 * receipt in the archive carried. Those two rows are not decoration: the
 * status, fence and cancellation paths all fetch the order receipt by
 * `order_digest` and refuse with "order receipt missing — store integrity
 * failure" without it, and `loadRetainedQuote` returns null for a head whose
 * digest names nothing. Restoring that set produced a node whose every open
 * order was already unusable. The preflight now refuses it, so the fixture
 * carries what a node would really have stored.
 */
const receiptFor = (domain: 'order' | 'quote', base: Record<string, unknown>, field: string) => {
  const digest = commerceRecordDigest(domain, { ...base, [field]: '' }, (data) => sha256(data));
  return { digest, recordJson: JSON.stringify({ ...base, [field]: digest }) };
};
const ORDER_RECEIPT = receiptFor(
  'order',
  { purchase_order_id: 'po-1', quote_id: 'q-1', buyer_did: 'did:plc:buyer' },
  'order_digest',
);
const QUOTE_RECEIPT = receiptFor(
  'quote',
  { quote_id: 'q-1', supplier_did: 'did:plc:supplier', revision: '0' },
  'quote_digest',
);

describe('real export → clean-install import', () => {
  it('restores identity + multi-persona rows, excluding secrets', async () => {
    const src = freshBundle([
      ['general', 'default'],
      ['health', 'sensitive'],
    ]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      seedVaultItem(
        src.personas.get('general')!.adapter,
        'v-gen',
        'general note',
        // Node returns this SQLite BLOB as Buffer; mobile op-sqlite returns an
        // ArrayBuffer. Both must survive the archive JSON codec byte-for-byte.
        new Uint8Array([0x01, 0x7f, 0x80, 0xff]),
      );
      seedVaultItem(src.personas.get('health')!.adapter, 'v-health', 'bp 120/80');
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    // Import into a clean install (fresh empty DBs, personas created on demand).
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS);

      // Identity restored — non-secret kv + reminder.
      expect(dest.id.query("SELECT value FROM kv_store WHERE key = 'theme'")[0]?.value).toBe(
        'dark',
      );
      expect(
        dest.id.query('SELECT message FROM reminders WHERE id = ?', ['rem-1'])[0]?.message,
      ).toBe('call mom');
      // Secret EXCLUDED — never entered the archive.
      expect(dest.id.query("SELECT 1 FROM kv_store WHERE key = 'gemini_api_key'")).toHaveLength(0);
      // Both personas restored (created on demand during import).
      expect(
        dest.personas
          .get('general')!
          .adapter.query('SELECT content_l0 FROM vault_items WHERE id = ?', ['v-gen'])[0]
          ?.content_l0,
      ).toBe('general note');
      const restoredEmbedding = dest.personas
        .get('general')!
        .adapter.query('SELECT embedding FROM vault_items WHERE id = ?', ['v-gen'])[0]?.embedding;
      expect(Array.from(restoredEmbedding as Uint8Array)).toEqual([0x01, 0x7f, 0x80, 0xff]);
      expect(
        dest.personas
          .get('health')!
          .adapter.query('SELECT content_l0 FROM vault_items WHERE id = ?', ['v-health'])[0]
          ?.content_l0,
      ).toBe('bp 120/80');
      // Multi-listing service config restored (v8 — the P1 export fix).
      expect(
        dest.id.query("SELECT config_json FROM service_configs WHERE rkey = 'route-42'")[0]
          ?.config_json,
      ).toBe('{"name":"Bus 42"}');
      // Received known_only offer restored (v9 — contact metadata).
      expect(
        dest.id.query("SELECT capability FROM contact_service_offers WHERE grant_id = 'g-recv'")[0]
          ?.capability,
      ).toBe('eta_query');
      // ISSUED grant EXCLUDED — active authority must NOT ride a backup (v10),
      // same posture as agent_persona_grants. The table exists (migrated) but is empty.
      expect(dest.id.query('SELECT 1 FROM service_grants')).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  it('P2-12: plugin install restores PAUSED with no device + no grants', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // An ACTIVE install with a paired device + a live grant.
      src.id.execute(
        `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
           current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
           behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'pli_1',
          'did:plc:acme',
          'com.acme.fw',
          'active',
          'runner',
          'bafyreicid',
          '1.0.0',
          VALID_MANIFEST_JSON,
          MANIFEST_DIGESTS.installScopeHash,
          VALID_CAP_HASHES_JSON,
          MANIFEST_DIGESTS.behaviorHash,
          MANIFEST_DIGESTS.presentationHash,
          '{"kind":"repo_proof"}',
          'did:key:zdev',
          1,
          1,
          1,
        ],
      );
      src.id.execute(
        `INSERT INTO plugin_grants (grant_id, install_id, capability, approved_scope_hash, grant_type, created_at)
         VALUES (?,?,?,?,?,?)`,
        ['g-1', 'pli_1', 'com.acme.fw.watch', 'h', 'standing', 1],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    try {
      // The TARGET already holds this install (active) + a STALE grant — both
      // must be reset on restore (the install→paused, the grant cleared).
      dest.id.execute(
        `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
           current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
           behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'pli_1',
          'did:plc:acme',
          'com.acme.fw',
          'active',
          'runner',
          'bafyreicid',
          '1.0.0',
          VALID_MANIFEST_JSON,
          's',
          '{"c":"h"}',
          'b',
          'p',
          '{"kind":"repo_proof"}',
          'did:key:zdev',
          1,
          1,
          1,
        ],
      );
      dest.id.execute(
        `INSERT INTO plugin_grants (grant_id, install_id, capability, approved_scope_hash, grant_type, created_at)
         VALUES (?,?,?,?,?,?)`,
        ['g-old', 'pli_1', 'com.acme.fw.watch', 'h', 'standing', 1],
      );
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });

      const row = dest.id.query(
        'SELECT status, device_did FROM plugin_installs WHERE install_id = ?',
        ['pli_1'],
      )[0];
      // The catalog is preserved, but restored PAUSED with no device binding.
      expect(row?.status).toBe('paused');
      expect(row?.device_did == null).toBe(true);
      // Grants never travel AND the target's stale grant was cleared.
      expect(dest.id.query('SELECT 1 FROM plugin_grants')).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  it('round-15 #16: a restored install drops stale pending-update state', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      src.id.execute(
        `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
           current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
           behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
           pending_cid, pending_behavior_hash, pending_decision, pending_expires_at,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'pli_pend',
          'did:plc:acme',
          'com.acme.fw',
          'active',
          'runner',
          'bafyreicid',
          '1.0.0',
          VALID_MANIFEST_JSON,
          MANIFEST_DIGESTS.installScopeHash,
          VALID_CAP_HASHES_JSON,
          MANIFEST_DIGESTS.behaviorHash,
          MANIFEST_DIGESTS.presentationHash,
          '{"kind":"repo_proof"}',
          null,
          1,
          'bafyrepending',
          'pendbehaviorhash',
          'awaiting_consent',
          999,
          1,
          1,
        ],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      const row = dest.id.query(
        `SELECT pending_cid, pending_behavior_hash, pending_decision, pending_expires_at
         FROM plugin_installs WHERE install_id = ?`,
        ['pli_pend'],
      )[0];
      // A restored install must re-pair + re-consent, so any pre-backup update
      // decision is stale — the pending_* columns are nulled.
      expect(row?.pending_cid == null).toBe(true);
      expect(row?.pending_behavior_hash == null).toBe(true);
      expect(row?.pending_decision == null).toBe(true);
      expect(row?.pending_expires_at == null).toBe(true);
    } finally {
      closeBundle(dest);
    }
  });

  it('round-15 #17: forged/unknown plugin decision kinds are dropped on import', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      src.id.execute(
        `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?)`,
        ['pli_x', 'cap', 'consent_granted', '', 1],
      );
      src.id.execute(
        `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?)`,
        ['pli_x', 'cap', 'totally_forged_kind', 'injected', 1],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      const kinds = dest.id
        .query('SELECT decision FROM plugin_decisions')
        .map((r) => String(r.decision));
      expect(kinds).toContain('consent_granted'); // a valid kind survives
      expect(kinds).not.toContain('totally_forged_kind'); // the forged kind is dropped
    } finally {
      closeBundle(dest);
    }
  });

  it('round-16 #19: decision rows with malformed fields (oversized reason / bad created_at / spoof) are dropped on import', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // A clean row survives; three valid-KIND but malformed rows are dropped.
      src.id.execute(
        `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?)`,
        ['pli_clean', 'cap', 'consent_granted', 'ok', 5],
      );
      src.id.execute(
        `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?)`,
        ['pli_bigreason', 'cap', 'consent_granted', 'r'.repeat(600), 5], // reason > 512
      );
      src.id.execute(
        `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?)`,
        ['pli_badtime', 'cap', 'consent_granted', 'ok', -1], // negative created_at
      );
      src.id.execute(
        `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?)`,
        ['pli_spoof', 'cap', 'consent_granted', 'inj‮ected', 5], // bidi-override in reason
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      const installIds = dest.id
        .query('SELECT install_id FROM plugin_decisions')
        .map((r) => String(r.install_id));
      expect(installIds).toEqual(['pli_clean']); // only the well-formed row survives
    } finally {
      closeBundle(dest);
    }
  });

  it('PLG-27 #17: a decision row with a negative / non-integer id is dropped on import', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // A clean auto-id row survives; a row carrying an explicit NEGATIVE id
      // (a malformed audit id from a crafted archive) is dropped.
      src.id.execute(
        `INSERT INTO plugin_decisions (install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?)`,
        ['pli_ok', 'cap', 'consent_granted', 'ok', 5],
      );
      src.id.execute(
        `INSERT INTO plugin_decisions (id, install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?,?)`,
        [-7, 'pli_badid', 'cap', 'consent_granted', 'ok', 5],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      const installIds = dest.id
        .query('SELECT install_id FROM plugin_decisions')
        .map((r) => String(r.install_id));
      expect(installIds).toEqual(['pli_ok']); // the negative-id row is dropped
    } finally {
      closeBundle(dest);
    }
  });

  it('round-11 #11: a plugin install whose digest columns disagree with its manifest is DROPPED on import', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // A VALID manifest, but a FORGED install_scope_hash — the archive is
      // attacker-influenced (its tag only proves the importer's passphrase), so
      // the per-capability + install/behavior/presentation digests, which the
      // consent path reads as authority, are recomputed on import and this row
      // dropped because they disagree with the manifest.
      src.id.execute(
        `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
           current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
           behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'pli_forged',
          'did:plc:acme',
          'com.acme.fw',
          'active',
          'runner',
          'bafyreicid',
          '1.0.0',
          VALID_MANIFEST_JSON,
          'FORGED-install-scope-hash', // != computePluginDigests(...).installScopeHash
          VALID_CAP_HASHES_JSON,
          MANIFEST_DIGESTS.behaviorHash,
          MANIFEST_DIGESTS.presentationHash,
          '{"kind":"repo_proof"}',
          'did:key:zdev',
          1,
          1,
          1,
        ],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      // The forged-digest install never persisted into the registry.
      expect(
        dest.id.query('SELECT 1 FROM plugin_installs WHERE install_id = ?', ['pli_forged']),
      ).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  it('round-12 #9: an install whose SCALAR identity disagrees with the manifest is DROPPED on import', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // All digests are CORRECT, but the plugin_id column disagrees with the
      // manifest — the catalog identity the UI + claim guard read would diverge
      // from the code/consent snapshot. Dropped by the scalar cross-check.
      src.id.execute(
        `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
           current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
           behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'pli_idmismatch',
          'did:plc:acme',
          'com.evil.other', // != manifest.plugin_id
          'active',
          'runner',
          'bafyreicid',
          '1.0.0',
          VALID_MANIFEST_JSON,
          MANIFEST_DIGESTS.installScopeHash,
          VALID_CAP_HASHES_JSON,
          MANIFEST_DIGESTS.behaviorHash,
          MANIFEST_DIGESTS.presentationHash,
          '{"kind":"repo_proof"}',
          'did:key:zdev',
          1,
          1,
          1,
        ],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      expect(
        dest.id.query('SELECT 1 FROM plugin_installs WHERE install_id = ?', ['pli_idmismatch']),
      ).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  it('round-13 #16: an install whose trust_anchor is not a valid union member is DROPPED on import', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // Everything else is honest, but the trust anchor is an unknown kind — the
      // consent/authority record must not persist a bogus anchor.
      src.id.execute(
        `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
           current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
           behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'pli_badanchor',
          'did:plc:acme',
          'com.acme.fw',
          'active',
          'runner',
          'bafyreicid',
          '1.0.0',
          VALID_MANIFEST_JSON,
          MANIFEST_DIGESTS.installScopeHash,
          VALID_CAP_HASHES_JSON,
          MANIFEST_DIGESTS.behaviorHash,
          MANIFEST_DIGESTS.presentationHash,
          '{"kind":"made_up"}', // invalid trust anchor
          'did:key:zdev',
          1,
          1,
          1,
        ],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      expect(
        dest.id.query('SELECT 1 FROM plugin_installs WHERE install_id = ?', ['pli_badanchor']),
      ).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  it('round-12 #10: a never-consented PENDING install does NOT travel in the archive', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // A pending install is a ceremony the owner never completed — it must not
      // be exported (and restored as a paused install prompting recovery).
      src.id.execute(
        `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
           current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
           behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'pli_pending',
          'did:plc:acme',
          'com.acme.fw',
          'pending', // never consented
          'runner',
          'bafyreicid',
          '1.0.0',
          VALID_MANIFEST_JSON,
          MANIFEST_DIGESTS.installScopeHash,
          VALID_CAP_HASHES_JSON,
          MANIFEST_DIGESTS.behaviorHash,
          MANIFEST_DIGESTS.presentationHash,
          '{"kind":"repo_proof"}',
          null,
          1,
          1,
          1,
        ],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      expect(
        dest.id.query('SELECT 1 FROM plugin_installs WHERE install_id = ?', ['pli_pending']),
      ).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  it('round-5 #8: the plugin decision log travels; overwrite clears stale target decisions', async () => {
    const installCols = `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode,
        current_cid, current_version, manifest_json, install_scope_hash, capability_hashes_json,
        behavior_hash, presentation_hash, trust_anchor_json, device_did, config_revision,
        created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const installRow = [
      'pli_2',
      'did:plc:acme',
      'com.acme.fw',
      'paused',
      'runner',
      'bafyreicid',
      '1.0.0',
      '{}',
      's',
      '{"c":"h"}',
      'b',
      'p',
      '{"kind":"repo_proof"}',
      null,
      1,
      1,
      1,
    ];
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      src.id.execute(installCols, installRow);
      src.id.execute(
        `INSERT INTO plugin_decisions (id, install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?,?)`,
        [1, 'pli_2', '', 'consent_granted', '', 100],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    try {
      // The target already holds the install plus a STALE local decision that
      // must be wiped on overwrite — otherwise it lingers against the restored
      // install_id (Round-5 #8).
      dest.id.execute(installCols, installRow);
      dest.id.execute(
        `INSERT INTO plugin_decisions (id, install_id, capability, decision, reason, created_at)
         VALUES (?,?,?,?,?,?)`,
        [99, 'pli_2', '', 'uninstalled', 'stale-local', 200],
      );
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });

      const rows = dest.id.query<{ decision: string }>(
        'SELECT decision FROM plugin_decisions ORDER BY created_at ASC',
      );
      // The archived decision travelled; the stale local one was cleared.
      expect(rows.map((r) => r.decision)).toEqual(['consent_granted']);
    } finally {
      closeBundle(dest);
    }
  });

  it('refuses to import onto a non-clean target without force', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    const dest = freshBundle([['general', 'default']]);
    try {
      seedIdentity(dest.id); // dest already has user data
      setArchiveDataSource(dataSourceFor(dest));
      await expect(importArchive(archive, PASS)).rejects.toThrow(/not a clean install/);
      // force overrides.
      await expect(importArchive(archive, PASS, { force: true })).resolves.toBeUndefined();
    } finally {
      closeBundle(dest);
    }
  });

  it('a data-bearing archive with NO data source throws (never silently succeeds)', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    setArchiveDataSource(null);
    await expect(importArchive(archive, PASS)).rejects.toThrow(/no ArchiveDataSource/);
  });

  it('wrong passphrase, corrupt bytes, and unsupported version all fail', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }
    await expect(importArchive(archive, WRONG)).rejects.toThrow();
    await expect(importArchive(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), PASS)).rejects.toThrow();
    const badVersion = archive.slice();
    badVersion[4] = 0x63; // version 99
    await expect(importArchive(badVersion, PASS)).rejects.toThrow(/unsupported version/);
  });

  // SEC — a crafted archive can carry a path-traversing persona name in its
  // (attacker-influenced) manifest. Import must reject it BEFORE the name
  // becomes a `${name}.sqlite` filename, so nothing is written outside the
  // vault dir. The AES-GCM tag + checksums don't help here (the attacker chose
  // the passphrase and computed the checksums).
  it('refuses to restore a persona whose manifest name path-traverses', async () => {
    // Export side: a real persona file on disk, but the manifest REPORTS a
    // traversal name — createArchive copies persona.name verbatim into the payload.
    const src = freshBundle([['health', 'sensitive']]);
    let archive: Uint8Array;
    try {
      const health = src.personas.get('health');
      if (!health) throw new Error('test setup: missing health persona');
      seedVaultItem(health.adapter, 'v1', 'secret note');
      setArchiveDataSource({
        identityAdapter: () => src.id,
        personaSources: async () => [
          { name: '../../evil', tier: 'sensitive', adapter: health.adapter },
        ],
        openPersonaForRestore: async () => {
          throw new Error('export path does not restore');
        },
        hasExistingUserData: async () => false,
      });
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    // Import side: the guard must reject the traversal name BEFORE any file open.
    const dest = freshBundle([]);
    const openedNames: string[] = [];
    try {
      setArchiveDataSource({
        identityAdapter: () => dest.id,
        personaSources: async () => [],
        openPersonaForRestore: async (name, tier) => {
          openedNames.push(name);
          const a = openPersona(path.join(dest.dir, `${name}.sqlite`));
          dest.personas.set(name, { tier, adapter: a });
          return a;
        },
        hasExistingUserData: async () => false,
      });
      await expect(importArchive(archive, PASS)).rejects.toThrow(/refusing to restore persona/);
      // Never reached the file-open — no traversal write happened.
      expect(openedNames).toHaveLength(0);
    } finally {
      closeBundle(dest);
    }
  });

  // SEC (P2.8) — import must DELIVER each persona's archived tier to
  // openPersonaForRestore so the app can re-register it at the right tier (a
  // restored sensitive/locked persona must not silently become open). Locks
  // the core-side enabling contract; the mobile data source consumes it.
  it('delivers each persona archived tier to openPersonaForRestore', async () => {
    const src = freshBundle([['health', 'sensitive']]);
    let archive: Uint8Array;
    try {
      const health = src.personas.get('health');
      if (!health) throw new Error('test setup: missing health persona');
      seedIdentity(src.id);
      seedVaultItem(health.adapter, 'v1', 'bp 120/80');
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    const captured: { name: string; tier: string }[] = [];
    try {
      const base = dataSourceFor(dest);
      setArchiveDataSource({
        ...base,
        openPersonaForRestore: async (name, tier) => {
          captured.push({ name, tier });
          return base.openPersonaForRestore(name, tier);
        },
      });
      await importArchive(archive, PASS);
      expect(captured).toContainEqual({ name: 'health', tier: 'sensitive' });
    } finally {
      closeBundle(dest);
    }
  });

  // SEC (P1.1) — a FORCE (overwrite) restore must be a TRUE overwrite: rows on
  // the target that aren't in the backup are removed (INSERT OR REPLACE alone
  // only overwrites matching PKs). kv_store is the exception — it holds secrets
  // excluded from the archive, so they must SURVIVE.
  it('force restore removes target-only rows but preserves excluded kv secrets', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id); // backup has reminder rem-1 + theme=dark (gemini_api_key excluded)
      const gen = src.personas.get('general');
      if (!gen) throw new Error('setup');
      seedVaultItem(gen.adapter, 'v-keep', 'from backup');
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([['general', 'default']]);
    try {
      // Target has its OWN data: a reminder NOT in the backup, a vault item NOT
      // in the backup, a secret kv key (excluded from backups), and theme=light.
      dest.id.execute(
        `INSERT INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['rem-OLD', 'rO', 'stale', 1, 'general', 'manual', '', 'user', '', '', 'pending', 0, 1],
      );
      dest.id.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?)', [
        'gemini_api_key',
        'DEST-SECRET',
        1,
      ]);
      dest.id.execute('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?,?,?)', [
        'theme',
        'light',
        1,
      ]);
      const destGen = dest.personas.get('general');
      if (!destGen) throw new Error('setup');
      seedVaultItem(destGen.adapter, 'v-OLD', 'stale vault');

      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });

      // Backup rows present; target-only rows GONE (true overwrite).
      expect(dest.id.query('SELECT 1 FROM reminders WHERE id = ?', ['rem-1'])).toHaveLength(1);
      expect(dest.id.query('SELECT 1 FROM reminders WHERE id = ?', ['rem-OLD'])).toHaveLength(0);
      expect(
        destGen.adapter.query('SELECT 1 FROM vault_items WHERE id = ?', ['v-keep']),
      ).toHaveLength(1);
      expect(
        destGen.adapter.query('SELECT 1 FROM vault_items WHERE id = ?', ['v-OLD']),
      ).toHaveLength(0);
      // Backup pref overwrote the target's; the target's SECRET (never in the
      // backup) SURVIVES — kv_store is not cleared.
      expect(dest.id.query("SELECT value FROM kv_store WHERE key = 'theme'")[0]?.value).toBe(
        'dark',
      );
      expect(
        dest.id.query("SELECT value FROM kv_store WHERE key = 'gemini_api_key'")[0]?.value,
      ).toBe('DEST-SECRET');
    } finally {
      closeBundle(dest);
    }
  });
});

describe('export excludes guided-demo scope', () => {
  it('backs up only data_scope=user rows (demo rows are never exported)', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      // A user reminder (default scope) AND a guided-demo reminder.
      src.id.execute(
        `INSERT INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at, data_scope)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'rem-user',
          'ru',
          'real reminder',
          1,
          'general',
          'manual',
          '',
          '',
          '',
          '',
          'pending',
          0,
          1,
          'user',
        ],
      );
      src.id.execute(
        `INSERT INTO reminders (id, short_id, message, due_at, persona, kind, source_item_id, source, recurring, timezone, status, completed, created_at, data_scope)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'rem-demo',
          'rd',
          'demo reminder',
          1,
          'general',
          'manual',
          '',
          '',
          '',
          '',
          'pending',
          0,
          1,
          'guided_demo:x',
        ],
      );
      // A user vault item AND a demo vault item.
      const gen = src.personas.get('general')!.adapter;
      gen.execute(
        'INSERT INTO vault_items (id, content_l0, timestamp, created_at, updated_at, data_scope) VALUES (?,?,?,?,?,?)',
        ['v-user', 'real note', 1, 1, 1, 'user'],
      );
      gen.execute(
        'INSERT INTO vault_items (id, content_l0, timestamp, created_at, updated_at, data_scope) VALUES (?,?,?,?,?,?)',
        ['v-demo', 'demo note', 1, 1, 1, 'guided_demo:x'],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS);

      // Only the user rows came back; the demo rows were never in the archive.
      expect(dest.id.query('SELECT id FROM reminders ORDER BY id').map((r) => r.id)).toEqual([
        'rem-user',
      ]);
      const gen = dest.personas.get('general')!.adapter;
      expect(gen.query('SELECT id FROM vault_items ORDER BY id').map((r) => r.id)).toEqual([
        'v-user',
      ]);
    } finally {
      closeBundle(dest);
    }
  });

  it('excludes the active-demo KV record (no orphan recovery after restore)', async () => {
    const src = freshBundle([['general', 'default']]);
    let archive: Uint8Array;
    try {
      // A backup taken DURING a demo: the active-demo + entry-seen records live
      // in kv_store. A portable pref (theme) is the control that DOES export.
      src.id.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?)', [
        'theme',
        'dark',
        1,
      ]);
      src.id.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?)', [
        'guided_demo.active',
        JSON.stringify({ activeDemoScope: 'guided_demo:x', startedAt: 1, step: '' }),
        1,
      ]);
      src.id.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?)', [
        'guided_demo.entry_seen',
        '1',
        1,
      ]);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS);

      // The portable pref restored…
      expect(dest.id.query("SELECT value FROM kv_store WHERE key = 'theme'")[0]?.value).toBe(
        'dark',
      );
      // …but the ephemeral guided-demo records did NOT — restoring them would
      // resurrect a recovery record with no demo data (orphan-scope boot).
      expect(dest.id.query("SELECT 1 FROM kv_store WHERE key LIKE 'guided_demo.%'")).toHaveLength(
        0,
      );
    } finally {
      closeBundle(dest);
    }
  });
});

/**
 * §16.2 / WS-4.2 — the archive arms the commerce restore fence.
 *
 * The commerce operational tables travel in the archive on purpose, USE
 * COUNTERS included. Restored faithfully, spent capacity comes back
 * indistinguishable from capacity this node spent itself. The only moment
 * anyone knows a restore happened is inside the import, so the obligation to
 * void that capacity is written down there — in the same transaction, so a
 * crash cannot separate the counters from the fence they owe.
 */
describe('commerce restore fence marker (§16.2)', () => {
  it('an import arms the fence', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      expect(isCommerceRestorePending(dest.id)).toBe(false);

      await importArchive(archive, PASS);

      // Set unconditionally: no attempt to detect whether THIS archive
      // carried commerce rows. An empty commerce set costs one wasted epoch
      // increment; a missed one lets capacity be spent twice.
      expect(isCommerceRestorePending(dest.id)).toBe(true);
    } finally {
      closeBundle(dest);
      setArchiveDataSource(null);
    }
  });

  /**
   * WS-4.2 preflight, driven through the REAL import rather than against the
   * pure checker. The checker's own suite proves what it refuses; this proves
   * the refusal is reachable from an archive that a node actually produced,
   * and that the refusal happens before the target is touched.
   */
  it('refuses an archive whose order references a quote it does not carry', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      // A real order reference against a quote head that is not there. The
      // schema has no foreign key, so this is exactly what a torn archive
      // looks like from the inside — nothing at write time objects.
      src.id.execute(
        `INSERT INTO commerce_order_refs
           (buyer_did, purchase_order_id, idempotency_key, order_digest, quote_id,
            quote_digest, pinned_version, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          'did:plc:buyer',
          'po-orphan',
          'idem-1',
          'a'.repeat(64),
          'q-missing',
          'b'.repeat(64),
          '1.0',
          1,
        ],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    // Round-13 #24's invariant, extended: `verifyArchive` answers "could I
    // restore this?" before an operator commits. A `true` the import then
    // refuses is worse than no check, because it is the answer they acted on.
    await expect(verifyArchive(archive, PASS)).resolves.toBe(false);

    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await expect(importArchive(archive, PASS)).rejects.toThrow(/dangling_quote_reference/);

      // Nothing was written, and — the part that matters — the fence was NOT
      // armed. Arming it on a refused import would burn an epoch for a restore
      // that never happened, voiding live quotes for nothing.
      const rows = dest.id.query<{ n: number }>('SELECT COUNT(*) AS n FROM reminders');
      expect(rows[0]?.n).toBe(0);
      expect(isCommerceRestorePending(dest.id)).toBe(false);
    } finally {
      closeBundle(dest);
      setArchiveDataSource(null);
    }
  });

  /**
   * The test that would have caught a real bug, and now does.
   *
   * The preflight originally read `counterparty_did` on the watermark table —
   * the word the SPEC uses for the concept — while the column is
   * `supplier_did`. Every real archive carrying a watermark would have been
   * refused. Neither the preflight's own suite nor the wiring test above
   * caught it: the unit fixtures were hand-built and agreed with the module on
   * the wrong name, and nothing here seeded a watermark row.
   *
   * So this drives a FULL commerce set through a genuine export and import.
   * A column name can only drift from the schema if this test is deleted.
   */
  it('round-trips a full, coherent commerce set through export and import', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      src.id.execute(
        `INSERT INTO commerce_quote_heads
           (quote_id, buyer_did, head_digest, head_revision, max_uses, valid_until, supplier_epoch, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['q-1', 'did:plc:buyer', QUOTE_RECEIPT.digest, '0', '3', 9_999_999, '1', 1, 1],
      );
      src.id.execute(
        `INSERT INTO commerce_order_refs
           (buyer_did, purchase_order_id, idempotency_key, order_digest, quote_id,
            quote_digest, pinned_version, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          'did:plc:buyer',
          'po-1',
          'idem-1',
          ORDER_RECEIPT.digest,
          'q-1',
          QUOTE_RECEIPT.digest,
          '1.0',
          1,
        ],
      );
      src.id.execute(
        `INSERT INTO commerce_quote_uses (quote_id, purchase_order_id, created_at) VALUES (?,?,?)`,
        ['q-1', 'po-1', 1],
      );
      src.id.execute(
        `INSERT INTO commerce_receipts (record_digest, domain, buyer_did, quote_id, purchase_order_id, record_json, evidence_json, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          STATUS_RECEIPT.digest,
          'status',
          'did:plc:buyer',
          'q-1',
          'po-1',
          STATUS_RECEIPT.recordJson,
          '{}',
          1,
        ],
      );
      for (const receipt of [
        { domain: 'order', ...ORDER_RECEIPT },
        { domain: 'quote', ...QUOTE_RECEIPT },
      ]) {
        src.id.execute(
          `INSERT INTO commerce_receipts (record_digest, domain, buyer_did, quote_id, purchase_order_id, record_json, evidence_json, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            receipt.digest,
            receipt.domain,
            'did:plc:buyer',
            'q-1',
            'po-1',
            receipt.recordJson,
            '{}',
            1,
          ],
        );
      }
      src.id.execute(
        `INSERT INTO commerce_status_heads (buyer_did, purchase_order_id, head_digest, head_sequence, state, supplier_epoch, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        ['did:plc:buyer', 'po-1', STATUS_RECEIPT.digest, '0', 'accepted', '1', 1],
      );
      // The row whose column name the preflight got wrong.
      src.id.execute(
        `INSERT INTO commerce_epoch_watermarks (supplier_did, epoch, updated_at) VALUES (?,?,?)`,
        ['did:plc:supplier', '4', 1],
      );
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    // Coherent, so it must both verify and import.
    await expect(verifyArchive(archive, PASS)).resolves.toBe(true);

    const dest = freshBundle([]);
    try {
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS);
      const rows = dest.id.query<{ epoch: string }>(
        'SELECT epoch FROM commerce_epoch_watermarks WHERE supplier_did = ?',
        ['did:plc:supplier'],
      );
      expect(rows[0]?.epoch).toBe('4');
      expect(isCommerceRestorePending(dest.id)).toBe(true);
    } finally {
      closeBundle(dest);
      setArchiveDataSource(null);
    }
  });

  it('the marker does NOT travel in an archive', async () => {
    // It describes THIS node's pending obligation, not the backup's content.
    // Exported, a backup taken while a fence was owed would demand a second
    // fence on a different node for an event that already happened here.
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      seedIdentity(src.id);
      markCommerceRestorePending(src.id, Date.now());
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const manifest = await readManifest(archive, PASS);
    const kv = manifest.identity.tables.kv_store ?? [];
    expect(kv.map((r) => r.key)).not.toContain(COMMERCE_RESTORE_PENDING_KEY);
  });
});

describe('force-restore honours what the archive actually says (§16.2)', () => {
  /**
   * `force` means "make the target look like the backup", and the two cases
   * below are the difference between a backup that SPEAKS about a table and
   * one that cannot.
   *
   * An empty list is a statement — "this table had no rows" — and force
   * honours it by clearing. That half is what this test drives, because it is
   * the half this build can produce: `dumpTable` returns `[]` for a table it
   * cannot read, and the exporter writes a key for every allowlisted table,
   * so a CURRENT archive always carries all of them.
   *
   * The other half — a key that is ABSENT, meaning the archive predates that
   * table entirely — now skips the clear, and THIS TEST DOES NOT PROVE IT.
   * Reverting the guard to the old always-clear behaviour leaves this test
   * green, which I checked rather than assumed. No archive this build can
   * write omits a key (`dumpTable` returns `[]` for a table it cannot read,
   * and the exporter writes a key for every allowlisted table), so the only
   * producer of that shape is an older build and there is nothing here to
   * construct one from.
   *
   * What this test is, then: a regression guard on the half I changed. The
   * guard itself exists because the commerce set is exactly that shape — a
   * backup taken before commerce existed carries none of its tables, and
   * clearing on that basis wiped every order reference, quote head, use
   * counter and status head on a live trading node.
   */
  it('clears a commerce table the archive carries as empty', async () => {
    const src = freshBundle([]);
    let archive: Uint8Array;
    try {
      // The source needs SOME data, or `payloadHasData` short-circuits the
      // import and nothing is cleared — which is correct for an empty archive
      // and would have made this test pass for the wrong reason. What matters
      // is that its commerce tables are empty while the payload is not.
      src.id.execute('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)', [
        'theme',
        'dark',
        1,
      ]);
      setArchiveDataSource(dataSourceFor(src));
      archive = await createArchive(PASS);
    } finally {
      closeBundle(src);
    }

    const dest = freshBundle([]);
    try {
      dest.id.execute(
        `INSERT INTO commerce_order_refs
           (buyer_did, purchase_order_id, idempotency_key, order_digest, quote_id, quote_digest,
            pinned_version, state, serving_manifest_cid, serving_install_id, admitted_epoch,
            reconciliation_required, decision_deadline_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          'did:plc:buyer',
          'po-stale',
          'idem-stale',
          'c'.repeat(64),
          'q-stale',
          'd'.repeat(64),
          '1.0',
          'reserved',
          '',
          '',
          '1',
          0,
          9_999_999_999_999,
          1,
        ],
      );
      expect(dest.id.query('SELECT purchase_order_id FROM commerce_order_refs', [])).toHaveLength(
        1,
      );
      setArchiveDataSource(dataSourceFor(dest));
      await importArchive(archive, PASS, { force: true });
      // The backup said "no orders", so the stale row goes.
      expect(dest.id.query('SELECT purchase_order_id FROM commerce_order_refs', [])).toEqual([]);
    } finally {
      closeBundle(dest);
    }
  });
});
