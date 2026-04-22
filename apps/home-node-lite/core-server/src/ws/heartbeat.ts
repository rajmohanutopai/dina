/**
 * Task 4.39 — WebSocket heartbeat ping/pong (30s).
 *
 * RFC 6455 defines control-frame ping/pong but browsers + most Node
 * WebSocket clients don't surface APIs for application-level control.
 * Application-layer heartbeat is the portable pattern:
 *
 *   - Every `intervalMs` (default 30 000) the server sends a ping
 *     frame. Recipients must respond with a pong frame (ws library
 *     handles this automatically for standard ws frames) or, for
 *     application-message-based protocols, reply with a liveness
 *     marker.
 *   - If no pong is observed within `timeoutMs` (default 2x interval
 *     = 60 000), the heartbeat calls `onTimeout()` — caller typically
 *     closes the socket + removes the client from the hub.
 *
 * **Why 30s**: WSS connections behind most load balancers idle out
 * at 60s. A 30s heartbeat keeps the connection warm with a safety
 * margin. Shorter is just noise; longer risks LB-initiated close.
 *
 * **Injectable clock / scheduler** for deterministic tests.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4e task 4.39.
 */

export interface HeartbeatOptions {
  /**
   * Called to send a ping to the peer. Implement via `ws.ping()`
   * (node `ws` library) or an app-level `{type: 'ping'}` message.
   */
  sendPing: () => void;
  /**
   * Invoked when `timeoutMs` has elapsed since the last pong with no
   * response. Caller typically closes the socket + cleans up.
   */
  onTimeout: () => void;
  /** Ping cadence in ms. Default 30 000. */
  intervalMs?: number;
  /** Pong-wait budget in ms. Default 2 × intervalMs (60 000). */
  timeoutMs?: number;
  /** Injected clock (ms). Default `Date.now`. */
  nowMsFn?: () => number;
  /** Injected scheduler (setInterval shape). Default: global. */
  setIntervalFn?: (fn: () => void, ms: number) => { stop: () => void };
  /**
   * Logger for ops diagnostics. Each ping is logged at `trace`,
   * each timeout at `warn`. Optional — silent if omitted.
   */
  logger?: { trace: (msg: string) => void; warn: (msg: string) => void };
}

export interface HeartbeatHandle {
  /** Call when a pong / liveness marker is received from the peer. */
  markPong: () => void;
  /** Stop the heartbeat — call on socket close or explicit shutdown. */
  stop: () => void;
  /** Current ms-since-epoch of the last observed pong. */
  lastPongAt: () => number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Install an application-layer heartbeat on a socket-ish resource.
 * Returns a handle the caller keeps to mark pongs + stop the timer.
 */
export function installHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? intervalMs * 2;
  const now = opts.nowMsFn ?? Date.now;
  const schedule = opts.setIntervalFn ?? defaultSchedule;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`installHeartbeat: intervalMs must be > 0 (got ${intervalMs})`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`installHeartbeat: timeoutMs must be > 0 (got ${timeoutMs})`);
  }

  // Start with "just received a pong" so the first interval has a
  // fresh-enough anchor to not immediately time out.
  let lastPongMs = now();
  let stopped = false;

  const scheduled = schedule(() => {
    if (stopped) return;
    const elapsedSincePong = now() - lastPongMs;
    if (elapsedSincePong >= timeoutMs) {
      opts.logger?.warn(`heartbeat: no pong in ${elapsedSincePong}ms (budget ${timeoutMs}ms)`);
      // Caller decides whether to close / re-arm; we stop our own timer
      // so duplicate timeouts can't fire.
      stopped = true;
      scheduled.stop();
      opts.onTimeout();
      return;
    }
    opts.logger?.trace(`heartbeat: sending ping (last pong ${elapsedSincePong}ms ago)`);
    try {
      opts.sendPing();
    } catch (err) {
      opts.logger?.warn(`heartbeat: sendPing threw: ${(err as Error).message}`);
      // A failed send is effectively a timeout — the peer is unreachable.
      stopped = true;
      scheduled.stop();
      opts.onTimeout();
    }
  }, intervalMs);

  return {
    markPong: () => {
      lastPongMs = now();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      scheduled.stop();
    },
    lastPongAt: () => lastPongMs,
  };
}

// ---------------------------------------------------------------------------
// Default scheduler — wraps setInterval with an `unref` so the heartbeat
// never keeps the Node event loop alive on its own.
// ---------------------------------------------------------------------------

function defaultSchedule(fn: () => void, ms: number): { stop: () => void } {
  const handle = setInterval(fn, ms);
  // Don't let the heartbeat keep the process alive after ops closed
  // everything else.
  handle.unref?.();
  return {
    stop: () => clearInterval(handle),
  };
}
