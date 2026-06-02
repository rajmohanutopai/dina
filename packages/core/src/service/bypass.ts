/**
 * Contact-gate bypass decisions for `service.query` / `service.response`.
 *
 * Standard D2D traffic is contacts-only: the Egress and Ingress gates reject
 * any peer that is not an explicit contact. Public-service traffic is the
 * one exception — it travels between strangers, authorised instead by a
 * time-bounded `QueryWindow`.
 *
 * This module provides the *decision layer*. It is deliberately pure: no
 * side effects, no network, no singletons reached directly. Callers pass
 * the relevant window / resolver / config in, and the function returns a
 * structured decision that the send / receive pipelines act on.
 *
 * Layering:
 *   - Inputs:  `MessageType` + parsed body + local state (windows, resolver).
 *   - Output:  `ServiceBypassDecision` — one of `allow` / `deny` / `not-service`.
 *   - Side effects: NONE. The actual `reserve` / `checkAndConsume` call is
 *                   performed by the send / receive pipeline AFTER this
 *                   decision is evaluated, so that pipeline can also run
 *                   ingress-drop and identity checks first.
 *
 * Source:
 *   core/internal/service/transport.go — egress + ingress bypass blocks
 *   core/internal/domain/message.go    — MsgTypeServiceQuery / Response
 */

import { parseServiceListingUri, resolveSearchableCapability } from '@dina/protocol';
import { MsgTypeServiceQuery, MsgTypeServiceResponse } from '../d2d/families';
import {
  validateServiceQueryBody,
  validateServiceResponseBody,
  ServiceQueryBody,
  ServiceResponseBody,
} from '../d2d/service_bodies';

/** Reasons a bypass can be denied — useful for audit logs. */
export type BypassDenyReason =
  | 'not_public_service'
  | 'not_configured'
  | 'not_authorized'
  | 'no_window'
  | 'body_invalid'
  | 'service_uri_mismatch'
  | 'message_type_mismatch';

/** Decision surface for every `service.*` bypass check. */
export type ServiceBypassDecision =
  | {
      /** The message is not a service.* type — not this gate's concern. */
      kind: 'not-service';
    }
  | {
      /** The bypass is allowed — caller should skip the contact gate. */
      kind: 'allow';
      /** Parsed + validated body (saves callers a re-parse). */
      body: ServiceQueryBody | ServiceResponseBody;
    }
  | {
      /**
       * The bypass is denied. NOTE: for inbound `service.*` traffic the receive
       * pipeline DROPS a denied message — it does NOT fall back to the contact
       * gate (the decision layer already validated body + semantics, so a
       * fallback would only produce a less-specific drop). The `reason` is
       * recorded for audit. Egress callers may still choose their own fallback.
       */
      kind: 'deny';
      reason: BypassDenyReason;
      /** Human-readable detail suitable for audit lines. */
      detail: string;
    };

/**
 * Minimal shape of the AppView resolver needed for an egress decision.
 * Matches `AppViewServiceResolver` without importing its concrete class —
 * keeps this module decoupled from the HTTP layer for tests.
 */
export interface ProviderServiceResolver {
  isDiscoverableService(did: string, capability: string): Promise<boolean>;
}

/**
 * Minimal shape of the local service config reader. The actual store lives in
 * `service_config.ts`; passing an explicit function keeps this module
 * unit-testable without pulling in the module-level state.
 */
export type LocalCapabilityChecker = (capability: string, rkey?: string) => boolean;

/**
 * Minimal shape of the requester-side window for ingress checks. Returns
 * `true` if an entry matching `(peerDID, queryID, capability)` exists and
 * is still live — WITHOUT consuming it. The ingress pipeline performs the
 * real `checkAndConsume` after running all other checks (ingress-drop,
 * identity verification, etc.) so a drop reason can't silently consume
 * a window.
 */
export interface RequesterWindowView {
  peek(peerDID: string, queryID: string, capability: string): boolean;
}

/**
 * Decide whether an outbound message qualifies for contact-gate bypass.
 *
 * - For `service.query`: consult the AppView resolver. Callers that already
 *   know the recipient is a public service can omit the resolver — the
 *   function then assumes the precondition is met and still validates the
 *   body.
 * - For `service.response`: we do NOT reserve the provider window here;
 *   that's the pipeline's job. We just confirm the body is well-formed.
 * - For anything else: returns `not-service`.
 */
export async function evaluateServiceEgressBypass(
  messageType: string,
  recipientDID: string,
  bodyJSON: string,
  resolver?: ProviderServiceResolver,
): Promise<ServiceBypassDecision> {
  if (messageType === MsgTypeServiceQuery) {
    const parsed = parseBody(bodyJSON, validateServiceQueryBody);
    if (parsed.err !== null) {
      return {
        kind: 'deny',
        reason: 'body_invalid',
        detail: parsed.err,
      };
    }
    const body = parsed.body as ServiceQueryBody;
    // A `service_uri` IS the access grant for a specific listing (link / QR /
    // invite). When the requester targeted one, trust it: validate only that the
    // URI's authority matches who we're sending to, then allow egress — this is
    // how an UNLISTED service is reachable (AppView never advertises unlisted, so
    // the `isDiscoverableService` check below would wrongly deny it). The
    // RECIPIENT's ingress gate is authoritative: it accepts only a live listing
    // (active, not known_only) that offers the capability, so a stale/known_only/
    // wrong service_uri is rejected there.
    if (typeof body.service_uri === 'string' && body.service_uri !== '') {
      const listing = parseServiceListingUri(body.service_uri);
      if (listing === null || listing.did !== recipientDID) {
        return {
          kind: 'deny',
          reason: 'service_uri_mismatch',
          detail: `service_uri authority ${listing?.did ?? '(unparseable)'} does not match recipient ${recipientDID}`,
        };
      }
      return { kind: 'allow', body };
    }
    // No service_uri (a bare, link-less capability query to a non-contact):
    // require the recipient to be a PUBLIC service for this capability. Unlisted
    // / known-only need a service_uri (handled above).
    if (resolver !== undefined) {
      const isDiscoverable = await resolver.isDiscoverableService(recipientDID, body.capability);
      if (!isDiscoverable) {
        return {
          kind: 'deny',
          reason: 'not_public_service',
          detail: `recipient ${recipientDID} does not advertise capability "${body.capability}"`,
        };
      }
    }
    return { kind: 'allow', body };
  }

  if (messageType === MsgTypeServiceResponse) {
    const parsed = parseBody(bodyJSON, validateServiceResponseBody);
    if (parsed.err !== null) {
      return {
        kind: 'deny',
        reason: 'body_invalid',
        detail: parsed.err,
      };
    }
    return { kind: 'allow', body: parsed.body as ServiceResponseBody };
  }

  return { kind: 'not-service' };
}

/**
 * Decide whether an inbound message qualifies for contact-gate bypass.
 *
 * - For `service.query`: ask `isCapabilityConfigured(body.capability)`.
 *   If the home node publishes that capability, accept (the requester gets
 *   a window for its response opened later by the caller).
 * - For `service.response`: peek at the requester window. If a live entry
 *   matches, allow — the caller then consumes the entry with
 *   `checkAndConsume` so it's one-shot.
 * - For anything else: `not-service`.
 */
export function evaluateServiceIngressBypass(
  messageType: string,
  fromDID: string,
  bodyJSON: string,
  opts: {
    /** Local config reader — called with the capability name. */
    isCapabilityConfigured?: LocalCapabilityChecker;
    /** Requester-side window peek. */
    requester?: RequesterWindowView;
    /**
     * THIS node's DID (the message recipient). When provided, a `service.query`
     * carrying a `service_uri` is rejected unless that listing URI's authority
     * equals `recipientDID` — i.e. the chosen listing actually belongs to us.
     * The Core HTTP route binds `service_uri` authority to `to_did`, but a
     * direct inbound D2D envelope never passes that route; this is the same
     * bind on the inbound path. Body validation already enforced structure
     * (well-formed com.dinakernel.service.profile listing URI). Omitted ⇒ skip the
     * cross-DID bind (back-compat for callers that don't know the recipient).
     */
    recipientDID?: string;
    /**
     * True iff the targeted rkey is a LIVE `known_only` listing offering the
     * capability (the global `isKnownOnlyCapabilityConfigured`). When it is, the
     * listing is NOT publishable, so `isCapabilityConfigured` would deny it —
     * instead we route to the GRANT gate below. Omitted ⇒ known_only path off.
     */
    knownOnlyCapabilityConfigured?: (capability: string, rkey: string) => boolean;
    /**
     * The provider-side grant authorization check (a `ServiceGrantRepository`
     * `isAuthorized`, with the clock applied). Called ONLY for a known_only
     * listing, with `granteeDid` = the transport-authenticated caller (`fromDID`
     * here, which the pipeline already bound to `authenticatedFromDID`). True
     * means a matching active grant exists. Omitted ⇒ known_only denied.
     */
    isGrantAuthorized?: (args: {
      granteeDid: string;
      serviceRkey: string;
      capability: string;
      grantId?: string;
    }) => boolean;
  },
): ServiceBypassDecision {
  if (messageType === MsgTypeServiceQuery) {
    const parsed = parseBody(bodyJSON, validateServiceQueryBody);
    if (parsed.err !== null) {
      return {
        kind: 'deny',
        reason: 'body_invalid',
        detail: parsed.err,
      };
    }
    const body = parsed.body as ServiceQueryBody;
    // Resolve the targeted listing FIRST (one listing == one execution
    // contract). When the query carries a `service_uri`: (a) its authority must
    // be us, and (b) we capture its rkey so the capability check validates the
    // EXACT listing — not just "any of our listings offers this capability".
    // `validateServiceQueryBody` already confirmed a non-empty service_uri is a
    // well-formed listing URI, so a non-null parse is guaranteed here.
    let targetRkey: string | undefined;
    if (typeof body.service_uri === 'string' && body.service_uri !== '') {
      const listing = parseServiceListingUri(body.service_uri);
      if (
        opts.recipientDID !== undefined &&
        listing !== null &&
        listing.did !== opts.recipientDID
      ) {
        return {
          kind: 'deny',
          reason: 'service_uri_mismatch',
          detail: `service_uri authority ${listing.did} does not match recipient ${opts.recipientDID}`,
        };
      }
      targetRkey = listing?.rkey;
    }
    // known_only listings are NOT publishable, so `isCapabilityConfigured`
    // denies them. Instead, a known_only listing executes ONLY against a valid
    // GRANT: an active `service_grants` row for THIS authenticated caller
    // (`fromDID`, already bound to the envelope's authenticated sender),
    // this listing rkey, and this capability, PINNED to the `grant_id` the
    // requester echoed. Possessing the service_uri/grant_id is NOT enough; the
    // grant must belong to the caller.
    if (
      targetRkey !== undefined &&
      opts.knownOnlyCapabilityConfigured?.(body.capability, targetRkey) === true
    ) {
      // A known_only query MUST echo its grant_id (clean grant semantics +
      // forward-compat for one-time/quota grants where the exact grant matters).
      const echoedGrantId =
        typeof body.grant_id === 'string' && body.grant_id !== '' ? body.grant_id : undefined;
      if (echoedGrantId === undefined) {
        return {
          kind: 'deny',
          reason: 'not_authorized',
          detail: `known_only listing "${targetRkey}" requires a grant_id on the query`,
        };
      }
      // Canonicalize the capability so a grant stored under the canonical name
      // matches a query sent under an alias (or vice versa) — the same alias↔
      // canonical resolution the listing config uses. Custom NSIDs resolve to
      // themselves; an unknown falls back to the raw string.
      const grantCapability = resolveSearchableCapability(body.capability) ?? body.capability;
      const authorized =
        opts.isGrantAuthorized?.({
          granteeDid: fromDID,
          serviceRkey: targetRkey,
          capability: grantCapability,
          grantId: echoedGrantId,
        }) === true;
      if (!authorized) {
        return {
          kind: 'deny',
          reason: 'not_authorized',
          detail: `no active grant authorizes ${fromDID} for known_only listing "${targetRkey}" capability "${body.capability}"`,
        };
      }
      return { kind: 'allow', body };
    }
    const checker = opts.isCapabilityConfigured;
    if (checker === undefined || !checker(body.capability, targetRkey)) {
      return {
        kind: 'deny',
        reason: 'not_configured',
        detail:
          targetRkey !== undefined
            ? `listing "${targetRkey}" does not offer capability "${body.capability}" (or is not live)`
            : `capability "${body.capability}" is not configured locally`,
      };
    }
    return { kind: 'allow', body };
  }

  if (messageType === MsgTypeServiceResponse) {
    const parsed = parseBody(bodyJSON, validateServiceResponseBody);
    if (parsed.err !== null) {
      return {
        kind: 'deny',
        reason: 'body_invalid',
        detail: parsed.err,
      };
    }
    const body = parsed.body as ServiceResponseBody;
    const requester = opts.requester;
    if (requester === undefined || !requester.peek(fromDID, body.query_id, body.capability)) {
      return {
        kind: 'deny',
        reason: 'no_window',
        detail: `no active requester window for ${fromDID}/${body.query_id}/${body.capability}`,
      };
    }
    return { kind: 'allow', body };
  }

  return { kind: 'not-service' };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseBody(
  bodyJSON: string,
  validate: (b: unknown) => string | null,
): { body: unknown; err: null } | { body: null; err: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJSON);
  } catch (err) {
    return { body: null, err: `invalid JSON body: ${(err as Error).message}` };
  }
  const err = validate(parsed);
  if (err !== null) {
    return { body: null, err };
  }
  return { body: parsed, err: null };
}
