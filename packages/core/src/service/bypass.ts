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
  | 'no_window'
  | 'body_invalid'
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
      /** The bypass is denied — caller must fall back to the contact gate. */
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
export type LocalCapabilityChecker = (capability: string) => boolean;

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
    const checker = opts.isCapabilityConfigured;
    if (checker === undefined || !checker(body.capability)) {
      return {
        kind: 'deny',
        reason: 'not_configured',
        detail: `capability "${body.capability}" is not configured locally`,
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
