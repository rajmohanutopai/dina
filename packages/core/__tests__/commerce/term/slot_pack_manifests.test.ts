/**
 * SHELF_SPACE_NEGOTIATION §4 — the Slot Pack's two halves: they pass the
 * validator a third-party manifest meets, they carry no money anywhere, and
 * the Core-owned first-party table names them with one shared pack id.
 */

import { TERM_NAMES } from '@dina/commerce-protocol';
import { normalizePluginManifest, validatePluginManifest } from '@dina/protocol';

import {
  FIRST_PARTY_PACKS,
  firstPartyPack,
  termPackEntry,
} from '../../../src/commerce/first_party_packs';
import { FIRST_PARTY_MANIFESTS } from '../../../src/commerce/reference_install';
import {
  SLOT_BUYER_MANIFEST,
  SLOT_PACK_CATEGORIES,
  SLOT_PACK_ID,
  SLOT_PACK_SCHEMA_MAJOR,
  SLOT_PACK_VOCABULARY,
  SLOT_SELLER_MANIFEST,
} from '../../../src/commerce/slot_pack_manifests';
import { NODE_SUPPORTED_FEATURES } from '../../../src/plugins/install_service';
import { validateAgainstSchema } from '../../../src/plugins/schema_validate';

describe('the Slot Pack manifests', () => {
  it.each([
    ['seller', SLOT_SELLER_MANIFEST],
    ['buyer', SLOT_BUYER_MANIFEST],
  ])('%s: passes the shared manifest validator', (_half, manifest) => {
    const result = validatePluginManifest(normalizePluginManifest(manifest));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });

  it.each([
    ['seller', SLOT_SELLER_MANIFEST],
    ['buyer', SLOT_BUYER_MANIFEST],
  ])(
    '%s: needs only features this node ships — else the install gate refuses it',
    (_half, manifest) => {
      const result = validatePluginManifest(normalizePluginManifest(manifest));
      if (!result.ok) throw new Error('manifest invalid');
      // A `config_schema` would derive `config`, which this node does not ship
      // (P2-9): the pack's runner parameters are pinned in FIRST_PARTY_PACKS.
      expect(result.derivedFeatures.filter((f) => !NODE_SUPPORTED_FEATURES.has(f))).toEqual([]);
    },
  );

  it('the seller half answers strangers (provider); the buyer half is the owner’s tools only', () => {
    for (const cap of SLOT_SELLER_MANIFEST.capabilities) expect(cap.kinds).toEqual(['provider']);
    for (const cap of SLOT_BUYER_MANIFEST.capabilities) expect(cap.kinds).toEqual(['tool']);
  });

  it('carries no money field anywhere: no price, floor, fee or asking-term key in either manifest', () => {
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.push(key);
          walk(inner);
        }
      }
    };
    walk([SLOT_SELLER_MANIFEST, SLOT_BUYER_MANIFEST]);
    // A term NAME (the counter schema's `targets.fee`) names a term and carries no value.
    const termNames: readonly string[] = TERM_NAMES;
    expect(
      keys.filter(
        (key) =>
          !termNames.includes(key) &&
          /price|floor|fee|minor_units|asking|rent|money|currency/i.test(key),
      ),
    ).toEqual([]);
  });

  it('ships through the first-party door and the table names both halves under one pack id', () => {
    expect(
      FIRST_PARTY_MANIFESTS[SLOT_SELLER_MANIFEST.plugin_id as keyof typeof FIRST_PARTY_MANIFESTS],
    ).toBe(SLOT_SELLER_MANIFEST);
    expect(firstPartyPack(SLOT_SELLER_MANIFEST.plugin_id)?.role).toBe('term_seller');
    expect(firstPartyPack(SLOT_BUYER_MANIFEST.plugin_id)?.role).toBe('term_buyer');
    const ref = { plugin_id: SLOT_PACK_ID, schema_major: SLOT_PACK_SCHEMA_MAJOR };
    expect(termPackEntry(ref, 'term_seller')?.pluginId).toBe(SLOT_SELLER_MANIFEST.plugin_id);
    expect(termPackEntry(ref, 'term_buyer')?.pluginId).toBe(SLOT_BUYER_MANIFEST.plugin_id);
    expect(termPackEntry({ ...ref, schema_major: 2 }, 'term_seller')).toBeNull();
    expect(termPackEntry({ ...ref, plugin_id: 'com.acme.slot' }, 'term_seller')).toBeNull();
  });

  it('the table: only the Commerce Pack opens the money stores; every pack binds a runner device; country packs are not in it', () => {
    expect(
      FIRST_PARTY_PACKS.map((p) => [p.pluginId, p.opensMoneyStores, p.bindsRunnerDevice]).sort(),
    ).toEqual([
      ['com.dinakernel.commerce.buyer', true, true],
      ['com.dinakernel.commerce.supplier', true, true],
      // The term engine keeps its own tables: a Slot-only node must not open
      // the khata's money routes.
      ['com.dinakernel.slot.buyer', false, true],
      ['com.dinakernel.slot.seller', false, true],
    ]);
  });

  it('the vocabulary is the schema’s own: a known category passes, an unknown one fails', () => {
    expect(SLOT_PACK_VOCABULARY.tags).toEqual([...SLOT_PACK_CATEGORIES]);
    const schema = SLOT_PACK_VOCABULARY.requestParamsSchema;
    expect(
      validateAgainstSchema({ tag: 'beverages.juice', attributes: { skus: 4 } }, schema).ok,
    ).toBe(true);
    expect(validateAgainstSchema({ tag: 'weapons', attributes: {} }, schema).ok).toBe(false);
    expect(validateAgainstSchema({ tag: 'snacks', attributes: { price: '1' } }, schema).ok).toBe(
      false,
    );
  });
});
