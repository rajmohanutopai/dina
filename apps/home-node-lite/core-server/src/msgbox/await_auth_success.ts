/**
 * Task 4.43 — strict `auth_success` wait.
 *
 * After sending `auth_response` (task 4.42), the MsgBox WebSocket
 * client MUST wait for an explicit `auth_success` frame before
 * treating the connection as authenticated. Previous versions of
 * the spec allowed optimistic success on timeout fallback — that's
 * been deliberately removed. Rationale per
 * `docs/designs/MSGBOX_TRANSPORT.md`:
 *
 *   - A silent relay that drops the auth_success frame could trick
 *     clients into believing they're authenticated when they aren't.
 *   - Relays that take more than `timeoutMs` to respond likely aren't
 *     healthy anyway; failing fast triggers a reconnect attempt
 *     (task 4.44) that lands on a freshly-routed relay peer.
 *
 * **Strict behavior**: any frame other than `auth_success` arriving
 * in the wait window is an error (the relay is either confused or
 * the server we're talking to isn't a MsgBox). Timeout is also an
 * error. The only happy path is "auth_success arrives within
 * `timeoutMs`".
 *
 * **Test-friendly**: takes a message-source adapter rather than a
 * raw WebSocket so tests can synthesize frames without a real
 * socket. Timer is injectable for deterministic tests.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4f task 4.43.
 */

import type { AuthFrame } from '@dina/protocol';
import { AUTH_SUCCESS } from '@dina/protocol';

/** Default wait budget. 5 seconds is generous for a single
 *  round-trip on broadband + modest packet loss; MsgBox relay
 *  operations typically complete in <100ms. */
export const DEFAULT_AUTH_SUCCESS_TIMEOUT_MS = 5_000;

export type AuthSuccessWaitResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'timeout' | 'wrong_frame_type';
      /** For `wrong_frame_type` only — the frame that arrived instead. */
      frame?: unknown;
    };

export interface MessageSource {
  /** Register a one-shot listener. Returns a dispose function. */
  onMessage(cb: (frame: unknown) => void): () => void;
}

export interface AwaitAuthSuccessOptions {
  source: MessageSource;
  /** Total wait budget. Default 5_000 ms. */
  timeoutMs?: number;
  /** Injectable scheduler for tests. Default `setTimeout`. */
  setTimeoutFn?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  clearTimeoutFn?: (handle: NodeJS.Timeout | number) => void;
}

/**
 * Wait strictly for `auth_success`. Resolves with `{ok:true}` on
 * success OR `{ok:false, reason}` on timeout / wrong frame. Never
 * throws — a structured result is easier for the WS client to act on
 * than a rejection.
 *
 * Disposes its listener + timer on ALL outcomes so the caller
 * doesn't need a try/finally around the await.
 */
export function awaitAuthSuccess(
  opts: AwaitAuthSuccessOptions,
): Promise<AuthSuccessWaitResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTH_SUCCESS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`awaitAuthSuccess: timeoutMs must be > 0 (got ${timeoutMs})`);
  }
  const setTimer = opts.setTimeoutFn ?? setTimeout;
  const clearTimer = opts.clearTimeoutFn ?? clearTimeout;

  return new Promise<AuthSuccessWaitResult>((resolve) => {
    let settled = false;
    const finish = (result: AuthSuccessWaitResult) => {
      if (settled) return;
      settled = true;
      dispose();
      clearTimer(timer);
      resolve(result);
    };

    const dispose = opts.source.onMessage((frame) => {
      if (settled) return;
      if (isAuthSuccessFrame(frame)) {
        finish({ ok: true });
        return;
      }
      // Any other frame before auth_success is a protocol-level
      // failure — the relay is either confused or not a MsgBox.
      finish({ ok: false, reason: 'wrong_frame_type', frame });
    });

    const timer = setTimer(() => {
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAuthSuccessFrame(frame: unknown): frame is AuthFrame {
  return (
    frame !== null &&
    typeof frame === 'object' &&
    (frame as { type?: unknown }).type === AUTH_SUCCESS
  );
}
