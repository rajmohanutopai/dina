/**
 * Grant-request "ask to enable" event surface.
 *
 * The `service.grant_request` handler (`grant_request_handler.ts`) makes the
 * deterministic closeness/default-offerable decision at D2D ingress. For a
 * MEDIUM (friend) contact + a default-offerable talk listing the decision is
 * `ask_to_enable` — but the actual prompt ("Allow <contact> to use your
 * <service>?") is an OWNER decision that belongs on the phone, not on Core's
 * fire-and-forget receive path. Core has already done its job (validated the
 * request, resolved the listing, decided the tier); it must NOT mint a grant
 * unilaterally for a friend.
 *
 * So the handler EMITS a pending-decision event through this channel and the
 * mobile boot subscribes, posts the one-time Talk prompt, and — on the owner's
 * yes — issues the grant via the existing `POST /v1/service/offer` route (the
 * same path `auto_grant` takes). This keeps the closeness policy single-source
 * (Core decides reach) while the human keeps the final yes (spec §2, §5.2).
 *
 * The event carries ONLY non-secret selectors the prompt + the eventual offer
 * need: the requester DID (transport-authenticated by the receive pipeline),
 * the capability, and the resolved listing rkey. No grant exists yet — issuing
 * it is the consumer's job after the owner approves.
 *
 * Mirrors the `onServiceConfigChanged` subscriber pattern: listener errors are
 * swallowed so one broken subscriber can't break ingress.
 */

export interface GrantRequestPendingEvent {
  /** The contact who asked (the eventual offer's `to_did`). Transport-authed. */
  requesterDID: string;
  /** The capability they asked to use (e.g. `availability_coordination`). */
  capability: string;
  /** The resolved local `surface:'talk'` listing rkey to grant against. */
  rkey: string;
  /** Closeness tier the policy computed (`medium` for the ask_to_enable path). */
  closeness: string;
}

export type GrantRequestPendingListener = (event: GrantRequestPendingEvent) => void;

const listeners = new Set<GrantRequestPendingListener>();

/**
 * Subscribe to `ask_to_enable` grant-request decisions. Returns a disposer.
 * Errors thrown by a listener are swallowed (and never re-thrown onto the
 * receive path), matching the config-change channel's discipline.
 */
export function onGrantRequestPending(listener: GrantRequestPendingListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Emit a pending-decision event to all subscribers. Fire-and-forget. */
export function emitGrantRequestPending(event: GrantRequestPendingEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      /* a broken subscriber must not break D2D ingress */
    }
  }
}

/** Reset module state — tests only. */
export function resetGrantRequestPendingListeners(): void {
  listeners.clear();
}
