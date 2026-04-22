/**
 * React Native / Expo network adapter.
 *
 * Scope today:
 *   - `makeWSFactory()` — wraps RN's global `WebSocket` into the
 *     `WSFactory` shape that `@dina/core`'s msgbox_ws client expects.
 *   - `resolveMsgBoxURL()` — reads `EXPO_PUBLIC_DINA_MSGBOX_URL` with a
 *     shared-test-infra default.
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

/** Default shared Dina mailbox URL — matches the test-infra relay. */
export const DEFAULT_MSGBOX_URL = 'wss://test-mailbox.dinakernel.com/ws';

/**
 * Resolve the MsgBox WebSocket URL the app should connect to.
 * Reads `EXPO_PUBLIC_DINA_MSGBOX_URL` (available at runtime on Expo)
 * and falls back to the shared test relay.
 */
export function resolveMsgBoxURL(): string {
  const override = process.env.EXPO_PUBLIC_DINA_MSGBOX_URL;
  if (typeof override === 'string' && override !== '') return override;
  return DEFAULT_MSGBOX_URL;
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
