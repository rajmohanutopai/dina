/**
 * D2D send pipeline — orchestrate the full message send flow.
 *
 * Pipeline:
 *   1. Build DinaMessage envelope (type, body, from, to, id, created_time)
 *   2. Egress 4-gate check (contact → scenario → sharing → audit)
 *   3. Sign plaintext JSON with sender's Ed25519 identity key
 *   4. Seal with recipient's X25519 public key (NaCl crypto_box_seal)
 *   5. Deliver to recipient's MsgBox /forward (or direct HTTPS)
 *   6. On delivery failure → queue in outbox for retry
 *   7. Audit log the send attempt
 *
 * Source: ARCHITECTURE.md Tasks 6.3–6.7
 */

import { buildMessage, sealMessage, type DinaMessage, type D2DPayload } from './envelope';
import { checkEgressGates } from './gates';
import { isValidV1Type, MsgTypeServiceQuery, MsgTypeServiceResponse } from './families';
import { appendAudit } from '../audit/service';
import {
  deliverMessage,
  getWSDeliverFn,
  type ServiceType,
  type DeliveryResult,
  type SenderIdentity,
} from '../transport/delivery';
import { enqueueMessage } from '../transport/outbox';
import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  evaluateServiceEgressBypass,
  type ProviderServiceResolver,
  type ServiceBypassDecision,
} from '../service/bypass';
import { providerWindow, setRequesterWindow } from '../service/windows';

export interface SendRequest {
  recipientDID: string;
  messageType: string;
  body: string;
  senderDID: string;
  senderPrivateKey: Uint8Array;
  recipientPublicKey: Uint8Array;
  serviceType: ServiceType;
  endpoint: string;
  dataCategories?: string[];
  /**
   * AppView resolver used ONLY for `service.query` egress: when the
   * recipient is a published public-service DID, the contact gate is
   * bypassed. Leave `undefined` to skip the check (existing behaviour for
   * all non-service traffic; service.query without a resolver is still
   * gated by the contact check).
   */
  providerServiceResolver?: ProviderServiceResolver;
}

export interface SendResult {
  sent: boolean;
  messageId: string;
  delivered: boolean;
  buffered: boolean;
  queued: boolean;
  deniedAt?: string;
  error?: string;
}

/**
 * Send a D2D message through the full pipeline.
 *
 * Never throws — all errors are returned in the result.
 */
export async function sendD2D(req: SendRequest): Promise<SendResult> {
  const messageId = `d2d-${bytesToHex(randomBytes(8))}`;

  // 0. V1 type enforcement — reject non-V1 message types before any further processing.
  // Matches Go's Gate 3 (V1MessageFamilies check in SendMessage).
  if (!isValidV1Type(req.messageType)) {
    return {
      sent: false,
      messageId,
      delivered: false,
      buffered: false,
      queued: false,
      deniedAt: 'type_enforcement',
      error: `Unknown message type "${req.messageType}". Valid V1 types: presence.signal, coordination.request/response, social.update, safety.alert, trust.vouch.request/response`,
    };
  }

  // 1a. Public-service bypass (service.query / service.response).
  //
  // `bypass` is null for non-service traffic. For service traffic:
  //   - `allow`: skip the contact gate (recipient is a registered public
  //     service OR we're replying with a pre-reserved provider window).
  //   - `deny`: short-circuit with the audit detail; the caller sees a
  //     denied SendResult and the contact gate never runs.
  const bypass = await evaluateServiceBypass(req);
  if (bypass !== null && bypass.kind === 'deny') {
    appendAudit(
      req.senderDID,
      'd2d_send_denied',
      req.recipientDID,
      `type=${req.messageType} denied_at=service_bypass reason=${bypass.reason}`,
    );
    return {
      sent: false,
      messageId,
      delivered: false,
      buffered: false,
      queued: false,
      deniedAt: 'service_bypass',
      error: bypass.detail,
    };
  }
  const serviceAllowBypass = bypass !== null && bypass.kind === 'allow';

  // 1b. For `service.response` egress we must reserve the provider window
  //     BEFORE sending; otherwise two concurrent responses would both pass.
  let providerReservation: ProviderReservation | null = null;
  if (
    req.messageType === MsgTypeServiceResponse &&
    serviceAllowBypass &&
    bypass !== null &&
    bypass.kind === 'allow'
  ) {
    const body = bypass.body as { query_id: string; capability: string };
    const reserved = providerWindow().reserve(req.recipientDID, body.query_id, body.capability);
    if (!reserved) {
      appendAudit(
        req.senderDID,
        'd2d_send_denied',
        req.recipientDID,
        `type=${req.messageType} denied_at=service_bypass reason=no_window`,
      );
      return {
        sent: false,
        messageId,
        delivered: false,
        buffered: false,
        queued: false,
        deniedAt: 'service_bypass',
        error: 'no provider window to reserve',
      };
    }
    providerReservation = {
      peerDID: req.recipientDID,
      queryID: body.query_id,
      capability: body.capability,
    };
  }

  // 2. Egress 4-gate check (skipped when the service bypass allowed the send).
  if (!serviceAllowBypass) {
    const gateResult = checkEgressGates(
      req.recipientDID,
      req.messageType,
      req.dataCategories ?? [],
    );

    if (!gateResult.allowed) {
      appendAudit(
        req.senderDID,
        'd2d_send_denied',
        req.recipientDID,
        `type=${req.messageType} denied_at=${gateResult.deniedAt}`,
      );
      return {
        sent: false,
        messageId,
        delivered: false,
        buffered: false,
        queued: false,
        deniedAt: gateResult.deniedAt,
      };
    }
  }

  // 1c. For `service.query` egress we open the requester-side window so
  //     that the eventual `service.response` is authorised on ingress.
  if (
    req.messageType === MsgTypeServiceQuery &&
    serviceAllowBypass &&
    bypass !== null &&
    bypass.kind === 'allow'
  ) {
    const body = bypass.body as { query_id: string; capability: string; ttl_seconds: number };
    setRequesterWindow(req.recipientDID, body.query_id, body.capability, body.ttl_seconds);
  }

  // 2. Build message
  const message: DinaMessage = {
    id: messageId,
    type: req.messageType,
    from: req.senderDID,
    to: req.recipientDID,
    created_time: Date.now(),
    body: req.body,
  };

  // 3 + 4 + 5. Sign + seal + deliver — all inside the single try so a
  // crypto / encoding failure takes the same never-throws path as a
  // network failure (review #1). Previously `sealMessage` ran OUTSIDE
  // the try, so a bad recipient pubkey or encoding error threw past
  // the caller's "never throws" contract AND left the requester /
  // provider window reservation in place with no release.
  let payloadBytes: Uint8Array;
  try {
    const payload = sealMessage(message, req.senderPrivateKey, req.recipientPublicKey);
    payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  } catch (err) {
    // Seal / encoding failed: release any reservation we opened above,
    // then return a denied result (nothing to queue — we can't even
    // ship the bytes downstream).
    releaseProviderReservation(providerReservation);
    appendAudit(
      req.senderDID,
      'd2d_send_denied',
      req.recipientDID,
      `type=${req.messageType} denied_at=seal_failed error=${err instanceof Error ? err.message : 'unknown'}`,
    );
    return {
      sent: false,
      messageId,
      delivered: false,
      buffered: false,
      queued: false,
      deniedAt: 'seal_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. Deliver
  try {
    const senderIdentity: SenderIdentity = {
      did: req.senderDID,
      privateKey: req.senderPrivateKey,
    };
    // WS-first for DinaMsgBox-routed recipients (issue #14). When the
    // home node holds an authenticated WebSocket to MsgBox, push the
    // envelope down that connection — it avoids a fresh TLS handshake
    // per message and reuses the long-lived signed session.
    // `sendD2DViaWS` takes plaintext + recipient pub (it seals + signs
    // internally, matching the format POST /forward would have produced).
    // On WS failure (session down / backpressure) we fall through to
    // the HTTP `/forward` path in `deliverMessage`.
    const wsDeliverFn = getWSDeliverFn();
    if (
      req.serviceType === 'DinaMsgBox' &&
      wsDeliverFn !== null &&
      wsDeliverFn(
        req.recipientDID,
        req.recipientPublicKey,
        message as unknown as Record<string, unknown>,
      )
    ) {
      appendAudit(
        req.senderDID,
        'd2d_send',
        req.recipientDID,
        `type=${req.messageType} id=${messageId} delivered=true via=ws`,
      );
      commitProviderReservation(providerReservation);
      return {
        sent: true,
        messageId,
        delivered: true,
        buffered: false,
        queued: false,
      };
    }
    const delivery = await deliverMessage(
      req.recipientDID,
      payloadBytes,
      req.serviceType,
      req.endpoint,
      senderIdentity,
    );

    // 7. Audit
    appendAudit(
      req.senderDID,
      'd2d_send',
      req.recipientDID,
      `type=${req.messageType} id=${messageId} delivered=${delivery.delivered}`,
    );

    if (delivery.delivered || delivery.buffered) {
      commitProviderReservation(providerReservation);
      return {
        sent: true,
        messageId,
        delivered: delivery.delivered,
        buffered: delivery.buffered,
        queued: false,
      };
    }

    // Delivery failed but didn't throw — queue for retry.
    releaseProviderReservation(providerReservation);
    const queueResult = tryEnqueue(req.recipientDID, payloadBytes);
    const deliveryErrorMsg = delivery.error ?? 'delivery_failed';
    appendAudit(
      req.senderDID,
      'd2d_send_queued',
      req.recipientDID,
      `type=${req.messageType} id=${messageId} error=${deliveryErrorMsg} queued=${queueResult.queued}${queueResult.queued ? '' : ' queue_error=' + (queueResult.error ?? 'unknown')}`,
    );
    if (!queueResult.queued) {
      // Outbox full / write error: do NOT lie about queued status. The
      // caller needs to know the message was lost (review #2).
      return {
        sent: true,
        messageId,
        delivered: false,
        buffered: false,
        queued: false,
        error: `${deliveryErrorMsg}; queue_failed: ${queueResult.error ?? 'unknown'}`,
      };
    }
    return {
      sent: true,
      messageId,
      delivered: false,
      buffered: false,
      queued: true,
      error: delivery.error,
    };
  } catch (err) {
    // 6. Network failure → queue in outbox
    releaseProviderReservation(providerReservation);
    const queueResult = tryEnqueue(req.recipientDID, payloadBytes);
    const errMsg = err instanceof Error ? err.message : String(err);
    appendAudit(
      req.senderDID,
      'd2d_send_queued',
      req.recipientDID,
      `type=${req.messageType} id=${messageId} error=${errMsg} queued=${queueResult.queued}${queueResult.queued ? '' : ' queue_error=' + (queueResult.error ?? 'unknown')}`,
    );

    if (!queueResult.queued) {
      return {
        sent: true,
        messageId,
        delivered: false,
        buffered: false,
        queued: false,
        error: `${errMsg}; queue_failed: ${queueResult.error ?? 'unknown'}`,
      };
    }
    return {
      sent: true,
      messageId,
      delivered: false,
      buffered: false,
      queued: true,
      error: errMsg,
    };
  }
}

/**
 * Attempt to enqueue a message in the outbox. Never throws — returns
 * the actual outcome so the send path can propagate "queue full" as a
 * real failure instead of silently reporting `queued: true` (review
 * #2: both failure branches used to swallow `enqueueMessage` errors).
 */
function tryEnqueue(
  recipientDID: string,
  payloadBytes: Uint8Array,
): { queued: true } | { queued: false; error: string } {
  try {
    enqueueMessage(recipientDID, payloadBytes);
    return { queued: true };
  } catch (err) {
    return {
      queued: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Narrow type for the `(peerDID, queryID, capability)` triple carried through the send pipeline. */
type ProviderReservation = { peerDID: string; queryID: string; capability: string };

/** Commit a provider-window reservation on successful delivery. No-op when unset. */
function commitProviderReservation(r: ProviderReservation | null): void {
  if (r === null) return;
  // Consume the one-shot authorisation exactly when we succeed.
  providerWindow().commit(r.peerDID, r.queryID, r.capability);
}

/** Release a provider-window reservation on any failure so a retry can re-reserve. */
function releaseProviderReservation(r: ProviderReservation | null): void {
  if (r === null) return;
  // Release (not commit) so the entry stays live for a retry / parallel
  // response. If we committed here, the next attempt would see no window.
  providerWindow().release(r.peerDID, r.queryID, r.capability);
}

/**
 * Run the service-bypass decision layer for service.* message types.
 *
 * Returns `null` for:
 *   - Non-service traffic (existing gate logic applies).
 *   - `service.query` without a resolver: absence of the resolver means the
 *     caller hasn't asked for public-service bypass, so the normal contact
 *     gate handles it. This prevents a missing-resolver footgun from
 *     silently bypassing the contact check.
 *
 * For `service.response` the bypass runs unconditionally — the authorisation
 * comes from the provider window, not from AppView.
 */
async function evaluateServiceBypass(req: SendRequest): Promise<ServiceBypassDecision | null> {
  if (req.messageType === MsgTypeServiceQuery) {
    if (req.providerServiceResolver === undefined) return null;
    const decision = await evaluateServiceEgressBypass(
      req.messageType,
      req.recipientDID,
      req.body,
      req.providerServiceResolver,
    );
    return decision.kind === 'not-service' ? null : decision;
  }
  if (req.messageType === MsgTypeServiceResponse) {
    const decision = await evaluateServiceEgressBypass(req.messageType, req.recipientDID, req.body);
    return decision.kind === 'not-service' ? null : decision;
  }
  return null;
}
