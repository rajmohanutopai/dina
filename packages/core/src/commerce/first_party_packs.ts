/**
 * The ONE Core-owned table of first-party packs (SHELF_SPACE_NEGOTIATION §4)
 * — what each pack this build ships may do. It replaces the hard-coded pair
 * of Commerce Pack ids that the runner binding and the money-store gate each
 * spelled out, so adding a pack is one row here rather than a second list
 * somewhere that can disagree.
 *
 * AUTHENTICITY IS NOT THIS TABLE'S JOB. A row says what a pack may do; who
 * may claim to BE that pack is decided by the install's trust anchor
 * (`local_publisher_key`, minted only by `beginFirstPartyInstall`). Every
 * caller checks both.
 */

import { BUYER_REFERENCE_MANIFEST, SUPPLIER_REFERENCE_MANIFEST } from './reference_manifests';
import {
  SLOT_BUYER_MANIFEST,
  SLOT_PACK_ID,
  SLOT_PACK_SCHEMA_MAJOR,
  SLOT_PACK_VOCABULARY,
  SLOT_SELLER_MANIFEST,
  type TermPackVocabulary,
} from './slot_pack_manifests';
import { DEFAULT_TERM_RUNNER_PARAMS, type TermRunnerParams } from './term/term_runner';

export type FirstPartyPackRole =
  | 'commerce_supplier'
  | 'commerce_buyer'
  | 'term_seller'
  | 'term_buyer';

export interface FirstPartyPackEntry {
  pluginId: string;
  role: FirstPartyPackRole;
  /**
   * An active install opens the Commerce Pack's money stores (§5.B1 money
   * line). The term packs do not: the term engine keeps its own tables, and a
   * node with only the Slot Pack must not open the khata's money routes.
   */
  opensMoneyStores: boolean;
  /** Core may mint this install's runner device (`bindReferenceRunner`). */
  bindsRunnerDevice: boolean;
  /**
   * Term packs only. `packId` is the id term documents name the pack by —
   * shared by its seller and buyer halves, which are two installs with two
   * plugin ids — with the schema major nodes interoperate on (§4 "Identity
   * across nodes"), and the vocabulary Core checks requests and listings
   * against.
   */
  term?: {
    packId: string;
    schemaMajor: number;
    vocabulary: TermPackVocabulary;
    /**
     * The seller runner's parameters, pinned by the build like the manifest
     * bytes. Not a `config_schema`: this node ships no config-value store
     * (`NODE_SUPPORTED_FEATURES`, P2-9), so a manifest declaring one would
     * not install. Move them there when that store lands.
     */
    runner?: TermRunnerParams;
  };
}

export const FIRST_PARTY_PACKS: readonly FirstPartyPackEntry[] = [
  {
    pluginId: SUPPLIER_REFERENCE_MANIFEST.plugin_id,
    role: 'commerce_supplier',
    opensMoneyStores: true,
    bindsRunnerDevice: true,
  },
  {
    pluginId: BUYER_REFERENCE_MANIFEST.plugin_id,
    role: 'commerce_buyer',
    opensMoneyStores: true,
    bindsRunnerDevice: true,
  },
  {
    pluginId: SLOT_SELLER_MANIFEST.plugin_id,
    role: 'term_seller',
    opensMoneyStores: false,
    bindsRunnerDevice: true,
    term: {
      packId: SLOT_PACK_ID,
      schemaMajor: SLOT_PACK_SCHEMA_MAJOR,
      vocabulary: SLOT_PACK_VOCABULARY,
      runner: DEFAULT_TERM_RUNNER_PARAMS,
    },
  },
  {
    pluginId: SLOT_BUYER_MANIFEST.plugin_id,
    role: 'term_buyer',
    opensMoneyStores: false,
    bindsRunnerDevice: true,
    term: {
      packId: SLOT_PACK_ID,
      schemaMajor: SLOT_PACK_SCHEMA_MAJOR,
      vocabulary: SLOT_PACK_VOCABULARY,
    },
  },
];

export function firstPartyPack(pluginId: string): FirstPartyPackEntry | null {
  return FIRST_PARTY_PACKS.find((entry) => entry.pluginId === pluginId) ?? null;
}

/** The installed half of the term pack a document's `{plugin_id, schema_major}` names, if this build ships it. */
export function termPackEntry(
  ref: { plugin_id: string; schema_major: number },
  role: 'term_seller' | 'term_buyer',
): FirstPartyPackEntry | null {
  return (
    FIRST_PARTY_PACKS.find(
      (entry) =>
        entry.role === role &&
        entry.term?.packId === ref.plugin_id &&
        entry.term.schemaMajor === ref.schema_major,
    ) ?? null
  );
}

/**
 * A capability Core itself serves, so it is never dispatched to a plugin lane.
 * The term packs' runners are Core's own term engine, reached only through the
 * owner's term routes; their manifest capabilities describe what the owner
 * consented to, not a lane anything claims. A tool invocation of one — Brain's
 * `invoke_plugin`, or the owner's `/v1/plugins/invoke` — would queue a task no
 * runner ever takes. AUTHENTICITY: only a `local_publisher_key` install is the
 * build's pack; anything else claiming the id is an ordinary plugin.
 */
export function servedByCore(install: {
  pluginId: string;
  trustAnchor: { kind: string };
}): boolean {
  return (
    install.trustAnchor.kind === 'local_publisher_key' &&
    firstPartyPack(install.pluginId)?.term !== undefined
  );
}
