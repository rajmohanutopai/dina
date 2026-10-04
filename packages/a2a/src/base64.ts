/**
 * Standard base64 with padding (RFC 4648 §4), strict: one byte string has
 * one accepted spelling (padding required, no whitespace, zero trailing
 * bits). Used where a Dina contract names plain base64 (the Lane 3
 * directory envelope and fence signatures, design §8.2).
 */

import { base64urlDecode, base64urlEncode } from './base64url';

export function base64Encode(bytes: Uint8Array): string {
  const url = base64urlEncode(bytes);
  const padded = url + '='.repeat((4 - (url.length % 4)) % 4);
  return padded.replace(/-/g, '+').replace(/_/g, '/');
}

export function base64Decode(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  if (/[-_]/.test(text)) return null;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const body = text.slice(0, text.length - pad);
  if (body.includes('=')) return null;
  return base64urlDecode(body.replace(/\+/g, '-').replace(/\//g, '_'));
}
