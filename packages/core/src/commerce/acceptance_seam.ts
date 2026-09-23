/**
 * The buyer's ACCEPTANCE seam — money-free, one direction.
 *
 * The buyer retains a supplier's `accepted` acknowledgement on the kernel
 * side (`buyer_retention.ts`). Money-line work that waits on that fact — a
 * connector's order attachment that reached the buyer before the
 * acknowledgement did (JIFFY_MERCHANT_INTEGRATION_PLAN §3.3) — registers an
 * observer here; the kernel calls it and knows nothing about what it does.
 * `installCommerceRuntime` sets the observer with the runtime's own life, the
 * same shape as the trade ingress seam, so a node without commerce storage
 * observes nothing.
 */

export type AcceptanceObserver = (args: {
  buyerDid: string;
  purchaseOrderId: string;
  nowMs: number;
}) => void;

let observer: AcceptanceObserver | null = null;

export function setAcceptanceObserver(next: AcceptanceObserver | null): void {
  observer = next;
}

/** Never throws into retention: the acknowledgement is already retained. */
export function notifyAcceptanceRetained(args: Parameters<AcceptanceObserver>[0]): void {
  if (observer === null) return;
  try {
    observer(args);
  } catch {
    /* an observer fault must not undo a retained acceptance */
  }
}
