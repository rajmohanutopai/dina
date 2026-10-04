/**
 * JSON value types and guards shared by every module.
 *
 * Every check uses own properties only: a JSON object parsed from the wire
 * has own keys named `constructor` or `toString`, and an `in` test would let
 * the prototype chain answer for them.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
// A recursive object type has to be an interface: a `Record<string, JsonValue>`
// alias would reference itself through the generic and fail to compile.

export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * A realm's root `Object.prototype`: it has no prototype, and its own
 * `constructor` is the function `Object` whose `prototype` it is. Checked by
 * shape, so another realm's counts as well as this one's.
 */
function isRootObjectPrototype(obj: object): boolean {
  if (Object.getPrototypeOf(obj) !== null) return false;
  const ctor = Object.getOwnPropertyDescriptor(obj, 'constructor')?.value as unknown;
  return typeof ctor === 'function' && ctor.name === 'Object' && (ctor as { prototype?: unknown }).prototype === obj;
}

/**
 * A plain data object: not an array, and its prototype is null or a realm's
 * root `Object.prototype` (this realm's or another's: a vm context, or
 * `structuredClone` under a test runner). A class instance (`Date`, `Map`,
 * a custom class), an object built on another object (even one with no
 * prototype of its own), and a realm's `Object.prototype` itself never are.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === null) return !isRootObjectPrototype(value);
  return isRootObjectPrototype(proto) && Object.prototype.toString.call(value) === '[object Object]';
}

export function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** UTF-8 encode — runtime-agnostic (Node, Hermes, browsers, workers). */
export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Length(s: string): number {
  return utf8Bytes(s).length;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Number of Unicode code points (what JSON Schema `maxLength` counts). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** True when `s` contains a UTF-16 surrogate that is not part of a pair. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

export const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

/** Freeze a JSON value and everything inside it. */
export function deepFreeze<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) deepFreeze(member as JsonValue);
    Object.freeze(value);
  }
  return value;
}
