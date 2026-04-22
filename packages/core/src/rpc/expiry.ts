/**
 * Per-message `expires_at` enforcement on buffer drain.
 *
 * When `MsgBox` drains a queued message, the inner envelope may carry
 * an `expires_at` (unix seconds). Messages past their deadline are
 * dropped with an audit entry rather than dispatched — prevents a slow
 * drain from acting on stale commands.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-008.
 */

export interface MessageWithExpiry {
  /** Unix seconds after which the message is stale. Undefined = never expires. */
  expires_at?: number;
}

/**
 * Returns `true` when the message is past its deadline. Undefined /
 * invalid `expires_at` is treated as "no expiry" — returns `false`.
 * Uses strict `<=` so a message exactly at its deadline IS expired.
 */
export function isMessageExpired(msg: MessageWithExpiry, nowSec: number): boolean {
  if (msg.expires_at === undefined) return false;
  if (!Number.isFinite(msg.expires_at)) return false;
  return msg.expires_at <= nowSec;
}
