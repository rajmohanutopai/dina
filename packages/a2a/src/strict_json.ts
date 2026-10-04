/**
 * A strict I-JSON (RFC 7493) parser for every JSON text Dina reads from an
 * A2A peer: request bodies, response bodies, Agent Cards, key sets.
 *
 * `JSON.parse` is lenient in four ways that matter at a trust boundary, and
 * this parser refuses each:
 *  - duplicate member names: `JSON.parse` keeps the last, so a signed body
 *    with two `method` members can mean one thing to the signer and another
 *    to the executor (RFC 7493 §2.3 forbids them);
 *  - `__proto__` as a member name: `JSON.parse` makes it an own key, but any
 *    later copy by assignment turns it into a prototype change. No A2A or
 *    Dina structure uses the name;
 *  - lone surrogates, raw or escaped (RFC 7493 §2.1);
 *  - numbers outside IEEE 754 double range, which `JSON.parse` turns into
 *    `Infinity` (RFC 7493 §2.2).
 * It also caps nesting, so a deep text cannot exhaust the stack.
 *
 * The grammar is RFC 8259 exactly: no comments, no trailing commas, no
 * leading `+`, no leading zeros, no bare control characters in strings.
 */

import { A2A_LIMITS } from './constants';

import type { JsonObject, JsonValue } from './json';

export type StrictJsonFailure =
  | 'syntax'
  | 'duplicate_member'
  | 'forbidden_member'
  | 'too_deep'
  | 'lone_surrogate'
  | 'number_out_of_range';

export type StrictJsonResult =
  | { ok: true; value: JsonValue }
  | { ok: false; reason: StrictJsonFailure };

export const FORBIDDEN_MEMBER_NAME = '__proto__';

class ParseFailure extends Error {
  constructor(readonly reason: StrictJsonFailure) {
    super(reason);
  }
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class Parser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) throw new ParseFailure('syntax');
    return value;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.pos += 1;
    }
  }

  private parseValue(depth: number): JsonValue {
    if (depth > this.maxDepth) throw new ParseFailure('too_deep');
    const c = this.text.charAt(this.pos);
    switch (c) {
      case '{':
        return this.parseObject(depth);
      case '[':
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case 't':
        return this.literal('true', true);
      case 'f':
        return this.literal('false', false);
      case 'n':
        return this.literal('null', null);
      default:
        return this.parseNumber();
    }
  }

  private literal<T extends JsonValue>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) throw new ParseFailure('syntax');
    this.pos += word.length;
    return value;
  }

  private parseNumber(): number {
    NUMBER_RE.lastIndex = this.pos;
    const match = NUMBER_RE.exec(this.text);
    if (match === null || match[0] === '') throw new ParseFailure('syntax');
    this.pos += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new ParseFailure('number_out_of_range');
    return value;
  }

  private parseString(): string {
    this.pos += 1; // opening quote
    let out = '';
    let runStart = this.pos;
    for (;;) {
      if (this.pos >= this.text.length) throw new ParseFailure('syntax');
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x22) {
        out += this.text.slice(runStart, this.pos);
        this.pos += 1;
        break;
      }
      if (c < 0x20) throw new ParseFailure('syntax');
      if (c === 0x5c) {
        out += this.text.slice(runStart, this.pos);
        out += this.parseEscape();
        runStart = this.pos;
        continue;
      }
      this.pos += 1;
    }
    if (hasLoneSurrogateCodeUnit(out)) throw new ParseFailure('lone_surrogate');
    return out;
  }

  /** At a backslash; returns the escaped text and moves past it. */
  private parseEscape(): string {
    const e = this.text.charAt(this.pos + 1);
    this.pos += 2;
    switch (e) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new ParseFailure('syntax');
        this.pos += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        throw new ParseFailure('syntax');
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.pos += 1;
    const out: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text.charAt(this.pos) === ']') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      out.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const c = this.text.charAt(this.pos);
      this.pos += 1;
      if (c === ']') return out;
      if (c !== ',') throw new ParseFailure('syntax');
    }
  }

  private parseObject(depth: number): JsonObject {
    this.pos += 1;
    const out: JsonObject = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text.charAt(this.pos) === '}') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text.charAt(this.pos) !== '"') throw new ParseFailure('syntax');
      const key = this.parseString();
      if (key === FORBIDDEN_MEMBER_NAME) throw new ParseFailure('forbidden_member');
      if (seen.has(key)) throw new ParseFailure('duplicate_member');
      seen.add(key);
      this.skipWhitespace();
      if (this.text.charAt(this.pos) !== ':') throw new ParseFailure('syntax');
      this.pos += 1;
      this.skipWhitespace();
      out[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const c = this.text.charAt(this.pos);
      this.pos += 1;
      if (c === '}') return out;
      if (c !== ',') throw new ParseFailure('syntax');
    }
  }
}

function hasLoneSurrogateCodeUnit(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Parse `text` as one I-JSON document. `maxDepth` counts containers the way
 * `canonicalize` does (the root value is depth 0), so a document this parser
 * accepts never exceeds the canonicalizer's depth.
 */
export function parseStrictJson(
  text: string,
  maxDepth: number = A2A_LIMITS.maxJsonDepth,
): StrictJsonResult {
  try {
    return { ok: true, value: new Parser(text, maxDepth).parseDocument() };
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * The same refusals for a value that did not come through the parser (an
 * object built in-process, or parsed by someone else): a `__proto__` member
 * anywhere, or nesting past `maxDepth`. Null when neither.
 */
export function untrustedJsonProblem(
  value: unknown,
  maxDepth: number = A2A_LIMITS.maxJsonDepth,
): 'forbidden_member' | 'too_deep' | null {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const v = item.value;
    if (item.depth > maxDepth) return 'too_deep';
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const member of v) stack.push({ value: member, depth: item.depth + 1 });
      continue;
    }
    for (const key of Object.keys(v)) {
      if (key === FORBIDDEN_MEMBER_NAME) return 'forbidden_member';
      stack.push({ value: (v as Record<string, unknown>)[key], depth: item.depth + 1 });
    }
  }
  return null;
}
