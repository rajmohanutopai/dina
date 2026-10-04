/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * A2A requires it for Agent Card signatures (spec §8.4.1); Dina also uses it
 * for every A2A digest and signed contract (card pins, consent hashes, the
 * Lane 3 directory envelope and fence), so one canonical form serves both.
 *
 * RFC 8785 rules, all applied here:
 *  - object members sorted by key, comparing UTF-16 code units (§3.2.3);
 *  - numbers in the ECMAScript `Number.prototype.toString` form (§3.2.2.3),
 *    which is what `JSON.stringify` emits for a finite number, `-0` → `0`;
 *  - strings escaped as `JSON.stringify` does (§3.2.2.2);
 *  - no insignificant whitespace.
 *
 * Inputs that are not I-JSON (RFC 7493) are REFUSED, never repaired: a
 * non-finite number, a lone surrogate, `undefined`, a function, a class
 * instance, a cycle, or nesting deeper than the cap. A value that needed
 * repair to canonicalize would sign or hash something nobody sent.
 */

import { A2A_LIMITS } from './constants';
import { hasLoneSurrogate, isPlainObject } from './json';

export class JcsError extends Error {
  constructor(message: string) {
    super(`jcs: ${message}`);
    this.name = 'JcsError';
  }
}

export function canonicalize(value: unknown): string {
  return encode(value, 0);
}

function encode(value: unknown, depth: number): string {
  if (depth > A2A_LIMITS.maxJsonDepth) throw new JcsError('nesting too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('non-finite number');
      // JSON.stringify(-0) is "0", as RFC 8785 requires.
      return JSON.stringify(value);
    case 'string':
      if (hasLoneSurrogate(value)) throw new JcsError('lone surrogate in string');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new JcsError(`unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      if (item === undefined) throw new JcsError('undefined array element');
      items.push(encode(item, depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  if (!isPlainObject(value)) throw new JcsError('not a plain object');
  const keys = Object.keys(value);
  for (const key of keys) {
    if (hasLoneSurrogate(key)) throw new JcsError('lone surrogate in key');
  }
  // Default sort compares UTF-16 code units, exactly RFC 8785 §3.2.3.
  keys.sort();
  const members: string[] = [];
  for (const key of keys) {
    const member = value[key];
    if (member === undefined) throw new JcsError(`undefined member "${key}"`);
    members.push(`${JSON.stringify(key)}:${encode(member, depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}
