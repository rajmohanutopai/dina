/**
 * Task 4.37 — WebSocket hub. Tracks authenticated clients keyed by
 * deviceId + fans messages out to one, many, or all subscribers.
 *
 * **Transport-agnostic**: the hub talks to a `WebSocketLike`
 * interface (`send`, `close`, plus a way to notice disconnection).
 * The production wire-up in `notify_route.ts` (task 4.36) passes a
 * `@fastify/websocket` connection; tests pass in-memory mocks. Same
 * API — the hub doesn't care.
 *
 * **Single-session-per-device**: a fresh `register()` on a deviceId
 * that already has an active socket CLOSES the prior socket with
 * code 4000 (policy-defined "replaced") and replaces it. Prevents
 * accidental fan-out to duplicate tabs / stale reconnects while
 * keeping a fresh reconnect from blocking.
 *
 * **Message framing**: the hub serialises every outbound message as
 * JSON. Callers supply a plain object; we `JSON.stringify` at send
 * time. For binary push envelopes (task 4.38) the caller wraps the
 * sealed bytes in a `PushEnvelopeFrame` — the JSON layer is universal.
 *
 * **Send failures**: `send()` / `broadcast()` silently drop + emit
 * `send_failed` events for sockets that throw on write. A broken
 * socket is auto-unregistered so the next send doesn't retry it.
 * This prevents a single dead client from killing the fanout loop.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4e task 4.37.
 */

/**
 * Subset of the `ws` / `@fastify/websocket` / browser WebSocket API
 * that the hub actually uses. Keeps tests free of the `ws` dep.
 */
export interface WebSocketLike {
  /** Send a string frame. Throws synchronously on a dead socket. */
  send(data: string): void;
  /** Close the socket. `code` and `reason` follow the WS protocol. */
  close(code?: number, reason?: string): void;
}

/** WebSocket close code the hub uses when replacing a duplicate session. */
export const REPLACED_BY_NEW_SESSION_CODE = 4000;

/** WebSocket close code for graceful shutdown (task 4.9 integration). */
export const HUB_SHUTDOWN_CODE = 1001; // "going away" per RFC 6455

export type NotifyHubEvent =
  | { kind: 'registered'; deviceId: string; atMs: number }
  | { kind: 'replaced'; deviceId: string; atMs: number }
  | { kind: 'unregistered'; deviceId: string; atMs: number }
  | {
      kind: 'send_failed';
      deviceId: string;
      atMs: number;
      error: string;
    };

export interface NotifyHubOptions {
  /** Injectable clock. Default `Date.now`. */
  nowMsFn?: () => number;
  /** Diagnostic hook. Fires on every state transition. */
  onEvent?: (event: NotifyHubEvent) => void;
}

interface ClientRecord {
  readonly deviceId: string;
  readonly socket: WebSocketLike;
  readonly registeredAtMs: number;
}

export class NotifyHub {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly nowMsFn: () => number;
  private readonly onEvent?: (event: NotifyHubEvent) => void;

  constructor(opts: NotifyHubOptions = {}) {
    this.nowMsFn = opts.nowMsFn ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /**
   * Register a device's socket. If a prior socket exists for the
   * same deviceId it gets closed with `REPLACED_BY_NEW_SESSION_CODE`
   * + reason `"replaced by new session"` and replaced.
   */
  register(deviceId: string, socket: WebSocketLike): void {
    if (!deviceId) throw new Error('NotifyHub.register: deviceId is required');
    if (!socket) throw new Error('NotifyHub.register: socket is required');
    const now = this.nowMsFn();
    const existing = this.clients.get(deviceId);
    if (existing !== undefined) {
      try {
        existing.socket.close(
          REPLACED_BY_NEW_SESSION_CODE,
          'replaced by new session',
        );
      } catch {
        // Already-dead socket; ignore.
      }
      this.onEvent?.({ kind: 'replaced', deviceId, atMs: now });
    }
    this.clients.set(deviceId, { deviceId, socket, registeredAtMs: now });
    this.onEvent?.({ kind: 'registered', deviceId, atMs: now });
  }

  /**
   * Drop a client. Returns true when a record was removed. Does NOT
   * call `socket.close()` — the caller (the transport adapter) owns
   * the lifecycle and will invoke this after observing a close event.
   */
  unregister(deviceId: string): boolean {
    if (!this.clients.has(deviceId)) return false;
    this.clients.delete(deviceId);
    this.onEvent?.({ kind: 'unregistered', deviceId, atMs: this.nowMsFn() });
    return true;
  }

  /**
   * Send a message to one client. Returns true on success, false when
   * the deviceId isn't connected OR the send threw (the client is
   * auto-unregistered in that case so the caller doesn't keep
   * retrying a zombie).
   */
  send(deviceId: string, message: unknown): boolean {
    const record = this.clients.get(deviceId);
    if (record === undefined) return false;
    const payload = JSON.stringify(message);
    try {
      record.socket.send(payload);
      return true;
    } catch (err) {
      this.onEvent?.({
        kind: 'send_failed',
        deviceId,
        atMs: this.nowMsFn(),
        error: err instanceof Error ? err.message : String(err),
      });
      // Auto-reap the zombie; downstream will observe the close via
      // their own socket event handling.
      this.clients.delete(deviceId);
      return false;
    }
  }

  /**
   * Fanout to every connected client, optionally filtered by
   * predicate. Returns the number of clients the message was
   * SUCCESSFULLY delivered to (failed sends are excluded from the
   * count + reaped from the hub).
   */
  broadcast(
    message: unknown,
    predicate?: (deviceId: string) => boolean,
  ): number {
    const payload = JSON.stringify(message);
    let delivered = 0;
    // Snapshot keys so reaping during iteration is safe.
    const ids = Array.from(this.clients.keys());
    for (const deviceId of ids) {
      if (predicate && !predicate(deviceId)) continue;
      const record = this.clients.get(deviceId);
      if (record === undefined) continue;
      try {
        record.socket.send(payload);
        delivered++;
      } catch (err) {
        this.onEvent?.({
          kind: 'send_failed',
          deviceId,
          atMs: this.nowMsFn(),
          error: err instanceof Error ? err.message : String(err),
        });
        this.clients.delete(deviceId);
      }
    }
    return delivered;
  }

  /** True iff a client with this deviceId is currently connected. */
  hasClient(deviceId: string): boolean {
    return this.clients.has(deviceId);
  }

  /** Count of currently-connected clients. */
  size(): number {
    return this.clients.size;
  }

  /** Snapshot of connected deviceIds for admin UI / /readyz probes. */
  connectedDeviceIds(): string[] {
    return Array.from(this.clients.keys()).sort();
  }

  /**
   * Close every socket (graceful shutdown — task 4.9). Calls
   * `socket.close(HUB_SHUTDOWN_CODE, "going away")` on each;
   * exceptions during close are swallowed so one misbehaving
   * socket can't block the sweep. Returns the count closed.
   */
  closeAll(): number {
    const ids = Array.from(this.clients.keys());
    let closed = 0;
    for (const id of ids) {
      const record = this.clients.get(id);
      if (record === undefined) continue;
      try {
        record.socket.close(HUB_SHUTDOWN_CODE, 'going away');
      } catch {
        // Already dead.
      }
      this.clients.delete(id);
      this.onEvent?.({ kind: 'unregistered', deviceId: id, atMs: this.nowMsFn() });
      closed++;
    }
    return closed;
  }
}
