/**
 * Reading what a merchant or the profile host sent: UTF-8 checked (a byte
 * that is not UTF-8 is refused, never replaced), then strict JSON (duplicate
 * members and `__proto__` refused, numbers in range) through @dina/a2a.
 */

import { parseStrictJson } from '@dina/a2a';

/** The bytes as UTF-8 text, or null when they are not UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type JsonRead = { ok: true; value: unknown } | { ok: false; reason: 'utf8' | 'json' };

export function readJsonBytes(bytes: Uint8Array): JsonRead {
  const text = utf8Text(bytes);
  if (text === null) return { ok: false, reason: 'utf8' };
  const parsed = parseStrictJson(text);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, reason: 'json' };
}

/** The value, or undefined when the bytes are not UTF-8 strict JSON. */
export function jsonOrUndefined(bytes: Uint8Array): unknown {
  const read = readJsonBytes(bytes);
  return read.ok ? read.value : undefined;
}
