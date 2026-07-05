/**
 * `service.offer`-received event surface.
 *
 * When a contact's Dina delivers a `service.offer` (the reply to our
 * `service.grant_request` preflight, or a proactive grant), the receive pipeline
 * persists it (so a later query can use it) and EMITS this event. The mobile boot
 * subscribes so a FIRST-RUN request that had no stored offer can be auto-replayed
 * the instant the grant lands — the requester's original intent isn't dropped,
 * and a close contact never has to ask twice (CONTACT review #2).
 *
 * The event carries only the non-secret selectors the replay needs: the provider
 * DID (transport-authenticated by the receive pipeline), the capability, and the
 * offer fields a `service.query` must echo (grant id, service uri, name, schema
 * hash, default ttl). No vault data, no requester PII.
 *
 * Mirrors `grant_request_events`: listener errors are swallowed so one broken
 * subscriber can't break D2D ingress.
 */

export interface ServiceOfferReceivedEvent {
  /** The contact who granted (the offer's provider). Transport-authed. */
  providerDID: string;
  /** Canonical capability the offer covers. */
  capability: string;
  /** Minted grant id the subsequent `service.query` must carry. */
  grantId: string;
  /** `at://…` service uri the query routes to. */
  serviceUri: string;
  /** Provider-supplied display name (untrusted; rendered as a plain label). */
  serviceName: string;
  /** Optional params/result schema hash, '' when absent. */
  schemaHash: string;
  /** Optional provider default TTL (seconds) for the query, when supplied. */
  defaultTtlSeconds?: number;
  /**
   * The originating `service.grant_request.request_id` echoed back, when this
   * offer is an auto-grant reply. Present → the requester can correlate it to the
   * exact request it made and auto-replay only that one. Absent on proactive /
   * owner-pushed offers (no replay). SENDER-CONTROLLED inner-body data — a
   * consumer MUST also match the transport-authed `providerDID`, never trust the
   * request_id alone.
   */
  requestId?: string;
}

export type ServiceOfferReceivedListener = (event: ServiceOfferReceivedEvent) => void;

const listeners = new Set<ServiceOfferReceivedListener>();

/**
 * Subscribe to inbound `service.offer` deliveries. Returns a disposer. Errors
 * thrown by a listener are swallowed (never re-thrown onto the receive path),
 * matching the grant-request channel's discipline.
 */
export function onServiceOfferReceived(listener: ServiceOfferReceivedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Emit an offer-received event to all subscribers. Fire-and-forget. */
export function emitServiceOfferReceived(event: ServiceOfferReceivedEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      /* a broken subscriber must not break D2D ingress */
    }
  }
}

/** Reset module state — tests only. */
export function resetServiceOfferReceivedListeners(): void {
  listeners.clear();
}
