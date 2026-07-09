/**
 * Pending-preflight store for the first-run Contact Services flow (CONTACT
 * review #2 + #1).
 *
 * When the owner asks a contact for a relationship service we have NO stored
 * offer for, the Talk handler sends a `service.grant_request` preflight and
 * returns a neutral ack. For a close contact the peer auto-grants and a
 * `service.offer` comes back seconds later — but by then the owner's original
 * intent (the params they typed) is gone, so without this they'd have to ask a
 * second time.
 *
 * We stash the original intent here, keyed by the preflight's `request_id`
 * (review #1: correlate to the EXACT request, not just contact+capability — an
 * unrelated/proactive offer must NOT replay a stale intent). The boot subscribes
 * to the inbound-offer event and, when the offer echoes our `request_id`, DRAINS
 * the matching stash to auto-replay the original `service.query`.
 *
 * SECURITY (confused-deputy): the offer's `request_id` is sender-controlled
 * inner-body data. `take` therefore also requires the transport-authenticated
 * sender DID to match the contact we sent the request to — the request_id alone
 * is never treated as proof. A request_id is unguessable (16 random bytes sealed
 * to the recipient), so this is defence-in-depth, but it is cheap and correct.
 *
 * In-memory by design: the round-trip is seconds for an auto-granting contact,
 * and a restart mid-flight degrades gracefully (the offer is still stored, so a
 * later manual ask uses it). The TTL bounds a stale stash from firing later.
 */

/** Default stash lifetime — generous enough for a D2D round-trip, short enough
 *  that a stale intent never auto-fires long after the owner moved on. */
export const PENDING_PREFLIGHT_TTL_SECONDS = 120;

export interface PendingPreflight {
  /** The free-text intent the owner typed (e.g. "find a time next week"). */
  intent: string;
}

interface StashEntry extends PendingPreflight {
  /** The contact the grant_request was sent to (must match the offer sender). */
  contactDID: string;
  expiresAtMs: number;
}

const store = new Map<string, StashEntry>();

function nowMs(): number {
  return Date.now();
}

/**
 * Remember the owner's original intent for a first-run request so the arriving
 * offer (echoing this `requestId`) can replay it. Keyed by request_id; the
 * contact DID is stored so replay can verify the offer came from the same
 * contact. No-op on a degenerate key.
 */
export function stashPendingPreflight(
  requestId: string,
  contactDID: string,
  intent: string,
  ttlSeconds: number = PENDING_PREFLIGHT_TTL_SECONDS,
): void {
  if (requestId === '' || contactDID === '') return;
  store.set(requestId, {
    intent,
    contactDID,
    expiresAtMs: nowMs() + ttlSeconds * 1000,
  });
}

/**
 * Take (and remove) the pending preflight for `requestId` if one exists, hasn't
 * expired, AND was sent to `expectedContactDID` (the transport-authed offer
 * sender). Returns null otherwise. Removing on read makes the replay fire AT
 * MOST once even if the peer delivers the offer twice.
 */
export function takePendingPreflight(
  requestId: string,
  expectedContactDID: string,
): PendingPreflight | null {
  if (requestId === '') return null;
  const entry = store.get(requestId);
  if (entry === undefined) return null;
  if (entry.expiresAtMs < nowMs()) {
    store.delete(requestId); // expired — drop it, no replay
    return null;
  }
  // Confused-deputy guard: the offer's request_id must come from the SAME
  // contact we sent the request to. A MISMATCH must NOT consume the stash —
  // otherwise a foreign offer that happens to reuse the request_id would evict
  // it and the LEGITIMATE contact's later offer would find nothing to replay.
  // So leave the entry in place and just decline this offer.
  if (entry.contactDID !== expectedContactDID) return null;
  // Legitimate consumption — remove so the replay fires AT MOST once even if
  // the trusted peer delivers the offer twice.
  store.delete(requestId);
  return { intent: entry.intent };
}

/** Drop everything — tests + teardown. */
export function resetPendingPreflights(): void {
  store.clear();
}
