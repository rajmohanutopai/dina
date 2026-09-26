/**
 * The supplier pack's listing binding (JIFFY_MERCHANT_INTEGRATION_PLAN
 * review, item 6).
 *
 * A buyer's quote or order reaches the pack only through a service listing
 * whose capabilities name the install (`pluginInstallId`, the manifest CID
 * and the manifest's capability id). Nothing in the product wrote that
 * binding — the test bed did, signed with the Brain key — so a node could
 * consent to the pack and still refuse every buyer. The owner's consent now
 * writes it: binding the capabilities to the install is the direct
 * consequence of consenting to the install, and the begin step names the
 * listing so the owner reads it before saying yes.
 *
 * WHAT IT NEVER CHANGES. The listing's visibility. A fresh listing is
 * `unlisted` — buyers reach a supplier by naming it, not by searching the
 * commerce lanes — and an existing unlisted or known-only one keeps its
 * setting. A PUBLIC `self` listing is refused rather than altered: public
 * custom capabilities must publish schemas, the commerce lanes deliberately
 * publish none (the buyer's request is digest-bound, not schema-pinned),
 * and quietly demoting a public listing would hide the owner's other
 * services. The refusal says what to do: give that listing its own rkey.
 */

import { getPluginInstallRepository } from '../plugins/registry';
import {
  DEFAULT_LISTING_RKEY,
  getServiceConfig,
  setServiceConfigDurable,
  validateServiceConfigForSave,
} from '../service/service_config';

import { referenceManifestCid } from './reference_install';
import { SUPPLIER_REFERENCE_MANIFEST } from './reference_manifests';

import type { ServiceConfig } from '@dina/protocol';

/** Wire capability → the manifest capability that answers it. */
export const SUPPLIER_LISTING_BINDINGS: readonly { wire: string; capabilityId: string }[] = [
  {
    wire: 'com.dinakernel.commerce.request_quote',
    capabilityId: 'com.dinakernel.commerce.request-quote',
  },
  {
    wire: 'com.dinakernel.commerce.submit_order',
    capabilityId: 'com.dinakernel.commerce.submit-order',
  },
  {
    wire: 'com.dinakernel.commerce.order_status',
    capabilityId: 'com.dinakernel.commerce.order-status',
  },
  // Reconcile is answered by Core (§12.7) before any binding check, but the
  // listing must still declare it with a complete plugin plane to route.
  {
    wire: 'com.dinakernel.commerce.order_reconcile',
    capabilityId: 'com.dinakernel.commerce.order-status',
  },
  {
    wire: 'com.dinakernel.commerce.cancel_order',
    capabilityId: 'com.dinakernel.commerce.cancel-order',
  },
  // NEGOTIATION_PLAN §4.3 — a buyer's counter-offer, answered by the runner
  // within Core's floors.
  {
    wire: 'com.dinakernel.commerce.counter_offer',
    capabilityId: 'com.dinakernel.commerce.negotiate-quote',
  },
  // §4.5 — the not-awarded notice is answered by Core alone, like reconcile,
  // and like reconcile it still routes through a complete plugin plane.
  {
    wire: 'com.dinakernel.commerce.quote_outcome',
    capabilityId: 'com.dinakernel.commerce.request-quote',
  },
];

export const SUPPLIER_LISTING_RKEY = DEFAULT_LISTING_RKEY;

export type SupplierListingOutcome =
  | { ok: true; rkey: string; discoverability: string; created: boolean }
  | {
      ok: false;
      refusal: 'self_listing_public' | 'invalid_listing' | 'persistence_failed';
      detail: string;
    };

/** What the begin step shows the owner: the listing the pack will join. */
export function describeSupplierListing(): {
  rkey: string;
  visibility: string;
  capabilities: string[];
} {
  const existing = getServiceConfig(SUPPLIER_LISTING_RKEY);
  return {
    rkey: SUPPLIER_LISTING_RKEY,
    visibility:
      existing?.discoverability ??
      (existing === null ? 'unlisted' : existing.isDiscoverable ? 'public' : 'known_only'),
    capabilities: SUPPLIER_LISTING_BINDINGS.map((b) => b.wire),
  };
}

export async function bindSupplierListing(args: {
  installId: string;
  name: string;
}): Promise<SupplierListingOutcome> {
  const existing = getServiceConfig(SUPPLIER_LISTING_RKEY);
  const visibility =
    existing === null
      ? 'unlisted'
      : (existing.discoverability ?? (existing.isDiscoverable ? 'public' : 'known_only'));
  if (visibility === 'public') {
    return {
      ok: false,
      refusal: 'self_listing_public',
      detail: `the "${SUPPLIER_LISTING_RKEY}" listing is public; move that service to its own rkey, then confirm again`,
    };
  }
  // The manifest the install RUNS, not the one this build ships: an install on
  // an older pack version must keep answering under its own contract, and a
  // listing pinned to a newer CID is refused as stale. Only the lanes that
  // manifest provides are bound — pack 1.0.0 has no `negotiate-quote`, so its
  // listing simply offers no counter lane (NEGOTIATION_PLAN §4.3).
  const install = getPluginInstallRepository()?.getById(args.installId) ?? null;
  const manifestCid =
    install?.currentCid !== undefined && install.currentCid !== ''
      ? install.currentCid
      : referenceManifestCid(SUPPLIER_REFERENCE_MANIFEST);
  const provided = new Set(
    (install?.manifest.capabilities ?? SUPPLIER_REFERENCE_MANIFEST.capabilities).map((c) => c.id),
  );
  const commerce = Object.fromEntries(
    SUPPLIER_LISTING_BINDINGS.filter((b) => provided.has(b.capabilityId)).map((b) => [
      b.wire,
      {
        responsePolicy: 'auto',
        category: 'commerce',
        pluginInstallId: args.installId,
        pluginManifestCid: manifestCid,
        pluginCapabilityId: b.capabilityId,
      },
    ]),
  );
  const base: ServiceConfig =
    existing ??
    ({
      name: args.name,
      status: 'active',
      isDiscoverable: false,
      capabilities: {},
    } as unknown as ServiceConfig);
  const schemas = Object.fromEntries(
    Object.entries(base.capabilitySchemas ?? {}).filter(
      ([key]) => !key.startsWith('com.dinakernel.commerce.'),
    ),
  );
  const next = {
    ...base,
    isDiscoverable: false,
    discoverability: visibility,
    capabilities: { ...(base.capabilities ?? {}), ...commerce },
    capabilitySchemas: schemas,
  } as unknown as ServiceConfig;
  const checked = validateServiceConfigForSave(next);
  if (!checked.ok) {
    const why = (checked.details ?? []).map((d) => `${d.code}: ${d.message}`).join('; ');
    return { ok: false, refusal: 'invalid_listing', detail: why === '' ? checked.error : why };
  }
  try {
    await setServiceConfigDurable(checked.config, SUPPLIER_LISTING_RKEY);
  } catch (err) {
    return {
      ok: false,
      refusal: 'persistence_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    ok: true,
    rkey: SUPPLIER_LISTING_RKEY,
    discoverability: visibility,
    created: existing === null,
  };
}
