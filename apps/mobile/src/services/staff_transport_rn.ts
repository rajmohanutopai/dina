/**
 * The RN adapter for the staff phone's remote transport
 * (TRADE_FIRST_STRATEGY §6.3). Wraps the global `WebSocket` every RN
 * runtime ships into the event-based `WebSocketLike` `RemoteCoreClient`
 * consumes — the same shape the CLI's `_connect_and_auth` drives, here
 * for a phone.
 */

import type { WebSocketLike } from '@dina/core';

/** RN's `WebSocket` fires string/ArrayBuffer data; RemoteCoreClient reads both. */
export function makeStaffWebSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const like: WebSocketLike = {
    send: (data) => ws.send(data as string),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (event: { data: unknown }) => like.onmessage?.({ data: event.data });
  ws.onerror = () => like.onerror?.();
  ws.onclose = () => like.onclose?.();
  return like;
}
