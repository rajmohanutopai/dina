/**
 * Shared chat-orchestrator wiring for `/remember` — used by BOTH the
 * mobile bootstrap (`apps/mobile/src/services/bootstrap.ts`) and the
 * home-node-lite brain-server (`apps/home-node-lite/brain-server/src/boot.ts`).
 *
 * Mobile and brain-server each construct their own `StagingDrainScheduler`
 * (interval, logger, retry budget differ) and their own `CoreClient`
 * (`InProcessTransport` vs `HttpCoreTransport`), but the chat
 * orchestrator's `/remember` integration is identical across both:
 *
 *   - call `setRememberCoreClient(core)` so the orchestrator can
 *     enqueue items into staging via the SAME transport surface
 *     (`stagingIngest`),
 *   - call `setRememberDrainHook(...)` so the orchestrator can wait
 *     for the user's row to reach `stored` (or `pending_unlock`)
 *     before replying — that's what produces the
 *     "Stored in <Persona> vault. Reminders set: …" reply text
 *     instead of a bare ack.
 *
 * Before this module the two callers had divergent copies of the
 * drain hook with subtly different retry budgets + failure
 * branches. Centralising here closes the bug class where a fix
 * landed in one stack but not the other.
 *
 * `lookupPendingApproval` is an optional pluggable read: mobile reads
 * the staging row directly via `stagingGetItem` (in-process), but
 * brain-server can't (Core lives in another process), so it omits the
 * lookup and the orchestrator falls back to "the row is parked but I
 * don't know why" wording. Callers that DO have a sync staging
 * surface plug it in to enrich the reply.
 */

import {
  setRememberCoreClient,
  setRememberDrainHook,
  resetRememberCoreClient,
  resetRememberDrainHook,
  type RememberDrainResult,
} from '@dina/brain/chat';

import type { StagingDrainScheduler } from '@dina/brain';
import type { CoreClient } from '@dina/core';

export interface WireChatRememberRuntimeOptions {
  /** Transport handle the orchestrator hands to `stagingIngest`. Mobile
   *  passes `InProcessTransport`; brain-server passes `HttpCoreTransport`. */
  core: CoreClient;
  /** Drain scheduler. The hook drives `runTick()` so /remember replies
   *  arrive sub-second instead of waiting for the next periodic tick. */
  stagingDrain: StagingDrainScheduler;
  /**
   * Per-attempt retry budget. Each attempt = one `runTick()` + status
   * check. Mobile uses 5 (drain ticks are sub-second on-device);
   * brain-server uses 8 (Core round-trips can take longer over HTTP +
   * we don't want to hang the user's HTTP request beyond a few
   * seconds). Default 5.
   */
  maxAttempts?: number;
  /**
   * Optional sync read of the staging row for `pending_unlock`
   * enrichment — when the classifier routes to a closed persona, the
   * row carries the approval id the user must act on. Mobile passes
   * `stagingGetItem` from `@dina/core` (in-process); brain-server
   * omits this and the orchestrator surfaces a generic "parked"
   * reply.
   *
   * Return value: an object with `approval_id?` so the hook can
   * forward `pendingNeedsApproval`. Other fields are ignored.
   */
  lookupPendingApproval?: (stagingId: string) => { approval_id?: string } | null;
}

export interface ChatRememberRuntimeHandle {
  /** Tear down both registrations — call from the bootstrap's disposer chain. */
  dispose(): void;
}

/**
 * Wire `setRememberCoreClient` + `setRememberDrainHook` against the
 * supplied `core` + `stagingDrain`. Returns a `dispose()` the caller
 * runs during teardown to reset both globals.
 */
export function wireChatRememberRuntime(
  options: WireChatRememberRuntimeOptions,
): ChatRememberRuntimeHandle {
  const maxAttempts = options.maxAttempts ?? 5;
  const lookup = options.lookupPendingApproval;

  setRememberCoreClient(options.core);
  setRememberDrainHook(async (stagingId): Promise<RememberDrainResult> => {
    for (let i = 0; i < maxAttempts; i++) {
      const tick = await options.stagingDrain.runTick();
      const item = tick.results.find((r) => r.itemId === stagingId);
      if (item?.status === 'stored' && item.persona) {
        return { persona: item.persona };
      }
      // MT-13-I1 — classifier routed to a closed persona; staging
      // parks the row + (when an approval flow is wired) creates a
      // workflow task. Forward the classified persona so the chat
      // reply can tell the user what's parked and why.
      if (item?.status === 'pending_unlock' && item.persona) {
        const row = lookup ? lookup(stagingId) : null;
        const pendingNeedsApproval = row?.approval_id !== undefined;
        return {
          persona: null,
          pendingPersona: item.persona,
          pendingNeedsApproval,
        };
      }
      if (item?.status === 'failed') break;
    }
    return { persona: null };
  });

  return {
    dispose(): void {
      resetRememberCoreClient();
      resetRememberDrainHook();
    },
  };
}
