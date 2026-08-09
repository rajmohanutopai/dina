/**
 * ONE spelling for a commerce capability, chosen in ONE place.
 *
 * A commerce capability arrives under three names that all mean the same
 * thing: the bare form (`submit_order`), the full NSID
 * (`com.dinakernel.commerce.submit_order`), and the HYPHENATED manifest id
 * (`com.dinakernel.commerce.submit-order`) — which is what the supplier
 * reference manifest actually publishes. A local listing may also alias it to
 * something else entirely, which is why the caller passes the BOUND manifest
 * capability alongside the wire label.
 *
 * This module exists because listing the variants at each comparison site has
 * already failed twice. The ingress gate canonicalized and the result seam did
 * not, so an order sent under the manifest's own hyphenated id was ADMITTED —
 * reserving quote capacity — and then not recognised on the way back, which
 * returned the runner's unsigned decision to the buyer as though Core had
 * signed it. Every check on both sides now asks the same question of the same
 * function.
 */

const COMMERCE_NSID_PREFIX = 'com.dinakernel.commerce.';

/** Strip the commerce NSID prefix and normalise hyphens to underscores. */
function canonical(raw: string): string {
  const bare = raw.startsWith(COMMERCE_NSID_PREFIX)
    ? raw.slice(COMMERCE_NSID_PREFIX.length)
    : raw;
  return bare.replace(/-/g, '_');
}

/**
 * Every canonical name this capability could be known by: the wire label, and
 * the bound manifest capability when the caller has it.
 *
 * BOTH, not one: the wire label is what the buyer said and the bound id is
 * what this node agreed to serve. A listing alias makes them differ, and
 * either may be the one that names a commerce capability.
 */
export function commerceCapabilityNames(wire: string, pluginCapabilityId?: string): string[] {
  const names = [canonical(wire)];
  if (pluginCapabilityId !== undefined && pluginCapabilityId !== '') {
    names.push(canonical(pluginCapabilityId));
  }
  return names;
}

/** True when either name is in the set. */
export function isCommerceCapability(
  set: ReadonlySet<string>,
  wire: string,
  pluginCapabilityId?: string,
): boolean {
  return commerceCapabilityNames(wire, pluginCapabilityId).some((n) => set.has(n));
}
