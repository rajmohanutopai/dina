/**
 * D2D receive pipeline — orchestrate the full inbound message flow.
 *
 * Pipeline:
 *   1. Unseal NaCl-encrypted payload → plaintext DinaMessage JSON
 *   2. Verify Ed25519 signature against sender's verification keys
 *   3. Trust evaluation: blocked → drop, unknown → quarantine, known → proceed
 *   4. Scenario policy: check message type against per-contact deny list
 *   5. Stage to vault (map message type → vault item type) or quarantine
 *   6. Audit log the receive
 *
 * Source: ARCHITECTURE.md Tasks 6.8–6.12
 */

import { unsealMessage, type D2DPayload } from './envelope';
import { verifyMessage } from './signature';
import { checkScenarioGate } from './gates';
import {
  alwaysPasses,
  isValidV1Type,
  validateMessageBody,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
} from './families';
import { receiveAndStage, type ReceiveResult } from './receive';
import { quarantineMessage } from './quarantine';
import { appendAudit } from '../audit/service';
import { isReplayedMessage, recordMessageId } from '../transport/adversarial';
import {
  evaluateServiceIngressBypass,
  type ServiceBypassDecision,
  type LocalCapabilityChecker,
} from '../service/bypass';
import { isCapabilityConfigured } from '../service/service_config';
import { providerWindow, requesterWindow, setProviderWindow } from '../service/windows';
import { WorkflowConflictError } from '../workflow/repository';
import { getWorkflowService } from '../workflow/service';

export type ReceivePipelineAction = 'staged' | 'quarantined' | 'dropped' | 'ephemeral' | 'bypassed';

export interface ReceivePipelineResult {
  action: ReceivePipelineAction;
  messageId?: string;
  messageType?: string;
  senderDID?: string;
  signatureValid: boolean;
  stagingId?: string;
  quarantineId?: string;
  /**
   * Populated when `action === 'bypassed'`. The parsed, validated body —
   * caller (Brain D2D dispatcher) can route directly without re-parsing.
   */
  bypassedBody?: unknown;
  /**
   * Populated when `action === 'staged'` — the raw verified message
   * body string. The pipeline already wrote it into staging; exposing
   * it here saves callers a vault read when they want to fan the
   * same bytes out to a live UI surface (e.g. the chat thread for
   * coordination.request / coordination.response) without racing
   * against async persistence.
   */
  stagedBody?: string;
  reason: string;
}

/** Optional overrides for tests and dependency injection. */
export interface ReceivePipelineOptions {
  /** Defaults to the live `isCapabilityConfigured` from service_config. */
  isCapabilityConfigured?: LocalCapabilityChecker;
}

/**
 * Process an incoming D2D payload through the full receive pipeline.
 *
 * @param payload — the sealed D2D payload { c: base64, s: hex }
 * @param recipientPub — recipient's Ed25519 public key
 * @param recipientPriv — recipient's Ed25519 private key
 * @param senderVerificationKeys — sender's verification public keys (from DID doc)
 * @param senderTrust — sender's trust level (from contact directory)
 */
export function receiveD2D(
  payload: D2DPayload,
  recipientPub: Uint8Array,
  recipientPriv: Uint8Array,
  senderVerificationKeys: Uint8Array[],
  senderTrust: string,
  options: ReceivePipelineOptions = {},
): ReceivePipelineResult {
  // 1. Unseal
  let message;
  let signatureHex: string;
  try {
    const unsealed = unsealMessage(payload, recipientPub, recipientPriv);
    message = unsealed.message;
    signatureHex = unsealed.signatureHex;
  } catch (err) {
    return {
      action: 'dropped',
      signatureValid: false,
      reason: `Unseal failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  // 2. Verify signature
  const signatureValid = verifyMessage(message, signatureHex, senderVerificationKeys);
  if (!signatureValid) {
    appendAudit(message.from, 'd2d_recv_bad_sig', message.to, `id=${message.id}`);
    return {
      action: 'dropped',
      messageId: message.id,
      messageType: message.type,
      senderDID: message.from,
      signatureValid: false,
      reason: 'Signature verification failed',
    };
  }

  // 3. Replay detection (SEC-HIGH-08) — reject already-seen message IDs.
  // Uses sender DID + message ID as the cache key to prevent cross-sender
  // ID collisions. Must come AFTER signature verification to prevent
  // unauthenticated messages from polluting the cache.
  const replayKey = `${message.from}|${message.id}`;
  if (isReplayedMessage(replayKey)) {
    appendAudit(message.from, 'd2d_recv_replay', message.to, `id=${message.id}`);
    return {
      action: 'dropped',
      messageId: message.id,
      messageType: message.type,
      senderDID: message.from,
      signatureValid: true,
      reason: 'Replayed message (already processed)',
    };
  }
  recordMessageId(replayKey);

  // 4. V1 type enforcement — silently drop non-V1 message types.
  // Matches Go's ProcessInbound which rejects non-V1 types (benign drop —
  // still returns 202 to prevent sender fingerprinting). Audit logged.
  if (!isValidV1Type(message.type)) {
    appendAudit(message.from, 'd2d_recv_type_rejected', message.to, `type=${message.type}`);
    return {
      action: 'dropped',
      messageId: message.id,
      messageType: message.type,
      senderDID: message.from,
      signatureValid: true,
      reason: `Non-V1 message type "${message.type}" rejected`,
    };
  }

  // 5. Body size validation — reject oversized message bodies after decryption.
  // Matches Go's ValidateBody() in ProcessInbound (256 KB max).
  const bodyValidationError = validateMessageBody(message.body);
  if (bodyValidationError) {
    appendAudit(message.from, 'd2d_recv_body_oversized', message.to, `id=${message.id}`);
    return {
      action: 'dropped',
      messageId: message.id,
      messageType: message.type,
      senderDID: message.from,
      signatureValid: true,
      reason: bodyValidationError,
    };
  }

  // 5b. Pre-gate: blocked sender is ALWAYS dropped, even for service.* traffic.
  //     Service bypass must never resurrect a blocked sender.
  if (senderTrust === 'blocked') {
    appendAudit(
      message.from,
      'd2d_recv_blocked',
      message.to,
      `type=${message.type} id=${message.id}`,
    );
    return {
      action: 'dropped',
      messageId: message.id,
      messageType: message.type,
      senderDID: message.from,
      signatureValid: true,
      reason: 'Sender is blocked',
    };
  }

  // 5c. Public-service ingress bypass (service.query / service.response).
  //
  // Service traffic bypasses the contacts-only gate under these conditions:
  //   - service.query:    we publish the requested capability locally
  //   - service.response: we have an open requester window for the triple
  //
  // A denied bypass logs the reason and drops the message — the contact gate
  // is NEVER consulted as a fallback because the decision layer has already
  // validated the body and semantics; falling through would produce the
  // same drop with less specific audit.
  if (message.type === MsgTypeServiceQuery || message.type === MsgTypeServiceResponse) {
    const capabilityChecker = options.isCapabilityConfigured ?? isCapabilityConfigured;
    const bypass = evaluateServiceIngressBypass(message.type, message.from, message.body, {
      isCapabilityConfigured: capabilityChecker,
      requester: requesterWindow(),
    });
    return applyServiceIngressDecision(message.type, message, bypass);
  }

  // Determine if sender is an explicit contact with a positive trust level.
  // 'unknown' and '' mean "not a known contact" → quarantine.
  // Only explicit trust levels (verified, trusted, contact_ring1, etc.) proceed.
  // Fix: Codex #15 — 'unknown' was incorrectly treated as contact-equivalent.
  const CONTACT_TRUST_LEVELS = new Set([
    'verified',
    'trusted',
    'contact_ring1',
    'contact_ring2',
    'self',
  ]);
  const isContact = CONTACT_TRUST_LEVELS.has(senderTrust);

  // 6. Trust evaluation + 7. Scenario policy
  // Check scenario policy for known (non-blocked) senders
  if (isContact) {
    if (!alwaysPasses(message.type) && !checkScenarioGate(message.from, message.type)) {
      appendAudit(message.from, 'd2d_recv_scenario_denied', message.to, `type=${message.type}`);
      return {
        action: 'dropped',
        messageId: message.id,
        messageType: message.type,
        senderDID: message.from,
        signatureValid: true,
        reason: `Scenario policy denied message type "${message.type}"`,
      };
    }
  }

  // 8. Stage / quarantine / drop via existing receive module
  const stageResult = receiveAndStage(
    message.type,
    message.from,
    senderTrust,
    message.body,
    message.id,
    isContact,
  );

  // If quarantined, also store in quarantine management
  let quarantineId: string | undefined;
  if (stageResult.action === 'quarantined') {
    const q = quarantineMessage(message.from, message.type, message.body);
    quarantineId = q.id;
  }

  // 6. Audit log
  appendAudit(
    message.from,
    `d2d_recv_${stageResult.action}`,
    message.to,
    `type=${message.type} id=${message.id}`,
  );

  return {
    action: stageResult.action,
    messageId: message.id,
    messageType: message.type,
    senderDID: message.from,
    signatureValid: true,
    stagingId: stageResult.stagingId,
    quarantineId,
    reason: stageResult.reason,
    // Only expose the body when the message actually landed (staged or
    // ephemeral). Quarantined bodies must not leak to live-UI callers
    // without a review decision first.
    stagedBody:
      stageResult.action === 'staged' || stageResult.action === 'ephemeral'
        ? message.body
        : undefined,
  };
}

/**
 * Apply the ingress bypass decision for `service.query` / `service.response`.
 *
 * Allow side-effects (ordered):
 *   - `service.query`:    open a provider window so our reply is authorised.
 *   - `service.response`: consume the requester window (one-shot).
 *
 * The parsed + validated body is returned in `bypassedBody` so the caller
 * (Brain D2D dispatcher) can route without re-parsing. The pipeline never
 * stores service.* traffic — returning `action: 'bypassed'` is the signal
 * for "hand this off to Brain, don't persist".
 */
function applyServiceIngressDecision(
  messageType: string,
  message: { id: string; from: string; to: string; body: string },
  bypass: ServiceBypassDecision,
): ReceivePipelineResult {
  if (bypass.kind === 'deny') {
    appendAudit(
      message.from,
      'd2d_recv_service_denied',
      message.to,
      `type=${messageType} reason=${bypass.reason}`,
    );
    return {
      action: 'dropped',
      messageId: message.id,
      messageType,
      senderDID: message.from,
      signatureValid: true,
      reason: bypass.detail,
    };
  }

  if (bypass.kind === 'not-service') {
    // Defensive branch — the caller only dispatches to this helper for
    // service.* types. If we somehow reached here with a non-service type,
    // fall through to a drop rather than leaking the message.
    return {
      action: 'dropped',
      messageId: message.id,
      messageType,
      senderDID: message.from,
      signatureValid: true,
      reason: 'service bypass returned not-service for service.* traffic',
    };
  }

  // bypass.kind === 'allow'
  const body = bypass.body as {
    query_id: string;
    capability: string;
    ttl_seconds: number;
  };

  if (messageType === MsgTypeServiceQuery) {
    // Open the provider window so our `service.response` is authorised on
    // egress. TTL echoes the requester's window so both sides agree on
    // freshness.
    setProviderWindow(message.from, body.query_id, body.capability, body.ttl_seconds);
    appendAudit(
      message.from,
      'd2d_recv_service_accepted',
      message.to,
      `type=${messageType} id=${message.id} capability=${body.capability}`,
    );
  } else {
    // service.response — consume the requester window. `peek` in the
    // decision layer confirmed it exists; `checkAndConsume` makes it
    // one-shot. Racing consumers lose here.
    const consumed = requesterWindow().checkAndConsume(
      message.from,
      body.query_id,
      body.capability,
    );
    if (!consumed) {
      // Lost the race to another handler (extremely unlikely with the
      // single-threaded receive pipeline, but defend anyway).
      appendAudit(
        message.from,
        'd2d_recv_service_denied',
        message.to,
        `type=${messageType} reason=no_window_after_peek`,
      );
      return {
        action: 'dropped',
        messageId: message.id,
        messageType,
        senderDID: message.from,
        signatureValid: true,
        reason: 'requester window consumed by another handler',
      };
    }

    // If there's an outstanding `service_query` workflow task, complete it
    // with the response body. Completion emits a `completed` workflow_event
    // whose details Brain consumes via the delivery scheduler.
    //
    // Failures here are NON-FATAL for the bypass: the response has already
    // been delivered in the ingress sense, and Brain will still observe it
    // via the dispatcher. Logging lets operators diagnose stuck tasks.
    completeMatchingServiceQueryTask(message, body);

    appendAudit(
      message.from,
      'd2d_recv_service_accepted',
      message.to,
      `type=${messageType} id=${message.id} capability=${body.capability}`,
    );
  }

  return {
    action: 'bypassed',
    messageId: message.id,
    messageType,
    senderDID: message.from,
    signatureValid: true,
    bypassedBody: body,
    reason: 'service bypass accepted',
  };
}

/**
 * CORE-P2-I03/I04 — find the outstanding `service_query` task matching the
 * `(peerDID, queryId, capability)` triple and complete it with the response
 * body. Emits a `completed` event with the structured `details` Brain
 * expects (`response_status`, `capability`, `service_name`).
 *
 * Silently no-ops when:
 *   - No workflow service is wired (tests that don't need completion).
 *   - No matching live task exists (race: task expired, or was completed
 *     by a parallel response that landed first).
 *
 * Logs via audit on `duplicate_correlation` (data-integrity violation).
 */
function completeMatchingServiceQueryTask(
  raw: { id: string; from: string; to: string; body: string },
  body: { query_id: string; capability: string; ttl_seconds: number },
): void {
  const service = getWorkflowService();
  if (service === null) return;

  const nowSec = Math.floor(Date.now() / 1000);
  let task;
  try {
    task = service.store().findServiceQueryTask(body.query_id, raw.from, body.capability, nowSec);
  } catch (err) {
    if (err instanceof WorkflowConflictError) {
      // >1 live match — audit it and bail. The response has already been
      // bypass-authorised; Brain will still see it via the dispatcher, so
      // we don't reject the bypass over a storage-layer integrity issue.
      appendAudit(
        raw.from,
        'd2d_recv_service_duplicate_correlation',
        raw.to,
        `query_id=${body.query_id} capability=${body.capability}`,
      );
      return;
    }
    throw err;
  }
  if (task === null) return;

  // Parse the payload so we can surface service_name in the event details
  // — consumers (chat/notification formatters) use it to render "Bus 42 —
  // 45 minutes away". The payload is trusted (our own Core wrote it).
  let serviceName = '';
  try {
    const payload = JSON.parse(task.payload) as { service_name?: string };
    if (typeof payload.service_name === 'string') {
      serviceName = payload.service_name;
    }
  } catch {
    /* malformed payload — tolerate; serviceName defaults to '' */
  }

  // Parse the body JSON for `response_status`, `error`, and the full
  // result. The body was already validated by the ingress-bypass decision
  // layer, so a second parse here is cheap + safe.
  let responseStatus = 'success';
  let errorText: string | undefined;
  try {
    const parsed = JSON.parse(raw.body) as { status?: string; error?: string };
    if (typeof parsed.status === 'string') responseStatus = parsed.status;
    if (typeof parsed.error === 'string') errorText = parsed.error;
  } catch {
    /* body shouldn't be unparseable at this point; default response_status */
  }

  // Carry `error` on event details so the consumer-side formatter can
  // surface a meaningful message instead of a generic fallback (issue #12).
  const eventDetails = JSON.stringify({
    response_status: responseStatus,
    capability: body.capability,
    service_name: serviceName,
    error: errorText,
  });
  service.store().completeWithDetails(
    task.id,
    '',
    'received',
    raw.body, // full service.response JSON as the task result
    eventDetails,
    Date.now(),
  );
}
