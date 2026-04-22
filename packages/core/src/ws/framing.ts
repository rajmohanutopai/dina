/**
 * WebSocket message framing — envelope format for paired device comms.
 *
 * Client → Core: query, command, ack, pong
 * Core → Client: whisper, whisper_stream, system, ping, error, auth_ok/fail
 *
 * Message buffer: max 50 messages per device, 5-min retention.
 * Heartbeat: ping every 30s, 3 missed pongs = marked offline.
 * Reconnection: exponential backoff (1s → 30s max).
 *
 * Source: core/test/ws_test.go
 */

export type WSMessageType =
  | 'query'
  | 'command'
  | 'ack'
  | 'pong' // client → core
  | 'whisper'
  | 'whisper_stream'
  | 'system'
  | 'ping' // core → client
  | 'error'
  | 'auth_ok'
  | 'auth_fail'; // core → client

export interface WSMessage {
  type: WSMessageType;
  payload?: unknown;
  reply_to?: string;
  timestamp: number;
}

const VALID_TYPES = new Set<string>([
  'query',
  'command',
  'ack',
  'pong',
  'whisper',
  'whisper_stream',
  'system',
  'ping',
  'error',
  'auth_ok',
  'auth_fail',
]);

/** Check if a message type is valid. */
export function isValidMessageType(type: string): type is WSMessageType {
  return VALID_TYPES.has(type);
}

/** Parse a raw WebSocket message into a typed WSMessage. */
export function parseWSMessage(raw: string): WSMessage {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ws_framing: invalid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ws_framing: message must be a JSON object');
  }

  const type = parsed.type;
  if (typeof type !== 'string' || !isValidMessageType(type)) {
    throw new Error('ws_framing: missing or invalid type field');
  }

  const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now();

  const msg: WSMessage = { type, timestamp };

  if (parsed.payload !== undefined) {
    msg.payload = parsed.payload;
  }
  if (typeof parsed.reply_to === 'string') {
    msg.reply_to = parsed.reply_to;
  }

  return msg;
}

/** Serialize a WSMessage to JSON for sending. */
export function serializeWSMessage(msg: WSMessage): string {
  const obj: Record<string, unknown> = {
    type: msg.type,
    timestamp: msg.timestamp,
  };
  if (msg.payload !== undefined) {
    obj.payload = msg.payload;
  }
  if (msg.reply_to !== undefined) {
    obj.reply_to = msg.reply_to;
  }
  return JSON.stringify(obj);
}

/** Build an auth response message (auth_ok or auth_fail). */
export function buildAuthResponse(success: boolean, deviceName?: string): WSMessage {
  const msg: WSMessage = {
    type: success ? 'auth_ok' : 'auth_fail',
    timestamp: Date.now(),
  };
  if (success && deviceName) {
    msg.payload = { device: deviceName };
  }
  return msg;
}

/** Build a ping message. */
export function buildPing(): WSMessage {
  return {
    type: 'ping',
    timestamp: Date.now(),
  };
}
