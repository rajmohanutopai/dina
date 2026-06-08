/**
 * App-global review-outbox autodrain (TN-MOB-007).
 *
 * The Outbox screen drains while it's open, but a review queued offline
 * from the compose flow (the user taps back, not into Outbox) must retry
 * without the user manually opening Outbox. This starts an app-level
 * drainer: an initial hydrate + drain once the node is up, then a drain
 * on every return to the foreground (a cheap "retry on reconnect").
 *
 * Started from the app root (`_layout`) when boot completes. Idempotent.
 */

import { AppState, type AppStateStatus } from 'react-native';

import { drainBootedReviewOutbox, hydrateBootedReviewOutbox } from './review_outbox_durable';

let active = false;

/**
 * Start the global autodrain. Hydrates the screen mirror + drains once,
 * then drains on each app foreground. Returns a stop function. Idempotent
 * — a second call while already active is a no-op.
 */
export function startReviewOutboxAutodrain(): () => void {
  if (active) return () => undefined;
  active = true;
  void hydrateBootedReviewOutbox().then(() => void drainBootedReviewOutbox());
  const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
    if (s === 'active') void drainBootedReviewOutbox();
  });
  return () => {
    sub.remove();
    active = false;
  };
}
