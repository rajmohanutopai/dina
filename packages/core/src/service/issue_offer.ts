/**
 * issueServiceOffer — the SINGLE source for "materialize a service grant +
 * deliver it as a `service.offer`". Shared by two callers so the logic is not
 * duplicated:
 *   - `POST /v1/service/offer` (provider PUSH — the owner offers a contact).
 *   - the `service.grant_request` handler (requester-initiated PREFLIGHT —
 *     docs/CONTACT_SERVICES_ARCHITECTURE.md §5.2).
 *
 * Invariant both callers depend on: mint the grant FIRST (it is the runtime
 * authority, checked at the grantee's next `service.query` ingress), then
 * deliver the offer; if delivery fails, ROLL BACK the grant so a failed send
 * never leaves dangling authorization.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  effectiveDiscoverability,
  effectiveListingStatus,
  resolveSearchableCapability,
  type ServiceOfferBody,
} from '@dina/protocol';

import { getServiceConfig, configuredCapabilityKey } from './service_config';

import type { ServiceGrantRepository } from './service_grant_repository';

/**
 * Outbound D2D send contract. Structural (not the routes-level `D2DSender`)
 * so the service layer does not import from the HTTP routes layer.
 */
export type ServiceOfferSender = (
  recipientDID: string,
  messageType: 'service.offer',
  body: Record<string, unknown>,
) => Promise<void>;

export type IssueOfferErrorCode =
  | 'no_listing'
  | 'not_offerable'
  | 'capability_not_offered'
  | 'send_failed';

export interface IssueOfferResult {
  ok: boolean;
  grantId?: string;
  serviceUri?: string;
  error?: string;
  errorCode?: IssueOfferErrorCode;
}

// Per-process monotonic counter so two offers minted in the same millisecond
// still get distinct grant_ids. grant_id is a non-secret SELECTOR — uniqueness
// is the only requirement, not unguessability.
let grantSeq = 0;
function nextGrantSeq(): number {
  grantSeq += 1;
  return grantSeq;
}

export async function issueServiceOffer(args: {
  toDID: string;
  rkey: string;
  capability: string;
  expiresAt?: number;
  selfDID: string;
  nowSec: number;
  grantRepo: ServiceGrantRepository;
  sender: ServiceOfferSender;
  /** When this offer is the auto-grant REPLY to a `service.grant_request`, the
   *  originating request_id — echoed so the requester can correlate + auto-replay
   *  exactly that request. Omitted for proactive/owner-pushed offers. */
  requestId?: string;
}): Promise<IssueOfferResult> {
  const cfg = getServiceConfig(args.rkey);
  if (cfg === null) {
    return { ok: false, errorCode: 'no_listing', error: `no listing for rkey "${args.rkey}"` };
  }
  // A grant may only be minted for an OFFERABLE listing: active + known_only. A
  // public/unlisted listing needs no grant (it is reachable without one), and a
  // paused/draft listing must not mint live authority for something that answers
  // nothing. Centralized here so BOTH callers — POST /v1/service/offer (route)
  // and the grant-request handler — enforce it, not just the handler.
  if (effectiveListingStatus(cfg) !== 'active' || effectiveDiscoverability(cfg) !== 'known_only') {
    return {
      ok: false,
      errorCode: 'not_offerable',
      error: `listing "${args.rkey}" is not offerable (must be active + known_only)`,
    };
  }
  // Alias-aware: resolve the requested capability to the listing's CONFIGURED
  // key (so an alias-configured listing can be offered by its canonical name,
  // and the schema is read from the right key) — matching execution semantics.
  const configuredKey = configuredCapabilityKey(cfg, args.capability);
  if (configuredKey === null) {
    return {
      ok: false,
      errorCode: 'capability_not_offered',
      error: `listing "${args.rkey}" does not offer capability "${args.capability}"`,
    };
  }

  const grantId = `grant-${bytesToHex(
    sha256(
      new TextEncoder().encode(
        `${args.toDID}|${args.rkey}|${args.capability}|${Date.now()}|${nextGrantSeq()}`,
      ),
    ),
  ).slice(0, 24)}`;

  // Store the CANONICAL capability so it matches a query sent under an alias
  // (ingress canonicalizes the query capability the same way before isAuthorized).
  const grantCapability = resolveSearchableCapability(args.capability) ?? args.capability;
  args.grantRepo.create({
    grantId,
    granteeDid: args.toDID,
    serviceRkey: args.rkey,
    capability: grantCapability,
    grantType: 'standing',
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
    createdAt: args.nowSec,
  });

  // The offer DELIVERS the grant + the self-contained listing metadata.
  const schema = cfg.capabilitySchemas?.[configuredKey];
  const serviceUri = `at://${args.selfDID}/com.dinakernel.service.profile/${args.rkey}`;
  const offerBody: ServiceOfferBody = {
    grant_id: grantId,
    // Deliver the CANONICAL capability (matches the stored grant + the
    // requester's canonical offer-lookup); args.capability may be an alias.
    capability: grantCapability,
    service_name: cfg.name ?? '',
    service_uri: serviceUri,
    ...(schema?.schemaHash !== undefined && schema.schemaHash !== ''
      ? { schema_hash: schema.schemaHash }
      : {}),
    ...(schema?.params !== undefined ? { params_schema: schema.params } : {}),
    ...(schema?.result !== undefined ? { result_schema: schema.result } : {}),
    ...(typeof schema?.defaultTtlSeconds === 'number' && schema.defaultTtlSeconds > 0
      ? { default_ttl_seconds: schema.defaultTtlSeconds }
      : {}),
    ...(args.expiresAt !== undefined ? { expires_at: args.expiresAt } : {}),
    ...(args.requestId !== undefined && args.requestId !== ''
      ? { request_id: args.requestId }
      : {}),
  };

  try {
    await args.sender(args.toDID, 'service.offer', offerBody as unknown as Record<string, unknown>);
  } catch (err) {
    // Roll back the grant: it is AUTHORITY and the grantee never received the
    // offer, so it must not be left live. Revoke (idempotent, best-effort).
    try {
      args.grantRepo.revoke(grantId, args.nowSec);
    } catch {
      /* best-effort rollback — a revoked-but-unsent grant is still inert */
    }
    return {
      ok: false,
      errorCode: 'send_failed',
      error: `offer send failed: ${(err as Error).message ?? String(err)}`,
    };
  }

  return { ok: true, grantId, serviceUri };
}
