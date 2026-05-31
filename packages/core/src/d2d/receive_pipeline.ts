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

import { appendAudit } from '../audit/service';
import {
  evaluateServiceIngressBypass,
  type ServiceBypassDecision,
  type LocalCapabilityChecker,
  type RequesterWindowView,
} from '../service/bypass';
import { isCapabilityConfigured } from '../service/service_config';
import { requesterWindow, setProviderWindow } from '../service/windows';
import { isReplayedMessage, recordMessageId } from '../transport/adversarial';
import { WorkflowConflictError } from '../workflow/repository';
import { getWorkflowService } from '../workflow/service';

import { unsealMessage, type D2DPayload } from './envelope';
import {
  alwaysPasses,
  isValidV1Type,
  validateMessageBody,
  MsgTypeServiceQuery,
  MsgTypeServiceResponse,
} from './families';
import { checkScenarioGate } from './gates';
import { quarantineMessage } from './quarantine';
import { receiveAndStage } from './receive';
import { verifyMessage } from './signature';

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
  /**
   * The sender's `created_time` from the verified DinaMessage envelope
   * (Unix milliseconds). Receivers use this for chronological ordering
   * in the chat thread instead of receive-time, so a multi-message
   * burst that arrives via MsgBox replay-on-reconnect renders in the
   * order the sender intended. Receive-time still sorts within the
   * same sender-clock millisecond. MT-19-I2.
   */
  senderCreatedTime?: number;
  reason: string;
}

/** Optional overrides for tests and dependency injection. */
export interface ReceivePipelineOptions {
  /** Defaults to the live `isCapabilityConfigured` from service_config. */
  isCapabilityConfigured?: LocalCapabilityChecker;
  /**
   * The DID the TRANSPORT authenticated for this message — i.e. the MsgBox
   * envelope's `from_did`, the same DID against which `senderVerificationKeys`
   * and `senderTrust` were resolved. EVERY transport-facing caller MUST pass
   * this (the production `handleInboundD2D` does). When set, the pipeline
   * enforces `message.from === authenticatedFromDID` after signature
   * verification: the signature alone only proves "the owner of the verified
   * key signed these bytes", NOT that the sealed inner `from` matches the
   * authenticated peer — without this binding an attacker could sign with
   * their OWN key while claiming a trusted peer's DID in `from` and inherit
   * that peer's trust level + vault attribution. Mirrors the RPC path's
   * identity binding in relay/msgbox_handlers.ts. Pure-pipeline unit tests
   * omit it (there is no transport envelope to bind to).
   */
  authenticatedFromDID?: string;
  /**
   * The DID the TRANSPORT authenticated as the DELIVERY RECIPIENT — i.e. the
   * MsgBox envelope's `to_did` (the relay routed this frame to us). This is the
   * ONLY trustworthy "who is this addressed to" signal: the inner
   * `message.to` lives inside the sender-signed body and is entirely
   * sender-chosen, so it must NEVER be used as an authorization authority.
   * Used for the `service.query` chosen-listing bind (service_uri authority
   * must equal this) and the inner-recipient consistency check. EVERY
   * transport-facing caller MUST pass it (production `handleInboundD2D` passes
   * `env.to_did`). Omitted ⇒ those binds are skipped (pure-pipeline unit tests
   * with no transport envelope), mirroring `authenticatedFromDID`.
   */
  authenticatedToDID?: string;
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

  // 2b. Sender binding (transport authenticity). A valid signature only
  // proves the owner of `senderVerificationKeys` signed these bytes — it does
  // NOT prove the sealed inner `message.from` is the DID the transport
  // authenticated. The keys + trust were resolved from the envelope's
  // `from_did`, so require the inner `from` to equal it; otherwise an attacker
  // could sign with their OWN key while putting a trusted peer's DID in `from`
  // and inherit that peer's trust + vault attribution (origin_did/sender_did).
  // Drop + audit on mismatch, before the replay cache is touched. Mirrors the
  // RPC path's binding check in relay/msgbox_handlers.ts.
  const authedFrom = options.authenticatedFromDID;
  if (authedFrom !== undefined && authedFrom !== '' && message.from !== authedFrom) {
    appendAudit(
      authedFrom,
      'd2d_recv_sender_mismatch',
      message.to,
      `claimed_from=${message.from} id=${message.id}`,
    );
    return {
      action: 'dropped',
      messageId: message.id,
      messageType: message.type,
      senderDID: message.from,
      signatureValid: true,
      reason: 'Inner sender does not match the authenticated transport DID',
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
    // SECURITY (the chosen-listing bind authority): use the TRANSPORT-
    // authenticated delivery recipient — the MsgBox envelope's `to_did`,
    // threaded in as `authenticatedToDID` — NOT the inner `message.to`. The
    // inner `to` lives in the sender-signed body and is entirely sender-chosen,
    // so binding `service_uri` to it is no bind at all: an attacker delivers an
    // envelope to US but sets inner `to` == `service_uri.did` (their own DID)
    // and it would pass (confused deputy). When `authenticatedToDID` is omitted
    // (pure-pipeline unit tests with no transport envelope) the binds below are
    // skipped, mirroring `authenticatedFromDID`.
    const authedTo = options.authenticatedToDID;

    // Inner-recipient consistency (service.query): an envelope the relay
    // delivered to US must carry an inner message addressed to exactly US —
    // a single recipient equal to `authedTo`. An inner `to` naming a different
    // (or additional) DID is a routing/spoof attempt → drop. Only enforced when
    // we actually know the authenticated delivery target.
    if (message.type === MsgTypeServiceQuery && authedTo !== undefined) {
      const innerTo = Array.isArray(message.to) ? message.to : [message.to];
      if (innerTo.length !== 1 || innerTo[0] !== authedTo) {
        appendAudit(
          message.from,
          'd2d_recv_service_denied',
          authedTo,
          `type=${message.type} reason=inner_to_mismatch id=${message.id}`,
        );
        return {
          action: 'dropped',
          messageId: message.id,
          messageType: message.type,
          senderDID: message.from,
          signatureValid: true,
          reason: `service.query inner recipient does not match authenticated delivery DID ${authedTo}`,
        };
      }
    }

    const bypass = evaluateServiceIngressBypass(message.type, message.from, message.body, {
      isCapabilityConfigured: capabilityChecker,
      // P1.2: durable-backed requester window. The in-memory window is the
      // fast path; on a miss (e.g. Core restarted between query and
      // response) `peek` falls back to the durable `service_query`
      // workflow task, so a legitimate response isn't denied just because
      // the process bounced. See `durableRequesterWindow`.
      requester: durableRequesterWindow(),
      // Bind a service.query's chosen listing to the AUTHENTICATED delivery
      // recipient — a direct peer must not send service_uri: at://<otherdid>/…
      // and have it pass. Same authority bind as the Core HTTP route's to_did.
      recipientDID: authedTo,
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
    // Forward the verified sender's wire timestamp so chat-side
    // surfaces can order messages chronologically instead of by
    // receive-time. Only meaningful when the action carried a body.
    senderCreatedTime:
      stageResult.action === 'staged' || stageResult.action === 'ephemeral'
        ? message.created_time
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
    // decision layer confirmed authorization (in-memory window OR a live
    // durable service_query task); `checkAndConsume` makes the in-memory
    // window one-shot. Racing consumers lose here.
    const consumed = requesterWindow().checkAndConsume(
      message.from,
      body.query_id,
      body.capability,
    );
    if (!consumed) {
      // No in-memory window to consume. Two cases:
      //   (a) Core restarted between query and response — the window was
      //       lost but a live DURABLE service_query task still authorizes
      //       this response (P1.2). The one-shot guard then becomes the
      //       durable completion below: `completeMatchingServiceQueryTask`
      //       transitions the task to terminal, so a replayed response
      //       finds no live task on the next pass.
      //   (b) A genuine race / no live task → deny (fail-closed).
      const service = getWorkflowService();
      let durableLive = false;
      if (service !== null) {
        const nowSec = Math.floor(Date.now() / 1000);
        try {
          durableLive =
            service.store().findServiceQueryTask(
              body.query_id,
              message.from,
              body.capability,
              nowSec,
            ) !== null;
        } catch {
          durableLive = false; // conflict / fault → do not authorize on doubt
        }
      }
      if (!durableLive) {
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
      appendAudit(
        message.from,
        'd2d_recv_service_accepted_durable',
        message.to,
        `type=${messageType} id=${message.id} capability=${body.capability} via=durable_task`,
      );
    }

    // If there's an outstanding `service_query` workflow task, complete it
    // with the response body. Completion emits a `completed` workflow_event
    // whose details Brain consumes via the delivery scheduler. It also
    // transitions the durable task to terminal, which is the one-shot
    // guard for the restart-recovery path above (a replay finds no live
    // task).
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
 * P1.2 — durable-backed requester window for `service.response` ingress.
 *
 * The in-memory `requesterWindow()` authorizes a response by remembering
 * the `(peerDID, queryID, capability)` triple of an outbound query. That
 * memory is lost on restart, so a legitimate response that arrives after a
 * crash/reboot was being denied (`no_window`) — an availability bug, not a
 * security one: nothing leaked, the reply was just dropped.
 *
 * The fix: the SAME triple is also recorded DURABLY as a `service_query`
 * workflow task (written by `/v1/service/query` before send, survives
 * restart). `peek` consults the in-memory window first (fast path), then
 * falls back to `findServiceQueryTask`, which only matches a task that is
 * still LIVE (kind=service_query, status created/running, not expired, and
 * the payload's `to_did`+`capability` match the triple) — i.e. exactly the
 * same authorization scope as the window, just persisted.
 *
 * One-shot semantics are preserved by the EXISTING durable completion:
 * after the response is accepted, `completeMatchingServiceQueryTask`
 * transitions the task to a terminal status, so a second (replayed)
 * response no longer finds a live task. The durable fallback never relaxes
 * the gate — an unknown/expired/terminal query still yields `no_window`.
 */
function durableRequesterWindow(): RequesterWindowView {
  return {
    peek(peerDID: string, queryID: string, capability: string): boolean {
      // Fast path: live in-memory window (same process, no restart).
      if (requesterWindow().peek(peerDID, queryID, capability)) {
        return true;
      }
      // Durable fallback: an outstanding, non-expired service_query task
      // for this exact triple. Returns false on no workflow service
      // (tests / minimal stacks) or any storage error — fail-closed.
      const service = getWorkflowService();
      if (service === null) return false;
      const nowSec = Math.floor(Date.now() / 1000);
      try {
        return service.store().findServiceQueryTask(queryID, peerDID, capability, nowSec) !== null;
      } catch {
        // >1 live match (WorkflowConflictError) or storage fault → do not
        // authorize on doubt. The contact gate stays closed; the
        // legitimate caller can retry once the integrity issue clears.
        return false;
      }
    },
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
