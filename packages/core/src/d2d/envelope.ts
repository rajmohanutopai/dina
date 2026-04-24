/**
 * D2D message envelope — NaCl sealed box wrapping a signed DinaMessage.
 *
 * Outbound: build JSON → Ed25519 sign plaintext → NaCl seal → D2DPayload
 * Inbound: NaCl unseal → parse JSON → return message + signature for verification
 *
 * Source: core/internal/service/transport.go
 */

import { sealEncrypt, sealDecrypt } from '../crypto/nacl';
import { signMessage } from './signature';
import { buildMessage, parseMessage, type DinaMessage } from './wire';
import { base64 } from '@scure/base';

// Re-exported from `wire.ts` to keep the old import paths working
// (`buildMessage` / `parseMessage` / `DinaMessage` from './envelope').
// The implementations live in `wire.ts` because signature.ts also needs
// them and a direct envelope ↔ signature edge was a require cycle.
export { buildMessage, parseMessage };
export type { DinaMessage };

export interface D2DPayload {
  /** Base64-encoded NaCl sealed ciphertext */
  c: string;
  /** Hex-encoded Ed25519 signature over the plaintext JSON */
  s: string;
}

/**
 * Seal a DinaMessage for D2D transport.
 * Signs plaintext JSON, then NaCl seals it.
 */
export function sealMessage(
  msg: DinaMessage,
  senderPrivateKey: Uint8Array,
  recipientEd25519Pub: Uint8Array,
): D2DPayload {
  const json = buildMessage(msg);
  const sig = signMessage(msg, senderPrivateKey);
  const sealed = sealEncrypt(new TextEncoder().encode(json), recipientEd25519Pub);

  return {
    // `@scure/base` is pure-JS and works on both Node and RN Hermes
    // (Hermes has no `Buffer` unless polyfilled). Byte-for-byte
    // identical output to `Buffer.from(x).toString('base64')`.
    c: base64.encode(sealed),
    s: sig,
  };
}

/**
 * Unseal a D2D payload. Returns message + signature for separate verification.
 */
export function unsealMessage(
  payload: D2DPayload,
  recipientEd25519Pub: Uint8Array,
  recipientEd25519Priv: Uint8Array,
): { message: DinaMessage; signatureHex: string } {
  const ciphertext = base64.decode(payload.c);
  const plaintext = sealDecrypt(ciphertext, recipientEd25519Pub, recipientEd25519Priv);
  const json = new TextDecoder().decode(plaintext);
  const message = parseMessage(json);

  return { message, signatureHex: payload.s };
}
