/**
 * Task 4.40 — canonical notification frame for CLI / device clients.
 *
 * When Core pushes a nudge / reminder / response over the `/v1/ws/notify`
 * WebSocket (task 4.36), every consumer (CLI, mobile app, admin UI)
 * deserialises the frame with the same parser. This module is that
 * frame's canonical shape + builder, so the producer side + the
 * consumer side can't drift.
 *
 * **Wire shape**:
 *
 *   {
 *     type: "notification",
 *     v: 1,
 *     priority: "fiduciary" | "solicited" | "engagement",
 *     message: string,
 *     ts: number,               // unix milliseconds (ms, matches slog)
 *     id: string                // caller-supplied or generated; stable per notification
 *   }
 *
 * **Priority** — three tiers from the Silence First design (§35.1 in
 * `ARCHITECTURE.md`). The consumer routes each tier differently:
 *   - `fiduciary` → interrupt immediately, override DND
 *   - `solicited` → normal push; defer during DND
 *   - `engagement` → queued for daily briefing, never toast-notified
 *
 * **Why `v: 1`**: future frame-shape evolution (rich metadata, sender
 * DID, action-link) lands as `v: 2`; older consumers drop unknown
 * versions. Pins backward compatibility at the protocol level.
 *
 * **Go parity**: Go Core currently broadcasts raw message strings
 * (see `core/internal/handler/notify.go`). Lite emits STRUCTURED
 * frames because:
 *   (a) priority-tier routing needs the consumer to see the tier
 *   (b) `ts` + `id` enable client-side dedupe across reconnects
 * The structured shape is the strict superset — a Go client that
 * only cares about `message` can read that field. This module is
 * the single source of truth Brain + CLI + mobile all depend on.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4e task 4.40.
 */

export const NOTIFICATION_FRAME_TYPE = 'notification';
export const NOTIFICATION_FRAME_VERSION = 1;

export type NotificationPriority = 'fiduciary' | 'solicited' | 'engagement';

export const VALID_NOTIFICATION_PRIORITIES: ReadonlySet<NotificationPriority> =
  new Set<NotificationPriority>(['fiduciary', 'solicited', 'engagement']);

/** Canonical wire frame — matches what `/v1/ws/notify` emits. */
export interface NotificationFrame {
  readonly type: typeof NOTIFICATION_FRAME_TYPE;
  readonly v: typeof NOTIFICATION_FRAME_VERSION;
  readonly priority: NotificationPriority;
  readonly message: string;
  /** ms since epoch. */
  readonly ts: number;
  /** Stable id — caller supplies or server generates. */
  readonly id: string;
}

export interface BuildNotificationInput {
  priority: NotificationPriority;
  message: string;
  /** Caller-supplied id. Required; callers without one should mint a UUID. */
  id: string;
  /** ms since epoch. Required; pass an injectable clock result for determinism. */
  ts: number;
}

/**
 * Build a canonical `NotificationFrame`. Throws on invalid input —
 * CLI parity requires the producer never emits malformed frames.
 */
export function buildNotificationFrame(input: BuildNotificationInput): NotificationFrame {
  if (!VALID_NOTIFICATION_PRIORITIES.has(input.priority)) {
    throw new Error(
      `buildNotificationFrame: invalid priority ${JSON.stringify(input.priority)} — must be one of fiduciary | solicited | engagement`,
    );
  }
  if (typeof input.message !== 'string') {
    throw new Error('buildNotificationFrame: message must be a string');
  }
  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw new Error('buildNotificationFrame: id must be a non-empty string');
  }
  if (typeof input.ts !== 'number' || !Number.isFinite(input.ts) || input.ts < 0) {
    throw new Error(
      `buildNotificationFrame: ts must be a non-negative finite number (got ${input.ts})`,
    );
  }
  return {
    type: NOTIFICATION_FRAME_TYPE,
    v: NOTIFICATION_FRAME_VERSION,
    priority: input.priority,
    message: input.message,
    ts: input.ts,
    id: input.id,
  };
}

/** Type guard: does this object structurally match `NotificationFrame`? */
export function isNotificationFrame(x: unknown): x is NotificationFrame {
  if (x === null || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  return (
    f['type'] === NOTIFICATION_FRAME_TYPE &&
    f['v'] === NOTIFICATION_FRAME_VERSION &&
    typeof f['priority'] === 'string' &&
    VALID_NOTIFICATION_PRIORITIES.has(f['priority'] as NotificationPriority) &&
    typeof f['message'] === 'string' &&
    typeof f['ts'] === 'number' &&
    typeof f['id'] === 'string'
  );
}

/**
 * Parser/validator for inbound frames. The CLI-side consumer uses
 * this exact function; anything it accepts is safe to dispatch into
 * consumer UX. Returns structured discriminator:
 *   `{ok: true, frame}` on success
 *   `{ok: false, reason}` on any failure
 */
export type ParseNotificationResult =
  | { ok: true; frame: NotificationFrame }
  | { ok: false; reason: ParseNotificationReason };

export type ParseNotificationReason =
  | 'not_json'
  | 'not_object'
  | 'wrong_type'
  | 'wrong_version'
  | 'invalid_priority'
  | 'invalid_field';

export function parseNotificationFrame(raw: string): ParseNotificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'not_object' };
  }
  const f = parsed as Record<string, unknown>;
  if (f['type'] !== NOTIFICATION_FRAME_TYPE) {
    return { ok: false, reason: 'wrong_type' };
  }
  if (f['v'] !== NOTIFICATION_FRAME_VERSION) {
    return { ok: false, reason: 'wrong_version' };
  }
  if (
    typeof f['priority'] !== 'string' ||
    !VALID_NOTIFICATION_PRIORITIES.has(f['priority'] as NotificationPriority)
  ) {
    return { ok: false, reason: 'invalid_priority' };
  }
  if (
    typeof f['message'] !== 'string' ||
    typeof f['id'] !== 'string' ||
    f['id'].length === 0 ||
    typeof f['ts'] !== 'number' ||
    !Number.isFinite(f['ts'])
  ) {
    return { ok: false, reason: 'invalid_field' };
  }
  return {
    ok: true,
    frame: {
      type: NOTIFICATION_FRAME_TYPE,
      v: NOTIFICATION_FRAME_VERSION,
      priority: f['priority'] as NotificationPriority,
      message: f['message'],
      ts: f['ts'],
      id: f['id'],
    },
  };
}
