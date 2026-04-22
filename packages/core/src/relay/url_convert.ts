/**
 * MsgBox URL conversion — convert WebSocket URL to HTTP forward URL.
 *
 * The MsgBox relay has two endpoints:
 *   - WebSocket: wss://mailbox.dinakernel.com/ws (persistent connection)
 *   - Forward:   https://mailbox.dinakernel.com/forward (POST sealed blobs)
 *
 * Conversion rules (matching server transport.go:462-471):
 *   1. wss:// → https://
 *   2. ws:// → http://
 *   3. Strip /ws or /ws/ suffix
 *   4. Append /forward
 *
 * Examples:
 *   wss://mailbox.dinakernel.com/ws → https://mailbox.dinakernel.com/forward
 *   wss://relay.example.com/ws/    → https://relay.example.com/forward
 *   ws://localhost:9090/ws         → http://localhost:9090/forward
 *
 * Source: ARCHITECTURE.md Task 6.2
 */

import { MSGBOX_WS_SUFFIX, MSGBOX_FORWARD_SUFFIX } from '../constants';

/**
 * Convert a MsgBox WebSocket URL to its HTTP forward URL.
 *
 * @param wsURL — WebSocket URL (wss:// or ws://)
 * @returns HTTPS/HTTP forward URL
 * @throws if the URL is not a valid WebSocket URL
 */
export function msgboxWSToForwardURL(wsURL: string): string {
  if (!wsURL) throw new Error('url_convert: WebSocket URL is required');

  let url = wsURL.trim();

  // Step 1: Protocol conversion
  if (url.startsWith('wss://')) {
    url = 'https://' + url.slice('wss://'.length);
  } else if (url.startsWith('ws://')) {
    url = 'http://' + url.slice('ws://'.length);
  } else {
    throw new Error(`url_convert: expected wss:// or ws:// URL, got "${wsURL}"`);
  }

  // Step 2: Strip /ws or /ws/ suffix
  url = url.replace(/\/ws\/?$/, '');

  // Step 3: Append /forward
  url = url.replace(/\/$/, '') + MSGBOX_FORWARD_SUFFIX;

  return url;
}

/**
 * Convert an HTTP forward URL back to a WebSocket URL.
 *
 * Inverse of msgboxWSToForwardURL.
 *
 * @param forwardURL — HTTP forward URL
 * @returns WebSocket URL
 */
export function forwardURLToMsgboxWS(forwardURL: string): string {
  if (!forwardURL) throw new Error('url_convert: forward URL is required');

  let url = forwardURL.trim();

  // Step 1: Protocol conversion
  if (url.startsWith('https://')) {
    url = 'wss://' + url.slice('https://'.length);
  } else if (url.startsWith('http://')) {
    url = 'ws://' + url.slice('http://'.length);
  } else {
    throw new Error(`url_convert: expected https:// or http:// URL, got "${forwardURL}"`);
  }

  // Step 2: Strip /forward suffix
  url = url.replace(/\/forward\/?$/, '');

  // Step 3: Append /ws
  url = url.replace(/\/$/, '') + MSGBOX_WS_SUFFIX;

  return url;
}

/**
 * Extract the host + port from a MsgBox URL (any protocol).
 *
 * Useful for connection status display and logging.
 */
export function extractMsgboxHost(url: string): string {
  const withoutProtocol = url.replace(/^(wss?|https?):\/\//, '');
  return withoutProtocol.split('/')[0];
}
