/**
 * D2D wire-shape helpers — `buildMessage` / `parseMessage` + the
 * `DinaMessage` type re-export.
 *
 * Extracted from `envelope.ts` to break the require cycle between
 * `envelope.ts` (needs `signMessage` from `signature.ts`) and
 * `signature.ts` (needs `buildMessage` + `DinaMessage` from
 * `envelope.ts`). Metro hot-reload surfaced this as a `Require cycle`
 * warning; on Hermes the warning is benign until one of the cyclic
 * imports reads a field during module init, at which point the
 * uninitialised-binding trap fires. Extracting the wire layer into
 * this neutral file gives both envelope + signature a one-way edge.
 *
 * Wire invariants (unchanged from the old `envelope.ts` versions —
 * these are load-bearing for Go interop):
 *
 *   - `to` → string array. Go's `DinaMessage.To` is `[]string`; a
 *     bare string drops at `json: cannot unmarshal string into Go
 *     struct field DinaMessage.to of type []string`.
 *   - `body` → base64. Go's `DinaMessage.Body` is `[]byte` with a
 *     `json:"body"` tag; Go's encoding/json auto-base64-encodes
 *     `[]byte` fields on marshal. Sending the raw body string made
 *     Go base64-decode it as bytes and fail at
 *     `illegal base64 data at input byte 0` for any body starting
 *     with a non-b64 char (like `{`).
 */

import type { DinaMessage } from '@dina/test-harness';
import { base64 } from '@scure/base';
import { buildMessageJSON } from '@dina/protocol';

export type { DinaMessage };

const REQUIRED_FIELDS = ['id', 'type', 'from', 'to', 'created_time', 'body'];

/**
 * Build a DinaMessage JSON string with deterministic key order. The TS
 * `DinaMessage` type keeps `body` as a display string for ergonomics;
 * the emitted wire shape has the base64-encoded UTF-8 bytes.
 */
export function buildMessage(msg: DinaMessage): string {
  // Core owns base64 (@scure/base dep); protocol's `buildMessageJSON`
  // is crypto/encoding-free and does the deterministic key-ordered
  // JSON assembly. Task 1.19.
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
