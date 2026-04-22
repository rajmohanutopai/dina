/**
 * RPC rate-limit direction filter.
 *
 * The RPC bridge rate-limits INBOUND request traffic (per-sender budget
 * against request flooding). Responses to our OWN requests arrive on
 * the same wire but must NOT count against the same budget — otherwise
 * a peer replying to everything we asked for could throttle our own
 * ability to process their replies.
 *
 * This helper classifies a message's direction and says whether it is
 * subject to rate limiting.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-012.
 */

export type RPCDirection = 'inbound-request' | 'inbound-response';

/**
 * Returns `true` if the message should be counted against the
 * rate-limit budget. Responses are exempt.
 */
export function isRateLimited(direction: RPCDirection): boolean {
  return direction === 'inbound-request';
}
