/**
 * The owner's term-negotiation routes (SHELF_SPACE_NEGOTIATION §5–§8).
 *
 * OWNER-ONLY, every one: `/v1/commerce` is owner-only in the authz matrix and
 * each handler re-checks the boot-minted capability. Acts that change what
 * this node offers, publishes or is bound by need the owner PRESENT: setting
 * the policy (it moves floors), publishing or withdrawing a listing (a public
 * record), and ending an agreement. The two cards that bind a deal are
 * approved through the workflow's approve route (`PRESENCE_GATED_PAYLOAD_TYPES`).
 * On a node that cannot establish presence at all (a phone with no
 * passphrase) they fall open like every gated card — the owner's decision,
 * 2026-10-14 — and the phone's card warns that presence went unchecked.
 *
 * Term agreements are created ONLY by consuming those approvals: there is no
 * route here that proposes or decides one, and the revenue-share propose and
 * decide routes cannot reach a term proposal (it lives in the term store).
 */

import { ownerPresenceRefusal } from '../../commerce/owner_presence';
import { beginFirstPartyInstall } from '../../commerce/reference_install';
import { getCommerceRuntime } from '../../commerce/runtime';
import { SLOT_BUYER_MANIFEST, SLOT_SELLER_MANIFEST } from '../../commerce/slot_pack_manifests';
import {
  getTermListingRepo,
  savePolicyWithdrawing,
  withdrawEverywhere,
  withListingsLock,
} from '../../commerce/term/term_listing_repo';
import { getNodeDID } from '../../pairing/ceremony';
import { getPluginInstallRepository } from '../../plugins/registry';

import { makeOwnerGuard } from './owner_guard';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

function body(req: CoreRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

const NO_COMMERCE: CoreResponse = { status: 503, body: { error: 'commerce_unavailable' } };

export function registerTermRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may negotiate shelf space',
  );
  const engine = () => getCommerceRuntime()?.terms ?? null;
  const present = (req: CoreRequest, detail: string): CoreResponse | null =>
    ownerOnlyGuard(req) ?? ownerPresenceRefusal(req, Date.now(), detail);

  // --- turning the Slot Pack on (§4) -----------------------------------------

  /**
   * Begin the Slot Pack's install for one side — the store's (`seller`) or the
   * brand's (`buyer`); two installs, two consents, like the Commerce Pack.
   * Only `begin` lives here: binding Core's own runner and consenting are the
   * Commerce Pack's routes (`/v1/commerce/install/bind_reference_runner`,
   * `/confirm`), which already serve every first-party pack in the table and
   * need a person present. An ACTIVE install answers without a second consent.
   */
  router.post('/v1/commerce/terms/install/begin', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const side = body(req).side;
    if (side !== 'seller' && side !== 'buyer') {
      return { status: 400, body: { error: "side must be 'seller' | 'buyer'" } };
    }
    const owner = getNodeDID();
    if (owner === null || owner === '') {
      return { status: 503, body: { error: 'owner_identity_unavailable' } };
    }
    const installs = getPluginInstallRepository();
    if (installs === null) return { status: 503, body: { error: 'plugin_registry_unavailable' } };
    const pluginId = (side === 'seller' ? SLOT_SELLER_MANIFEST : SLOT_BUYER_MANIFEST).plugin_id;
    const active = installs
      .list()
      .find((install) => install.pluginId === pluginId && install.status === 'active');
    if (active !== undefined) {
      return {
        status: 200,
        body: { ok: true, install_id: active.installId, plugin_id: pluginId, status: 'active' },
      };
    }
    const begun = beginFirstPartyInstall({ pluginId, publisherDid: owner, nowMs: Date.now() });
    if (!begun.ok) {
      return { status: 409, body: { ok: false, error: begun.code, detail: begun.message } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        install_id: begun.installId,
        plugin_id: pluginId,
        status: 'pending',
        consent: begun.consent,
      },
    };
  });

  // --- the store's policy (§5.4) ---------------------------------------------

  router.get('/v1/commerce/terms/policy', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    return { status: 200, body: { policy: terms.policy() } };
  });

  router.put('/v1/commerce/terms/policy', async (req): Promise<CoreResponse> => {
    const denied = present(req, 'changing your slot terms needs a person present');
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    // Renting switched off, or a slot's terms removed: its public listings
    // would only invite refusals, so they go too — in the same change as the
    // save, so no publish slips between (`savePolicyWithdrawing`).
    const saved = await savePolicyWithdrawing(terms, body(req).policy);
    if (!saved.ok) return { status: 400, body: { error: saved.refusal } };
    return {
      status: 200,
      body: { ok: true, revision: saved.revision, withdrawn: saved.withdrawn },
    };
  });

  // --- listings (§6.1) ---------------------------------------------------------

  router.get('/v1/commerce/terms/listings', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    return { status: 200, body: { listings: terms.listings() } };
  });

  router.post('/v1/commerce/terms/listings', async (req): Promise<CoreResponse> => {
    const denied = present(req, 'publishing a slot listing needs a person present');
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    const b = body(req);
    if (
      typeof b.resource_ref !== 'string' ||
      typeof b.kind !== 'string' ||
      !Array.isArray(b.tags) ||
      b.region === undefined
    ) {
      return { status: 400, body: { error: 'resource_ref, kind, region and tags are required' } };
    }
    const input = {
      listingId: typeof b.listing_id === 'string' ? b.listing_id : b.resource_ref,
      resourceRef: b.resource_ref,
      kind: b.kind,
      ...(b.size !== undefined ? { size: b.size as never } : {}),
      region: b.region as never,
      tags: (b.tags as unknown[]).filter((t): t is string => typeof t === 'string'),
    };
    const precheck = terms.composeListing(input);
    if (!precheck.ok) return { status: 400, body: { error: precheck.refusal } };
    // The public record first, the local "published" second: a listing this
    // node answers for must be one AppView can actually see.
    const repo = getTermListingRepo();
    if (repo === null)
      return {
        status: 503,
        body: { error: 'no_repo', detail: 'this node has no repo to publish to' },
      };
    // One change among this node's listing changes (`withListingsLock`):
    // composed again inside it, against the policy that stands now, and no
    // policy save, withdrawal or removal can fall between record and row.
    const written = await withListingsLock(async () => {
      const composed = terms.composeListing(input);
      if (!composed.ok) return { status: 400, body: { error: composed.refusal } } as const;
      // Noted before the write: if it fails but lands all the same, or the
      // node stops mid-write, the sweeper still finds the record to remove.
      terms.markRecordMayStand(composed.listing);
      try {
        await repo.put(composed.listing);
      } catch {
        return { status: 502, body: { error: 'listing_write_failed' } } as const;
      }
      terms.storeListing(composed.listing);
      return {
        status: 200,
        body: { ok: true, listing: composed.listing, uri: composed.uri },
      } as const;
    });
    return written;
  });

  router.delete('/v1/commerce/terms/listings/:id', async (req): Promise<CoreResponse> => {
    const denied = present(req, 'withdrawing a slot listing needs a person present');
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    const id = req.params.id ?? '';
    // Local first: from this moment no new request binds to it, whatever the
    // repo says — in the listing's write queue, so a republish in flight cannot
    // undo it.
    const done = await withdrawEverywhere(terms, id);
    if (!done.known) return { status: 404, body: { error: 'unknown_listing' } };
    return { status: 200, body: { ok: true, record_removed: done.recordRemoved } };
  });

  // --- the brand's negotiations (§7.1, §8) --------------------------------------

  router.post('/v1/commerce/terms/negotiations', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    const b = body(req);
    if (
      typeof b.listing_uri !== 'string' ||
      typeof b.tag !== 'string' ||
      typeof b.start !== 'string' ||
      typeof b.end !== 'string'
    ) {
      return {
        status: 400,
        body: { error: 'listing, listing_uri, tag, start, end and policy are required' },
      };
    }
    const started = terms.startNegotiation({
      listing: b.listing,
      listingUri: b.listing_uri,
      tag: b.tag,
      attributes: (b.attributes ?? {}) as never,
      start: b.start,
      end: b.end,
      policy: b.policy as never,
    });
    return started.ok
      ? { status: 200, body: { ok: true, request_id: started.request.request_id } }
      : { status: 400, body: { error: started.refusal } };
  });

  router.get('/v1/commerce/terms/negotiations', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    return { status: 200, body: { negotiations: terms.negotiations(), ranked: terms.ranked() } };
  });

  // --- agreements (§5.5–5.6) --------------------------------------------------------

  router.get('/v1/commerce/terms/agreements', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    return { status: 200, body: { agreements: terms.agreements() } };
  });

  router.get('/v1/commerce/terms/agreements/:digest', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    const digest = req.params.digest ?? '';
    const view = terms.agreement(digest);
    if (view.status === 'none') return { status: 404, body: { error: 'unknown_agreement' } };
    return { status: 200, body: { ...view, schedule: terms.schedule(digest) } };
  });

  router.post(
    '/v1/commerce/terms/agreements/:digest/terminate',
    async (req): Promise<CoreResponse> => {
      const denied = present(req, 'ending a slot agreement needs a person present');
      if (denied !== null) return denied;
      const terms = engine();
      if (terms === null) return NO_COMMERCE;
      const b = body(req);
      const ended = terms.terminate({
        proposalDigest: req.params.digest ?? '',
        ...(typeof b.effective_at === 'string' ? { effectiveAt: b.effective_at } : {}),
      });
      return ended.ok
        ? { status: 200, body: { ok: true, document: ended.document } }
        : { status: 409, body: { error: ended.refusal } };
    },
  );

  router.post(
    '/v1/commerce/terms/agreements/:digest/settlements',
    async (req): Promise<CoreResponse> => {
      const denied = ownerOnlyGuard(req);
      if (denied !== null) return denied;
      const terms = engine();
      if (terms === null) return NO_COMMERCE;
      const b = body(req);
      if (
        typeof b.period_start !== 'string' ||
        typeof b.period_end !== 'string' ||
        typeof b.gross_minor !== 'string'
      ) {
        return {
          status: 400,
          body: { error: 'period_start, period_end and gross_minor are required' },
        };
      }
      const issued = terms.issueSettlement({
        proposalDigest: req.params.digest ?? '',
        periodStart: b.period_start,
        periodEnd: b.period_end,
        grossMinor: b.gross_minor,
        ...(typeof b.replaces_settlement_digest === 'string'
          ? { replacesSettlementDigest: b.replaces_settlement_digest }
          : {}),
      });
      return issued.ok
        ? { status: 200, body: { ok: true, document: issued.document } }
        : { status: 409, body: { error: issued.refusal } };
    },
  );

  router.post('/v1/commerce/terms/settlements/:digest/ack', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;
    const terms = engine();
    if (terms === null) return NO_COMMERCE;
    const kind = body(req).kind;
    if (kind !== 'accepted' && kind !== 'disputed')
      return { status: 400, body: { error: 'kind: accepted or disputed' } };
    const acked = terms.acknowledgeSettlement({ settlementDigest: req.params.digest ?? '', kind });
    return acked.ok
      ? { status: 200, body: { ok: true, document: acked.document } }
      : { status: 409, body: { error: acked.refusal } };
  });
}
