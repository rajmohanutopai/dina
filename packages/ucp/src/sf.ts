/**
 * RFC 8941 Structured Field Values: the Dictionary, Inner List, Item and
 * Parameters forms, parsed and serialized exactly as RFC 8941 §4 specifies.
 *
 * UCP carries three headers in this form: `UCP-Agent` (a Dictionary whose
 * `profile` member is an sf-string, overview §"UCP-Agent"), and RFC 9421's
 * `Signature-Input` (a Dictionary of Inner Lists with parameters) and
 * `Signature` (a Dictionary of Byte Sequences).
 *
 * Parsing is strict: anything the RFC says "fails parsing" throws, and the
 * caller treats the whole header as absent (RFC 8941 §4.2). Nothing is
 * repaired, so a value that parsed always serializes back to the same text.
 */

import { base64Decode, base64Encode } from '@dina/a2a';

export type SfBareItem =
  | { type: 'integer'; value: number }
  | { type: 'decimal'; value: number }
  | { type: 'string'; value: string }
  | { type: 'token'; value: string }
  | { type: 'bytes'; value: Uint8Array }
  | { type: 'boolean'; value: boolean };

export type SfParameters = [string, SfBareItem][];

export interface SfItem {
  kind: 'item';
  value: SfBareItem;
  params: SfParameters;
}

export interface SfInnerList {
  kind: 'inner-list';
  items: SfItem[];
  params: SfParameters;
}

export type SfMember = SfItem | SfInnerList;
export type SfDictionary = [string, SfMember][];

export class SfParseError extends Error {
  constructor(message: string) {
    super(`structured field: ${message}`);
    this.name = 'SfParseError';
  }
}

const MAX_INTEGER = 999_999_999_999_999;
const KEY_FIRST = /[a-z*]/;
const KEY_REST = /[a-z0-9_\-.*]/;
const TOKEN_FIRST = /[A-Za-z*]/;
// tchar (RFC 9110 §5.6.2) plus ":" and "/".
const TOKEN_REST = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;

class Cursor {
  pos = 0;
  constructor(readonly text: string) {}
  peek(): string {
    return this.text[this.pos] ?? '';
  }
  done(): boolean {
    return this.pos >= this.text.length;
  }
  skipSp(): void {
    while (this.peek() === ' ') this.pos++;
  }
  skipOws(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }
}

// ---------------------------------------------------------------- parsing

/** RFC 8941 §4.2.2: parse a Dictionary. Duplicate keys: the last wins, in the first one's place. */
export function parseDictionary(input: string): SfDictionary {
  const c = new Cursor(stripOuterSp(input));
  const out: SfDictionary = [];
  while (!c.done()) {
    const key = parseKey(c);
    let member: SfMember;
    if (c.peek() === '=') {
      c.pos++;
      member = parseItemOrInnerList(c);
    } else {
      member = {
        kind: 'item',
        value: { type: 'boolean', value: true },
        params: parseParameters(c),
      };
    }
    const existing = out.findIndex(([k]) => k === key);
    if (existing >= 0) out[existing] = [key, member];
    else out.push([key, member]);
    c.skipOws();
    if (c.done()) return out;
    if (c.peek() !== ',') throw new SfParseError(`expected "," at ${c.pos}`);
    c.pos++;
    c.skipOws();
    if (c.done()) throw new SfParseError('trailing comma');
  }
  return out;
}

/** RFC 8941 §4.2.3: parse an Item. */
export function parseItem(input: string): SfItem {
  const c = new Cursor(stripOuterSp(input));
  const item = parseItemAt(c);
  if (!c.done()) throw new SfParseError(`trailing characters at ${c.pos}`);
  return item;
}

function stripOuterSp(input: string): string {
  // RFC 8941 §4.2 step 2: discard leading and trailing SP.
  return input.replace(/^ +/, '').replace(/ +$/, '');
}

function parseItemOrInnerList(c: Cursor): SfMember {
  if (c.peek() === '(') return parseInnerList(c);
  return parseItemAt(c);
}

function parseInnerList(c: Cursor): SfInnerList {
  if (c.peek() !== '(') throw new SfParseError('expected "("');
  c.pos++;
  const items: SfItem[] = [];
  while (!c.done()) {
    c.skipSp();
    if (c.peek() === ')') {
      c.pos++;
      return { kind: 'inner-list', items, params: parseParameters(c) };
    }
    items.push(parseItemAt(c));
    const next = c.peek();
    if (next !== ' ' && next !== ')') throw new SfParseError(`bad inner list at ${c.pos}`);
  }
  throw new SfParseError('unterminated inner list');
}

function parseItemAt(c: Cursor): SfItem {
  const value = parseBareItem(c);
  return { kind: 'item', value, params: parseParameters(c) };
}

function parseParameters(c: Cursor): SfParameters {
  const params: SfParameters = [];
  while (c.peek() === ';') {
    c.pos++;
    c.skipSp();
    const key = parseKey(c);
    let value: SfBareItem = { type: 'boolean', value: true };
    if (c.peek() === '=') {
      c.pos++;
      value = parseBareItem(c);
    }
    const existing = params.findIndex(([k]) => k === key);
    if (existing >= 0) params[existing] = [key, value];
    else params.push([key, value]);
  }
  return params;
}

function parseKey(c: Cursor): string {
  if (!KEY_FIRST.test(c.peek())) throw new SfParseError(`bad key start at ${c.pos}`);
  let key = '';
  while (!c.done() && KEY_REST.test(c.peek())) key += c.text[c.pos++];
  return key;
}

function parseBareItem(c: Cursor): SfBareItem {
  const ch = c.peek();
  if (ch === '-' || /[0-9]/.test(ch)) return parseNumber(c);
  if (ch === '"') return parseString(c);
  if (ch === ':') return parseBytes(c);
  if (ch === '?') return parseBoolean(c);
  if (TOKEN_FIRST.test(ch)) return parseToken(c);
  throw new SfParseError(`bad item at ${c.pos}`);
}

function parseNumber(c: Cursor): SfBareItem {
  let sign = 1;
  if (c.peek() === '-') {
    sign = -1;
    c.pos++;
  }
  if (!/[0-9]/.test(c.peek())) throw new SfParseError('number without digits');
  let text = '';
  let decimal = false;
  while (!c.done()) {
    const ch = c.peek();
    if (/[0-9]/.test(ch)) {
      text += ch;
      c.pos++;
    } else if (ch === '.' && !decimal) {
      if (text.length > 12) throw new SfParseError('decimal integer part too long');
      decimal = true;
      text += ch;
      c.pos++;
    } else {
      break;
    }
    if (!decimal && text.length > 15) throw new SfParseError('integer too long');
    if (decimal && text.length > 16) throw new SfParseError('decimal too long');
  }
  if (!decimal) return { type: 'integer', value: sign * Number.parseInt(text, 10) };
  if (text.endsWith('.')) throw new SfParseError('decimal ends in "."');
  if (text.length - text.indexOf('.') - 1 > 3) throw new SfParseError('decimal fraction too long');
  return { type: 'decimal', value: sign * Number.parseFloat(text) };
}

function parseString(c: Cursor): SfBareItem {
  c.pos++; // opening quote
  let out = '';
  while (!c.done()) {
    const ch = c.text[c.pos++] as string;
    if (ch === '\\') {
      if (c.done()) throw new SfParseError('string ends in escape');
      const next = c.text[c.pos++] as string;
      if (next !== '"' && next !== '\\') throw new SfParseError('bad escape in string');
      out += next;
    } else if (ch === '"') {
      return { type: 'string', value: out };
    } else {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code > 0x7e)
        throw new SfParseError('non-ASCII or control character in string');
      out += ch;
    }
  }
  throw new SfParseError('unterminated string');
}

function parseToken(c: Cursor): SfBareItem {
  let out = c.text[c.pos++] as string;
  while (!c.done() && TOKEN_REST.test(c.peek())) out += c.text[c.pos++];
  return { type: 'token', value: out };
}

function parseBytes(c: Cursor): SfBareItem {
  c.pos++; // opening colon
  const start = c.pos;
  while (!c.done() && c.peek() !== ':') {
    if (!BASE64_CHAR.test(c.peek())) throw new SfParseError('bad byte sequence character');
    c.pos++;
  }
  if (c.done()) throw new SfParseError('unterminated byte sequence');
  const b64 = c.text.slice(start, c.pos);
  c.pos++; // closing colon
  const bytes = decodeSfBase64(b64);
  if (bytes === null) throw new SfParseError('bad base64 in byte sequence');
  return { type: 'bytes', value: bytes };
}

function parseBoolean(c: Cursor): SfBareItem {
  c.pos++; // "?"
  const ch = c.text[c.pos++];
  if (ch === '1') return { type: 'boolean', value: true };
  if (ch === '0') return { type: 'boolean', value: false };
  throw new SfParseError('bad boolean');
}

// ------------------------------------------------------------ serializing

/** RFC 8941 §4.1.2: serialize a Dictionary. */
export function serializeDictionary(dict: SfDictionary): string {
  return dict
    .map(([key, member]) => {
      checkKey(key);
      if (member.kind === 'item' && member.value.type === 'boolean' && member.value.value) {
        return key + serializeParameters(member.params);
      }
      return `${key}=${serializeMember(member)}`;
    })
    .join(', ');
}

export function serializeMember(member: SfMember): string {
  if (member.kind === 'inner-list') {
    return `(${member.items.map(serializeItem).join(' ')})${serializeParameters(member.params)}`;
  }
  return serializeItem(member);
}

export function serializeItem(item: SfItem): string {
  return serializeBareItem(item.value) + serializeParameters(item.params);
}

export function serializeParameters(params: SfParameters): string {
  return params
    .map(([key, value]) => {
      checkKey(key);
      if (value.type === 'boolean' && value.value) return `;${key}`;
      return `;${key}=${serializeBareItem(value)}`;
    })
    .join('');
}

export function serializeBareItem(item: SfBareItem): string {
  switch (item.type) {
    case 'integer':
      if (!Number.isInteger(item.value) || Math.abs(item.value) > MAX_INTEGER) {
        throw new SfParseError('integer out of range');
      }
      return String(item.value);
    case 'decimal': {
      const rounded = Math.round(item.value * 1000) / 1000;
      if (Math.abs(Math.trunc(rounded)) >= 1e12) throw new SfParseError('decimal out of range');
      const text = rounded.toFixed(3).replace(/0{1,2}$/, '');
      return text.endsWith('.') ? `${text}0` : text;
    }
    case 'string':
      for (const ch of item.value) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code > 0x7e)
          throw new SfParseError('string has a character sf-string cannot carry');
      }
      return `"${item.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case 'token':
      if (
        !TOKEN_FIRST.test(item.value[0] ?? '') ||
        ![...item.value.slice(1)].every((ch) => TOKEN_REST.test(ch))
      ) {
        throw new SfParseError('bad token');
      }
      return item.value;
    case 'bytes':
      return `:${base64Encode(item.value)}:`;
    case 'boolean':
      return item.value ? '?1' : '?0';
  }
}

function checkKey(key: string): void {
  if (!KEY_FIRST.test(key[0] ?? '') || ![...key.slice(1)].every((ch) => KEY_REST.test(ch))) {
    throw new SfParseError(`bad key "${key}"`);
  }
}

// ------------------------------------------------------------ helpers

export function sfString(value: string): SfItem {
  return { kind: 'item', value: { type: 'string', value }, params: [] };
}

/** The value of a Dictionary member, or undefined. */
export function dictGet(dict: SfDictionary, key: string): SfMember | undefined {
  return dict.find(([k]) => k === key)?.[1];
}

/** The value of a parameter, or undefined. */
export function paramGet(params: SfParameters, key: string): SfBareItem | undefined {
  return params.find(([k]) => k === key)?.[1];
}

// Byte sequences are standard base64 (RFC 8941 §3.3.5), via @dina/a2a's
// strict codec. RFC 8941 §4.2.7 says parsers SHOULD accept missing padding,
// so padding is added before the strict decode; anything else it refuses.
/**
 * RFC 8941 §4.2.7: a byte sequence SHOULD be padded, and a parser accepts it
 * without padding. Padding that is present must be exactly what the length
 * needs (at most two `=`, at the end); anything else is malformed.
 */
function decodeSfBase64(text: string): Uint8Array | null {
  const core = text.replace(/=+$/, '');
  const pads = text.length - core.length;
  if (core.length % 4 === 1) return null;
  const needed = (4 - (core.length % 4)) % 4;
  if (pads !== 0 && pads !== needed) return null;
  return base64Decode(core + '='.repeat(needed));
}
