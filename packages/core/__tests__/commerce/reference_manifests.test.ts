/**
 * WS-3.9 — the two reference Commerce Pack manifests (§8.1, §8.2).
 *
 * The claim being tested is narrow and load-bearing: these are not
 * illustrative JSON, they are manifests a node WILL ACCEPT. A pair that only
 * looked plausible would fail at the first real install, and the §25.6
 * journey starts with an install.
 *
 * So the assertions run the REAL validator rather than checking fields by
 * hand. Writing these caught two mistakes on the first pass — `action_class:
 * 'commit'` and `privacy_class: 'business'` are both words I invented; the §5
 * vocabularies are `read|quote|write|booking|payment|agentic` and
 * `public|personal|sensitive|regulated`. Neither would have been visible
 * without asking the validator.
 */

import {
  validatePluginManifest,
  type PluginCapabilityDecl,
  type PluginManifest,
} from '@dina/protocol';

import { readSupplierDecision } from '../../src/commerce/order_decision';
import {
  BUYER_REFERENCE_MANIFEST,
  SUPPLIER_REFERENCE_MANIFEST,
} from '../../src/commerce/reference_manifests';

/**
 * §5 requires a reverse-DNS capability id and its regex allows hyphens but
 * NOT underscores, so `com.dinakernel.commerce.submit_order` is rejected. The
 * snake_case names elsewhere in this pack are WIRE capability names — a
 * different namespace that the service listing binds to these. Keeping the
 * two visibly distinct is the point of this helper.
 */
const nsid = (short: string): string => `com.dinakernel.commerce.${short.replace(/_/g, '-')}`;

/** Derived features of a manifest that must validate. Throws if it does not. */
function features(manifest: PluginManifest): string[] {
  const verdict = validatePluginManifest(manifest);
  if (!verdict.ok) throw new Error(`manifest is invalid: ${JSON.stringify(verdict)}`);
  return [...verdict.derivedFeatures].sort();
}

const MANIFESTS = [
  ['supplier', SUPPLIER_REFERENCE_MANIFEST],
  ['buyer', BUYER_REFERENCE_MANIFEST],
] as const;

describe('reference commerce manifests (§8.1, §8.2)', () => {
  it.each(MANIFESTS)('the %s manifest passes the real validator', (_label, manifest) => {
    expect(validatePluginManifest(manifest).ok).toBe(true);
  });

  /**
   * `derivedFeatures` is not decoration: the installer unions it with the
   * manifest's own declarations and refuses anything this node does not ship
   * (§14). Asserting it pins the two facts that decide whether these packs are
   * installable at all — the supplier needs `kind.provider`, which WS-3.1
   * added to `NODE_SUPPORTED_FEATURES`, and the buyer needs `kind.tool`.
   */
  it('derives exactly the feature set each pack needs', () => {
    // The result is a discriminated union, so `derivedFeatures` is only
    // reachable after proving `ok` — which is right: a failed validation has
    // no features to report, and reading them anyway would be reading a field
    // that was never computed.
    expect(features(SUPPLIER_REFERENCE_MANIFEST)).toEqual(['idempotent_retry', 'kind.provider']);
    expect(features(BUYER_REFERENCE_MANIFEST)).toEqual(['idempotent_retry', 'kind.tool']);
  });

  it('declares the four §9.9–§9.11 supplier capabilities as provider kinds', () => {
    const caps = SUPPLIER_REFERENCE_MANIFEST.capabilities;
    expect(caps.map((c) => c.id).sort()).toEqual([
      'com.dinakernel.commerce.cancel-order',
      'com.dinakernel.commerce.order-status',
      'com.dinakernel.commerce.request-quote',
      'com.dinakernel.commerce.submit-order',
    ]);
    // A supplier answers PEERS. A `tool` here would be a capability the owner
    // drives and a stranger cannot reach — the opposite of a supplier — and
    // the claim guard would refuse every inbound task against it.
    for (const cap of caps) {
      expect(cap.kinds).toEqual(['provider']);
    }
  });

  it('declares every buyer capability as a tool, never a provider', () => {
    // A buyer pack that advertised `provider` would be offering itself as
    // answerable by strangers. That is not a lint preference: it would put
    // the owner's purchasing on a lane any peer can drive.
    for (const cap of BUYER_REFERENCE_MANIFEST.capabilities) {
      expect(cap.kinds).toEqual(['tool']);
    }
  });

  /**
   * The classification is what the gatekeeper floors read (§9.0). Getting it
   * wrong is the cheap lie that makes a commitment pass as silently as a
   * read, so it is asserted per capability rather than in aggregate.
   */
  it('classifies obligation-creating capabilities above reads', () => {
    const byId = new Map<string, PluginCapabilityDecl>(
      [...SUPPLIER_REFERENCE_MANIFEST.capabilities, ...BUYER_REFERENCE_MANIFEST.capabilities].map(
        (c) => [c.id, c],
      ),
    );
    // Taking an order, ruling on a cancellation, and placing an order all
    // change what someone owes someone else.
    for (const id of ['submit_order', 'cancel_order', 'place_order'].map(nsid)) {
      expect(byId.get(id)?.action_class).toBe('write');
    }
    // Pricing has its own class in the §5 vocabulary; using `read` for it
    // would understate it and `write` would overstate it.
    for (const id of ['request_quote', 'collect_quotes'].map(nsid)) {
      expect(byId.get(id)?.action_class).toBe('quote');
    }
    for (const id of ['order_status', 'track_order'].map(nsid)) {
      expect(byId.get(id)?.action_class).toBe('read');
    }
  });

  it('asks for no authority it does not use', () => {
    // §3.4 host operations are for reaching OUTSIDE this node. These runners
    // answer from the owner's own data, so requesting the broker would be
    // asking for authority with no call site — and a reference manifest is
    // exactly where that habit would be learned from.
    for (const [, manifest] of MANIFESTS) {
      for (const cap of manifest.capabilities) {
        expect(cap.host_operations ?? []).toEqual([]);
        expect(cap.network_domains ?? []).toEqual([]);
      }
    }
  });

  it('pins a params and result schema on every capability', () => {
    // The envelope pins whatever the manifest declares, and the runner SDK
    // validates against that pin. A capability with no result schema is one
    // whose answer nothing checks.
    for (const [, manifest] of MANIFESTS) {
      for (const cap of manifest.capabilities) {
        expect(cap.params_schema).toBeDefined();
        expect(cap.result_schema).toBeDefined();
      }
    }
  });

  it('uses no $ref anywhere in a pinned schema', () => {
    // §5 rule 4 bans it, and the reason survives the rule: a schema a node
    // cannot resolve locally is a schema it cannot check. Asserted over the
    // serialized form so a nested occurrence cannot hide.
    for (const [, manifest] of MANIFESTS) {
      expect(JSON.stringify(manifest)).not.toContain('$ref');
    }
  });

  /**
   * The manifest and the seam that READS its answers must agree, and nothing
   * else checks that they do.
   *
   * This is not hypothetical: the first version of the supplier pack named the
   * decision field `decision` while `readDecision` looks for `kind`. Every
   * local check passed — the manifest validated, the SDK accepted an answer
   * shaped to it — and the failure appeared only at the point where the
   * buyer got the runner's raw words instead of a signed acknowledgement.
   */
  it('declares a submit_order result the decision seam can actually read', () => {
    const cap = SUPPLIER_REFERENCE_MANIFEST.capabilities.find((c) => c.id === nsid('submit_order'));
    const schema = cap?.result_schema as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(['kind']);
    // The enum must be exactly the three §9.9 outcomes the seam switches on.
    // A fourth would be a decision Core cannot record; a missing one would be
    // an outcome a supplier cannot express.
    expect(schema.properties?.kind?.enum).toEqual(['accepted', 'rejected', 'counterproposal']);

    // Drive the REAL reader, so this is agreement in fact rather than by
    // matching strings in two files.
    expect(readSupplierDecision({ kind: 'accepted', supplier_order_id: 'CM-1' })).not.toBeNull();
    expect(readSupplierDecision({ kind: 'rejected', reason_code: 'out_of_stock' })).not.toBeNull();
    // And the shape the manifest USED to declare is refused, which is what
    // makes this test a guard rather than a restatement.
    expect(readSupplierDecision({ decision: 'accepted', supplier_order_id: 'CM-1' })).toBeNull();
  });

  it('never lets a runner claim an authority Core owns', () => {
    // The supplier answers `submit_order` with a DECISION, not an
    // acknowledgement, and `request_quote` with TERMS, not a signed quote.
    // A result schema that accepted a signed record would invite a runner to
    // mint one — and it has no key, no ledger, and no view of capacity.
    const text = JSON.stringify(SUPPLIER_REFERENCE_MANIFEST);
    for (const forbidden of [
      'acknowledgement_digest',
      'quote_digest',
      'status_digest',
      'supplier_epoch',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
