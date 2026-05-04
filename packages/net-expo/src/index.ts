/**
 * React Native / Expo network adapter.
 *
 * Scope today:
 *   - `makeWSFactory()` — wraps RN's global `WebSocket` into the
 *     `WSFactory` shape that `@dina/core`'s msgbox_ws client expects.
 *   - `resolveMsgBoxURL()` — delegates to `@dina/home-node` so Expo and
 *     server Home Nodes select the same hosted endpoint mode.
 *
 * Planned expansion (Phase 2, alongside `HttpClientPort` + `WebSocketClientPort`
 * in @dina/core):
 *   - HTTP request builder with retry + signed-request helpers
 *   - WebSocket reconnect helper
 *   - conforms to the net ports that @dina/core will declare
 *
 * Extracted per docs/HOME_NODE_LITE_TASKS.md task 1.14.3d (from
 * apps/mobile/src/services/msgbox_wiring.ts's WebSocket-factory helpers).
 */

import type { WSFactory, WSLike } from '@dina/core';
import { resolveHostedDinaEndpoints, resolveMobileHostedDinaEndpoints } from '@dina/home-node';

/** Default shared Dina mailbox URL — matches the test-infra relay. */
export const DEFAULT_MSGBOX_URL = resolveHostedDinaEndpoints('test').msgboxWsUrl;

/**
 * Resolve the MsgBox WebSocket URL the app should connect to.
 * Reads Expo endpoint env through `@dina/home-node` and falls back to
 * the shared test relay.
 */
export function resolveMsgBoxURL(): string {
  return resolveMobileHostedDinaEndpoints().msgboxWsUrl;
}

/**
 * Factory for RN WebSocket instances. Relies on the global `WebSocket`
 * constructor that every RN runtime ships. The `WSLike` cast is needed
 * because RN's WebSocket type doesn't structurally match core's
 * `WSLike` interface byte-for-byte, but the relevant fields (`send`,
 * `close`, `readyState`, event handlers) line up at runtime.
 */
export function makeWSFactory(): WSFactory {
  return (url: string): WSLike => {
    const ws = new WebSocket(url);
    return ws as unknown as WSLike;
  };
}
