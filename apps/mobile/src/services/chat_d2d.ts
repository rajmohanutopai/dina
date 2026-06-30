/**
 * Peer-to-peer chat egress — the "send" side of the per-peer thread UI.
 *
 * Wraps Core's `D2DSender` with two extras the raw sender doesn't
 * give you:
 *
 *   1. An optimistic local echo: the user's outgoing bubble appears
 *      in `thread(peerDID)` as soon as `sendChatMessage` is called,
 *      before the wire round-trip completes. The UI reads from the
 *      thread, so this is what makes sends feel instant.
 *   2. A wire body shape the peer's inbound handler understands. We
 *      serialise `{ text }` into the D2D body; the receiving side's
 *      `extractChatText` pulls it back out. Non-Dina peers that send
 *      a raw string fall through the same path — `extractChatText`
 *      treats a non-JSON body as verbatim text.
 *
 * The wire type is `coordination.request` — a valid V1 family member
 * that fits free-form peer text (main-dina's d2d/families.go closed
 * set has no dedicated "chat" type). Replies from the other side
 * arrive as `coordination.request` or `coordination.response`; the
 * inbound filter in `bootstrap.ts` accepts both.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  addMessage,
  addLifecycleMessage,
  updateMessageMetadataById,
  type ChatMessage,
  type ServiceQueryLifecycle,
} from '@dina/brain/chat';
import {
  getD2DSender,
  MsgTypeCoordinationRequest,
  MsgTypeServiceGrantRequest,
} from '@dina/core/d2d';

import type { ServiceGrantRequestBody } from '@dina/protocol';

/**
 * Outbound delivery state for the peer-side chat bubble. Drives the
 * tick / spinner / exclamation icon next to the user's message and
 * lets the renderer pick a tooltip ("Sending…", "Delivered to relay",
 * "Couldn't deliver"). MT-19-I1.
 */
export type D2DDeliveryStatus = 'sending' | 'delivered' | 'failed';

export class ChatSendError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ChatSendError';
  }
}

// ---------------------------------------------------------------------------
// Talk-initiated peer service invoke (Contact Services, CONTACT_SERVICES_
// ARCHITECTURE.md §7 seam 5).
//
// A scheduling intent in a Talk thread (e.g. "find a time with Sancho") must
// fire a `service.query` to the THREAD'S contact and render a status-tracked
// card in THAT thread. The hard requirement (no workaround) is RESPONSE
// CORRELATION: the peer's `service.response` has to patch the same card. The
// only path that gives us that is the existing requester-side workflow-task
// pipeline — `ServiceQueryOrchestrator.issueQueryToDID` calls Core's
// `POST /v1/service/query`, which mints a `service_query` workflow task with a
// DETERMINISTIC `task_id` and stamps `origin_channel` onto the payload. The
// `WorkflowEventConsumer` → `createServiceQueryDeliverer` then patches the card
// keyed by that `task_id`, routing to the thread the `threadResolver` maps the
// `origin_channel` to (seam 4 sets that resolver to the peer DID).
//
// So `sendServiceQuery` does NOT hand-roll a `service.query` + a free-standing
// `addLifecycleMessage`. It drives the orchestrator (which sends the wire
// message AND creates the correlating task), then posts the pending card with
// the orchestrator-returned `taskId`. `originChannel = peerDID` so the response
// lands back in this Talk thread.
// ---------------------------------------------------------------------------

/**
 * Minimal structural slice of `ServiceQueryOrchestrator.issueQueryToDID` —
 * everything `sendServiceQuery` needs. Injected so the function is testable
 * without booting a node, mirroring `getD2DSender` / `setD2DSender`.
 */
export interface ServiceQueryDispatcher {
  issueQueryToDID(req: {
    toDID: string;
    capability: string;
    params: unknown;
    ttlSeconds?: number;
    schemaHash?: string;
    serviceName?: string;
    originChannel?: string;
    serviceUri?: string;
    grantId?: string;
  }): Promise<{ queryId: string; taskId: string; toDID: string; serviceName: string }>;
}

let dispatcherInstance: ServiceQueryDispatcher | null = null;

/** Install the live node's orchestrator (boot) or a stub (tests). `null` clears. */
export function setServiceQueryDispatcher(d: ServiceQueryDispatcher | null): void {
  dispatcherInstance = d;
}

/** Read the installed dispatcher. */
export function getServiceQueryDispatcher(): ServiceQueryDispatcher | null {
  return dispatcherInstance;
}

/**
 * A `service.offer` resolved from `contact_service_offers` — the grant +
 * listing a peer previously offered for this capability. Carries the
 * `grant_id` + `service_uri` a `known_only` listing's ingress requires.
 */
export interface PeerServiceOffer {
  grantId: string;
  serviceUri: string;
  serviceName?: string;
  schemaHash?: string;
  defaultTtlSeconds?: number;
}

export interface SendServiceQueryOptions {
  /**
   * The offer (grant + listing) to exercise. Required-in-effect: a `talk`
   * relationship service is `known_only`, so its ingress hard-requires a
   * `grant_id`. The caller (seam 2 / the suggestion chip) resolves this from
   * `coreClient.listServiceOffers({ providerDid, capability })` before calling.
   */
  offer?: PeerServiceOffer;
  /** Display label for the card + audit. Falls back to the offer's name. */
  serviceName?: string;
  /** TTL override (seconds); defaults to the capability default. */
  ttlSeconds?: number;
}

/**
 * Send a `service.query` to the Talk thread's contact and post a pending,
 * response-correlating `service_query` card in that peer's thread.
 *
 * Throws `ChatSendError` when the orchestrator isn't wired (node down) or the
 * dispatch fails. On dispatch failure the thread also gets a standalone error
 * row, matching `sendChatMessage`'s visible-failure contract.
 *
 * Returns the pending lifecycle `ChatMessage` so the caller can scroll to it.
 */
export async function sendServiceQuery(
  peerDID: string,
  capability: string,
  params: Record<string, unknown>,
  options: SendServiceQueryOptions = {},
): Promise<ChatMessage> {
  if (peerDID === '') {
    throw new ChatSendError('peerDID is required');
  }
  const cap = capability.trim();
  if (cap === '') {
    throw new ChatSendError('capability is required');
  }

  const dispatcher = dispatcherInstance;
  if (dispatcher === null) {
    throw new ChatSendError('service-query dispatcher not wired — bring the node up before sending');
  }

  const offer = options.offer;
  const serviceName =
    options.serviceName ?? offer?.serviceName ?? cap;

  // TTL precedence: explicit override > the offer's `defaultTtlSeconds` (the
  // provider published it on the listing) > the orchestrator's capability
  // default. Forwarding the offer's TTL keeps the requester's window aligned
  // with what the provider expects to honour. P3-b.
  const ttlSeconds =
    options.ttlSeconds ??
    (offer?.defaultTtlSeconds !== undefined && offer.defaultTtlSeconds > 0
      ? offer.defaultTtlSeconds
      : undefined);

  let dispatch: { queryId: string; taskId: string; toDID: string; serviceName: string };
  try {
    dispatch = await dispatcher.issueQueryToDID({
      toDID: peerDID,
      capability: cap,
      params,
      // origin_channel = the peer thread, so the response patches HERE
      // (seam 4's threadResolver maps origin_channel → peer DID).
      originChannel: peerDID,
      serviceName,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      ...(offer !== undefined
        ? {
            serviceUri: offer.serviceUri,
            grantId: offer.grantId,
            ...(offer.schemaHash !== undefined && offer.schemaHash !== ''
              ? { schemaHash: offer.schemaHash }
              : {}),
          }
        : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    addMessage(peerDID, 'error', `Couldn't start the request: ${reason}`, {
      metadata: { source: 'd2d', peerDID },
    });
    throw new ChatSendError(`service query failed: ${reason}`, err);
  }

  // Guard: a non-empty taskId is the card's correlation key — `readLifecycle`
  // drops a lifecycle whose taskId is '' AND the WorkflowEventConsumer can never
  // patch it. Posting a card with an empty taskId would leave a PERMANENTLY
  // stuck "Asking…" bubble the response can't resolve. A well-behaved Core
  // route always returns one, so an empty taskId is a contract violation —
  // surface it as an error row + throw rather than ship a dead card.
  if (dispatch.taskId === '') {
    addMessage(peerDID, 'error', `Couldn't track the request — please try again.`, {
      metadata: { source: 'd2d', peerDID },
    });
    throw new ChatSendError('service query returned no task id (uncorrelatable)');
  }

  // Post the pending card into the PEER thread, keyed by the orchestrator's
  // `taskId` (a non-empty string — `readLifecycle` drops it otherwise, and the
  // WorkflowEventConsumer patches by exactly this id). When the peer replies,
  // `createServiceQueryDeliverer` finds THIS message via `findMessageByTaskId`
  // and flips it to resolved — one card, correlated end-to-end.
  const lifecycle: ServiceQueryLifecycle = {
    kind: 'service_query',
    status: 'pending',
    taskId: dispatch.taskId,
    queryId: dispatch.queryId,
    capability: cap,
    serviceName: dispatch.serviceName !== '' ? dispatch.serviceName : serviceName,
    providerDid: peerDID,
    params,
    // Contact (relationship / known_only) service — gates the collapsed-failure
    // rule so a negative outcome never leaks the grantor's decision or the
    // requester's social rank (CONTACT_SERVICES_ARCHITECTURE.md §2/§10).
    relationship: true,
  };
  return addLifecycleMessage(peerDID, `Asking ${serviceName}…`, lifecycle);
}

// ---------------------------------------------------------------------------
// Requester-initiated grant-request preflight (Contact Services §5.2).
//
// When the requester has NO stored `service.offer` for a relationship service,
// it cannot send a `service.query` (a `known_only` listing's ingress
// hard-requires a `grant_id`) and it cannot name the provider's PRIVATE rkey
// (it doesn't know it — that's the whole point of §5.2). So it sends a
// `service.grant_request` naming only the CAPABILITY + `requested_surface:'talk'`.
// The provider's `handleServiceGrantRequest` resolves the matching talk listing,
// applies the closeness/default-offerable policy, and replies with a
// `service.offer { service_uri, grant_id }` (auto_grant) or surfaces an
// ask_to_enable prompt. The offer is stored in `contact_service_offers` on
// receive, so a later `sendServiceQuery` retry can fire with the grant.
//
// This is the missing requester-side SEND that lets the bootstrap start from
// the app (the receive side was already built).
// ---------------------------------------------------------------------------

/**
 * Send a `service.grant_request` preflight to `peerDID` for `capability`. The
 * body carries ONLY the capability + an optional intent + `requested_surface:
 * 'talk'` — never an rkey (the requester can't know the provider's private
 * listing). Throws `ChatSendError` when the D2D sender isn't wired or the send
 * fails. Returns the generated `request_id` — the auto-grant `service.offer`
 * reply echoes it back, so the caller can stash it and replay the originating
 * request against exactly that grant (see `ServiceGrantRequestBody.request_id`).
 */
export async function sendGrantRequest(
  peerDID: string,
  capability: string,
  intent?: string,
): Promise<{ requestId: string }> {
  if (peerDID === '') {
    throw new ChatSendError('peerDID is required');
  }
  const cap = capability.trim();
  if (cap === '') {
    throw new ChatSendError('capability is required');
  }
  const sender = getD2DSender();
  if (sender === null) {
    throw new ChatSendError('D2D sender not wired — bring the node up before sending');
  }

  const requestId = bytesToHex(randomBytes(16));
  const trimmedIntent = intent?.trim();
  const body: ServiceGrantRequestBody = {
    request_id: requestId,
    capability: cap,
    requested_surface: 'talk',
    ...(trimmedIntent !== undefined && trimmedIntent !== '' ? { intent: trimmedIntent } : {}),
  };

  try {
    await sender(peerDID, MsgTypeServiceGrantRequest, body as unknown as Record<string, unknown>);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ChatSendError(`grant request failed: ${reason}`, err);
  }
  return { requestId };
}

/**
 * Send a chat message to a peer by DID.
 *
 * Mutates the thread keyed by `peerDID` with the outgoing bubble
 * first, then invokes Core's installed D2D sender. Throws
 * `ChatSendError` if the sender isn't wired yet (node not started)
 * or the underlying send fails.
 *
 * On failure, appends a separate `error`-type message to the thread
 * so the user sees the outgoing bubble followed by a failure note
 * rather than a phantom "sent" that actually never hit the wire.
 */
export async function sendChatMessage(peerDID: string, text: string): Promise<ChatMessage> {
  if (peerDID === '') {
    throw new ChatSendError('peerDID is required');
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new ChatSendError('text is required');
  }

  const sender = getD2DSender();
  if (sender === null) {
    throw new ChatSendError('D2D sender not wired — bring the node up before sending');
  }

  // Optimistic local echo. `deliveryStatus: 'sending'` drives the
  // pending spinner on the chat bubble; we patch it to 'delivered'
  // or 'failed' once the wire round-trip resolves. MT-19-I1.
  const status: D2DDeliveryStatus = 'sending';
  const msg = addMessage(peerDID, 'user', trimmed, {
    metadata: { source: 'd2d', peerDID, deliveryStatus: status },
  });

  try {
    await sender(peerDID, MsgTypeCoordinationRequest, { text: trimmed });
    updateMessageMetadataById(peerDID, msg.id, {
      deliveryStatus: 'delivered' satisfies D2DDeliveryStatus,
    });
    return msg;
  } catch (err) {
    // Leave the user bubble in place (it was optimistic but the user
    // DID type these words) and flip its status to 'failed' so the
    // bubble itself reflects the outcome — a separate error line
    // also appends so the failure is visible standalone.
    const reason = err instanceof Error ? err.message : String(err);
    updateMessageMetadataById(peerDID, msg.id, {
      deliveryStatus: 'failed' satisfies D2DDeliveryStatus,
      deliveryError: reason,
    });
    addMessage(peerDID, 'error', `Couldn't deliver: ${reason}`, {
      metadata: { source: 'd2d', peerDID, failedMessageId: msg.id },
    });
    throw new ChatSendError(`send failed: ${reason}`, err);
  }
}
