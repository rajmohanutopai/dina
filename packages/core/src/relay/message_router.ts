/**
 * MsgBox incoming message handler — route by decrypted envelope type.
 *
 * When a binary WS frame arrives from MsgBox:
 *   1. NaCl unseal the blob with recipient's keys
 *   2. Parse the decrypted JSON
 *   3. Inspect the `type` field
 *   4. Route:
 *      - "core_rpc_request" → Core RPC handler
 *      - "d2d_payload"      → D2D receive pipeline
 *      - unknown            → reject + log
 *
 * Source: ARCHITECTURE.md Task 2.21
 */

import { sealDecrypt } from '../crypto/nacl';
import { appendAudit } from '../audit/service';

export type MessageType = 'core_rpc_request' | 'd2d_payload' | 'unknown';

export interface RouteResult {
  type: MessageType;
  payload: Record<string, unknown>;
  routed: boolean;
  error?: string;
}

/** Injectable handler for Core RPC requests. */
export type RPCHandler = (request: Record<string, unknown>) => Promise<void>;

/** Injectable handler for D2D payloads. */
export type D2DHandler = (payload: Record<string, unknown>) => Promise<void>;

let rpcHandler: RPCHandler | null = null;
let d2dHandler: D2DHandler | null = null;

/** Register the Core RPC request handler. */
export function registerRPCHandler(handler: RPCHandler): void {
  rpcHandler = handler;
}

/** Register the D2D payload handler. */
export function registerD2DHandler(handler: D2DHandler): void {
  d2dHandler = handler;
}

/** Reset handlers (for testing). */
export function resetMessageRouter(): void {
  rpcHandler = null;
  d2dHandler = null;
}

/**
 * Handle an incoming sealed message from MsgBox.
 *
 * Unseals, parses, routes by type.
 */
export async function handleIncomingMessage(
  sealedBlob: Uint8Array,
  recipientPub: Uint8Array,
  recipientPriv: Uint8Array,
): Promise<RouteResult> {
  // 1. Unseal
  let plaintext: Uint8Array;
  try {
    plaintext = sealDecrypt(sealedBlob, recipientPub, recipientPriv);
  } catch (err) {
    return {
      type: 'unknown',
      payload: {},
      routed: false,
      error: `Unseal failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  // 2. Parse JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return {
      type: 'unknown',
      payload: {},
      routed: false,
      error: 'Invalid JSON in decrypted payload',
    };
  }

  // 3. Inspect type
  const type = classifyMessageType(parsed);

  // 4. Route
  try {
    if (type === 'core_rpc_request' && rpcHandler) {
      await rpcHandler(parsed);
      appendAudit('msgbox', 'route_rpc', (parsed.from as string) ?? '', `id=${parsed.request_id}`);
      return { type, payload: parsed, routed: true };
    }

    if (type === 'd2d_payload' && d2dHandler) {
      await d2dHandler(parsed);
      appendAudit('msgbox', 'route_d2d', (parsed.from as string) ?? '', `type=${parsed.type}`);
      return { type, payload: parsed, routed: true };
    }

    if (type === 'unknown') {
      appendAudit('msgbox', 'route_unknown', '', `type=${String(parsed.type ?? 'missing')}`);
      return {
        type,
        payload: parsed,
        routed: false,
        error: `Unknown message type: ${parsed.type}`,
      };
    }

    // Handler not registered
    return {
      type,
      payload: parsed,
      routed: false,
      error: `No handler registered for type "${type}"`,
    };
  } catch (err) {
    return {
      type,
      payload: parsed,
      routed: false,
      error: `Handler error: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }
}

/**
 * Classify the message type from the parsed envelope.
 */
export function classifyMessageType(parsed: Record<string, unknown>): MessageType {
  const type = parsed.type;

  if (type === 'core_rpc_request') return 'core_rpc_request';

  // D2D payloads have 'c' (ciphertext) and 's' (signature) fields
  if (typeof parsed.c === 'string' && typeof parsed.s === 'string') {
    return 'd2d_payload';
  }

  // DinaMessage format (from/to/body/created_time)
  if (
    typeof parsed.from === 'string' &&
    typeof parsed.to === 'string' &&
    typeof parsed.body === 'string' &&
    typeof parsed.created_time === 'number'
  ) {
    return 'd2d_payload';
  }

  return 'unknown';
}
