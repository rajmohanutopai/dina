/**
 * §8b (PHOTO_COMMERCE_LANES_DESIGN) — observability, metadata-only, BOTH
 * lanes. Named events carrying ids, states, counts and latencies ONLY.
 *
 * THE TYPE IS THE ENFORCEMENT: every field below is an identifier, a state
 * name, a count or a duration. Image bytes, extracted values, quantities,
 * prices and free text have no field to ride in — adding one is the review
 * comment this header exists to draw. This is the codebase's
 * PII-never-in-logs rule given a shape, not a new policy.
 *
 * The sink is installed by the composition root (a logger on the server, a
 * dev overlay on the phone, nothing in tests unless a test asks). An
 * observer must never break the lane it observes: every emit is fenced.
 */

export type CommerceEventName =
  | 'photo_capture'
  | 'ingest_refusal'
  | 'extraction'
  | 'egress_authorization'
  | 'confirm'
  | 'send'
  | 'quote_received'
  | 'quote_declined'
  | 'approval'
  | 'dispatch_outcome'
  | 'reconcile';

export interface CommerceEvent {
  event: CommerceEventName;
  lane: 'catalog' | 'order';
  atMs: number;
  draftId?: string;
  conversationId?: string;
  supplierDid?: string;
  /** A state or class NAME (`quoted`, `dispatch_refused`, `uncertain`). */
  state?: string;
  /** A typed refusal key, never a message. */
  refusal?: string;
  /** Pages, lines, rows — a count, never their content. */
  count?: number;
  latencyMs?: number;
}

export type CommerceObserver = (event: CommerceEvent) => void;

let sink: CommerceObserver | null = null;

/** Composition-root install; null restores silence. */
export function installCommerceObserver(next: CommerceObserver | null): void {
  sink = next;
}

export function recordCommerceEvent(event: CommerceEvent): void {
  if (sink === null) return;
  try {
    sink(event);
  } catch {
    // An observer that throws must not turn a working lane into a broken
    // one; the event is dropped and the operation proceeds.
  }
}
