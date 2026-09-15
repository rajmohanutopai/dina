/**
 * §5.D — the country packs (D1 India, D2 USA, D5 notification rails) as
 * first-party runner plugins. What a manifest shipped with the build must
 * prove: it passes the ingest-identical validator; it installs through the
 * owner's first-party door and the SAME pairing + consent ceremony as any
 * runner plugin; and a country pack, though first-party, does NOT open the
 * money line — only the commerce packs do. The gates every shipped manifest
 * meets at the THIRD-PARTY door (reserved namespace refused, a stranger's
 * renamed copy installs, content address) run in `reference_pack_install`,
 * whose table lists these packs too.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizePluginManifest, validatePluginManifest, type PluginManifest } from '@dina/protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { resetCallerTypeState } from '../../src/auth/caller_type';
import {
  COUNTRY_PACK_IDS,
  COUNTRY_PACK_MANIFESTS,
  COUNTRY_PACKS,
  INDIA_PACK_MANIFEST,
  USA_PACK_MANIFEST,
  isCountryPack,
  type CountryPack,
} from '../../src/commerce/country_packs';
import {
  beginFirstPartyInstall,
  FIRST_PARTY_MANIFESTS,
  isFirstPartyManifestId,
  type FirstPartyPluginId,
} from '../../src/commerce/reference_install';
import { createCommerceRuntime } from '../../src/commerce/runtime';
import { getPublicKey } from '../../src/crypto/ed25519';
import { getDeviceByDID, resetDeviceRegistry } from '../../src/devices/registry';
import { publicKeyToMultibase } from '../../src/identity/did';
import { clearPairingState, completePairing, setNodeDID } from '../../src/pairing/ceremony';
import { confirmConsent, setPluginDeviceVerifier } from '../../src/plugins/install_service';
import { SQLitePluginInstallRepository, setPluginInstallRepository } from '../../src/plugins/registry';
import { issueRunnerPairingCode } from '../../src/plugins/runner_pairing';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { SUPPLIER_DID } from './helpers';

const T0 = 1_800_000_000_000;
const RUNNER_KEY = publicKeyToMultibase(getPublicKey(new Uint8Array(32).fill(9)));

let dir: string;
let adapter: NodeSQLiteAdapter;
let installs: SQLitePluginInstallRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'country-packs-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  installs = new SQLitePluginInstallRepository(adapter);
  setPluginInstallRepository(installs);
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });
  setNodeDID(SUPPLIER_DID);
});

afterEach(() => {
  setPluginInstallRepository(null);
  setPluginDeviceVerifier(null);
  clearPairingState();
  resetDeviceRegistry();
  resetCallerTypeState();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The notice rails share one result shape (`delivered`); used to tell a notice from a filing. */
const NOTIFY_RESULT_SHAPE = INDIA_PACK_MANIFEST.capabilities.find((c) => c.id.endsWith('-reminder'))?.result_schema;

const PACKS: [CountryPack, PluginManifest][] = [
  ['in', INDIA_PACK_MANIFEST],
  ['us', USA_PACK_MANIFEST],
];

describe('the country pack manifests (§5.D)', () => {
  it.each(PACKS)('%s: passes the ingest-identical validator', (_name, manifest) => {
    const verdict = validatePluginManifest(manifest);
    expect(verdict.ok).toBe(true);
  });

  it.each(PACKS)('%s: declares only rails a plugin may hold — status READS, filings/notices as WRITES, never payment', (_name, manifest) => {
    for (const cap of manifest.capabilities) {
      expect(['read', 'write']).toContain(cap.action_class);
      expect(cap.action_class).not.toBe('payment');
      expect(cap.kinds).toBeDefined();
      // Every effectful capability declares idempotency so a retry is safe.
      expect(cap.effects?.idempotency).toBe('supported');
      // Every rail names what may ride its params (§11.5) — without a data
      // scope no invocation could ever clear egress, so even a granted read
      // would card forever.
      expect(cap.data_scope?.categories.length ?? 0).toBeGreaterThan(0);
    }
    // Payment-status lookups are regulated data; a rail must never be 'public'.
    const status = manifest.capabilities.find((c) => c.id.endsWith('-status'));
    expect(status?.privacy_class).toBe('regulated');
    expect(status?.action_class).toBe('read');
    // The notification rail (D5) is an effectful tool Dina invokes — an outward
    // message meets the approval gate; the substrate's `notify` kind is unshipped.
    const notice = manifest.capabilities.filter((c) => c.id.endsWith('-reminder') || c.id.endsWith('.notice'));
    expect(notice).toHaveLength(1);
    expect(notice[0]?.action_class).toBe('write');
    expect(notice[0]?.kinds).toEqual(['tool']);
  });

  it.each(PACKS)('%s: every WRITE rail is bound to a retained khata document, and a notice can carry no free text', (_pack, manifest) => {
    const writes = manifest.capabilities.filter((c) => c.action_class === 'write');
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const cap of writes) {
      const schema = cap.params_schema as { required?: string[]; properties?: Record<string, { type?: string; enum?: unknown[] }> };
      const required = schema.required ?? [];
      const props = schema.properties ?? {};
      if (cap.result_schema === NOTIFY_RESULT_SHAPE || cap.id.endsWith('-reminder') || cap.id.endsWith('.notice')) {
        // A notice names the khata document it is about and a template Dina
        // chose — never a message body the runner composed.
        expect(required).toEqual(expect.arrayContaining(['to', 'template', 'subject_digest']));
        expect(props.template?.enum?.length ?? 0).toBeGreaterThan(0);
        const freeText = Object.entries(props)
          .filter(([name, p]) => p.type === 'string' && p.enum === undefined && !['to', 'subject_digest', 'due_at'].includes(name))
          .map(([name]) => name);
        expect(freeText).toEqual([]);
      } else {
        // A filing (e-way bill, invoice) is bound to the delivery note it describes.
        expect(required).toContain('delivery_note_digest');
      }
    }
  });

  it.each(PACKS)('%s: every manifest passes the shared validator, card templates included (§15.6)', (_pack, manifest) => {
    // The first-party door mints these from source rather than fetching them,
    // so nothing else proves they would survive the validator a third-party
    // manifest meets. A card slot naming a field the result schema does not
    // declare is exactly the typo that would otherwise ship a card rendering
    // permanently short.
    const result = validatePluginManifest(normalizePluginManifest(manifest));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it('ids live in the reserved first-party namespace and the map is complete', () => {
    expect(INDIA_PACK_MANIFEST.plugin_id).toBe(COUNTRY_PACK_IDS.in);
    expect(USA_PACK_MANIFEST.plugin_id).toBe(COUNTRY_PACK_IDS.us);
    expect(Object.keys(COUNTRY_PACK_MANIFESTS).sort()).toEqual(['in', 'us']);
    expect([...COUNTRY_PACKS].sort()).toEqual(Object.keys(COUNTRY_PACK_IDS).sort());
    expect(isCountryPack('in')).toBe(true);
    expect(isCountryPack('uk')).toBe(false);
    expect(isCountryPack('toString')).toBe(false);
    for (const manifest of Object.values(COUNTRY_PACK_MANIFESTS)) {
      expect(manifest.plugin_id.startsWith('com.dinakernel.')).toBe(true);
    }
  });

  it.each(PACKS)('%s: installs through the first-party door and the runner pairing ceremony', (pack, manifest) => {
    const begun = beginFirstPartyInstall({ pluginId: COUNTRY_PACK_IDS[pack], publisherDid: SUPPLIER_DID, nowMs: T0 });
    expect(begun.ok).toBe(true);
    if (!begun.ok) throw new Error(JSON.stringify(begun));
    // The consent card lists every rail the pack asks for, computed locally.
    expect(begun.consent.capabilities.map((c) => c.display_name).sort()).toEqual(
      manifest.capabilities.map((c) => c.display_name).sort(),
    );
    const install = installs.getById(begun.installId);
    expect(install?.status).toBe('pending');
    expect(install?.trustAnchor.kind).toBe('local_publisher_key');

    // The operator's runner pairs with its own key on the install's code (§15.3).
    if (install === null) throw new Error('unreachable');
    const { code } = issueRunnerPairingCode(install);
    completePairing(code, 'rails-runner', RUNNER_KEY, 'plugin', 'runner');
    const runnerDid = `did:key:${RUNNER_KEY}`;
    expect(installs.getById(begun.installId)?.deviceDid).toBe(runnerDid);
    expect(confirmConsent(begun.installId, runnerDid, T0 + 1)).toBe(true);
    expect(installs.getById(begun.installId)?.status).toBe('active');
  });

  it('an active country pack does NOT open the money line — only the commerce packs do', () => {
    const begun = beginFirstPartyInstall({ pluginId: COUNTRY_PACK_IDS.in, publisherDid: SUPPLIER_DID, nowMs: T0 });
    if (!begun.ok) throw new Error(JSON.stringify(begun));
    installs.bindPendingDevice(begun.installId, 'did:key:zrails', T0);
    installs.activate(begun.installId, 'did:key:zrails', T0);
    const runtime = createCommerceRuntime({
      adapter,
      supplierDid: () => SUPPLIER_DID,
      currentEpoch: () => '1',
      now: () => T0,
    });
    expect(runtime.money()).toMatchObject({ available: false, reason: 'pack_not_installed' });
  });

  it('the first-party door takes a shipped id, never a manifest — an id outside the table is refused, not staged', () => {
    // Only reachable by casting: the type is the closed set of shipped ids. The
    // runtime check is what keeps a JS caller from installing arbitrary bytes
    // under the kernel's vouching key (the Round-5 #1 side door).
    expect(isFirstPartyManifestId('com.acme.widget')).toBe(false);
    expect(isFirstPartyManifestId(COUNTRY_PACK_IDS.us)).toBe(true);
    expect(Object.keys(FIRST_PARTY_MANIFESTS).sort()).toEqual([
      'com.dinakernel.commerce.buyer',
      'com.dinakernel.commerce.supplier',
      'com.dinakernel.country.in',
      'com.dinakernel.country.us',
    ]);
    const begun = beginFirstPartyInstall({
      pluginId: 'com.acme.widget' as FirstPartyPluginId,
      publisherDid: SUPPLIER_DID,
      nowMs: T0,
    });
    expect(begun).toMatchObject({ ok: false, code: 'authenticity_failed', transient: false });
    expect(installs.list()).toEqual([]);
  });
});
