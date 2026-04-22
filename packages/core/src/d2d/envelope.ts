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
import type { DinaMessage } from '@dina/test-harness';
import { base64 } from '@scure/base';
import { buildMessageJSON } from '@dina/protocol';

export type { DinaMessage } from '@dina/test-harness';

export interface D2DPayload {
  /** Base64-encoded NaCl sealed ciphertext */
  c: string;
  /** Hex-encoded Ed25519 signature over the plaintext JSON */
  s: string;
}

const REQUIRED_FIELDS = ['id', 'type', 'from', 'to', 'created_time', 'body'];

/** Build a DinaMessage JSON string. Deterministic key order.
 *
 * Two Go-interop shape conversions happen here:
 *
 *   - `to` → string array. Go's `DinaMessage.To` is `[]string`; a bare
 *     string drops at `json: cannot unmarshal string into Go struct
 *     field DinaMessage.to of type []string`.
 *   - `body` → base64. Go's `DinaMessage.Body` is `[]byte` with a
 *     `json:"body"` tag, and Go's encoding/json auto-base64-encodes
 *     `[]byte` fields when marshalling. Sending the raw body string
 *     made Go base64-decode it as bytes, failing at
 *     `illegal base64 data at input byte 0` for any body that starts
 *     with a non-b64 character (like `{`).
 *
 * The TS `DinaMessage` type keeps `body` as a display string for
 * ergonomics; the wire shape is the base64-encoded UTF-8 bytes.
 */
export function buildMessage(msg: DinaMessage): string {
  // Core owns base64 (@scure/base dep); protocol's buildMessageJSON is
  // crypto/encoding-free and does the deterministic key-ordered JSON
  // assembly. Task 1.19.
  const bodyBytes = new TextEncoder().encode(msg.body);
  return buildMessageJSON({
    id: msg.id,
    type: msg.type,
    from: msg.from,
    to: msg.to,
    created_time: msg.created_time,
    bodyBase64: base64.encode(bodyBytes),
  });
}

/** Parse a DinaMessage from JSON string. Validates required fields. */
export function parseMessage(json: string): DinaMessage {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('envelope: invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('envelope: JSON is not an object');
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      throw new Error(`envelope: missing required field "${field}"`);
    }
  }

  if (typeof parsed.id !== 'string') throw new Error('envelope: id must be a string');
  if (typeof parsed.type !== 'string') throw new Error('envelope: type must be a string');
  if (typeof parsed.from !== 'string') throw new Error('envelope: from must be a string');
  // Accept both shapes: `to` as bare string (legacy TS wire) or array
  // of strings (Go wire / new TS canonical). parseMessage is a read
  // path — tolerating both keeps round-trips from Go peers working.
  if (typeof parsed.to !== 'string' && !isStringArray(parsed.to)) {
    throw new Error('envelope: to must be a string or string array');
  }
  if (typeof parsed.created_time !== 'number')
    throw new Error('envelope: created_time must be a number');
  if (typeof parsed.body !== 'string') throw new Error('envelope: body must be a string');

  // Decode base64 body back to UTF-8 string on read. Tolerates legacy
  // peers that send body as plain string (no base64) by falling back
  // to the literal value when b64 decode fails.
  let body: string;
  try {
    body = new TextDecoder().decode(base64.decode(parsed.body));
  } catch {
    body = parsed.body;
  }

  return { ...(parsed as Record<string, unknown>), body } as unknown as DinaMessage;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
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
