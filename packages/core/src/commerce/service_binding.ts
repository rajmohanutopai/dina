/**
 * §15.2 — one listing, named once (DR-3).
 *
 * THE DEFECT THIS CLOSES. The approval bound `context.serviceUri` — "supplier
 * identity and service URI" — while the order routes carried a SEPARATE
 * `service_rkey`, taken from the request body and defaulting to `'self'`. That
 * rkey is what reaches the acting-for chain and therefore what a
 * listing-scoped grant is checked against. So a card could display one listing
 * and the authority check could be performed against another, and nothing
 * compared them. On a node with a single listing the two happened to agree,
 * which is why it went unnoticed: §10 multi-listing is exactly where it stops
 * being true.
 *
 * ONE SOURCE, DERIVED. The rkey now comes OUT of the service URI rather than
 * arriving beside it. A body may still state `service_rkey`, and stating a
 * different one is a refusal — the same rule as the install facts: a surface
 * that did not claim is fine, a surface that is wrong about what it showed is
 * not.
 *
 * THE URI MUST NAME THE ORDER'S SUPPLIER. Binding a service URI whose authority
 * is somebody else would let a card show a trusted supplier's listing over an
 * order addressed to a different DID.
 */

import { parseAtUri } from '@dina/protocol';

export type ServiceBindingRefusal =
  | 'service_uri_malformed'
  | 'service_uri_supplier_mismatch'
  | 'service_rkey_disagrees';

export type ResolvedServiceBinding =
  | { ok: true; serviceRkey: string }
  | { ok: false; refusal: ServiceBindingRefusal; detail: string };

/**
 * Work out which listing this order is against, from the URI the card bound.
 *
 * `statedRkey` is whatever the request body carried, or undefined when it
 * carried none.
 */
export function resolveServiceBinding(args: {
  serviceUri: string;
  supplierDid: string;
  statedRkey?: unknown;
}): ResolvedServiceBinding {
  const parsed = parseAtUri(args.serviceUri);
  if (parsed === null) {
    return {
      ok: false,
      refusal: 'service_uri_malformed',
      detail: 'context.serviceUri must be at://<did>/<collection>/<rkey>',
    };
  }
  if (parsed.did !== args.supplierDid) {
    return {
      ok: false,
      refusal: 'service_uri_supplier_mismatch',
      detail: `serviceUri names ${parsed.did}, the order names ${args.supplierDid}`,
    };
  }
  const stated = args.statedRkey;
  if (typeof stated === 'string' && stated !== '' && stated !== parsed.rkey) {
    return {
      ok: false,
      refusal: 'service_rkey_disagrees',
      detail: `service_rkey ${stated} is not the listing serviceUri names (${parsed.rkey})`,
    };
  }
  return { ok: true, serviceRkey: parsed.rkey };
}
