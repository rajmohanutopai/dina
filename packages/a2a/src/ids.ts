/**
 * RFC 9562 version 4 UUIDs from caller-supplied randomness. A2A external ids
 * are fresh UUIDs (design A2A-I5); this package has no runtime dependencies,
 * so the 16 random bytes come from the host.
 */

import { bytesToHex } from './json';

export function uuidV4FromBytes(random: Uint8Array): string {
  if (random.length !== 16) throw new Error('uuidV4FromBytes: need exactly 16 random bytes');
  const b = Uint8Array.from(random);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}
