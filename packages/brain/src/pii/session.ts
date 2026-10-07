/**
 * One call's token table (docs/PII_ARCHITECTURE_V2.md §4): every message,
 * tool argument and system prompt in a model call is scrubbed through one
 * session, so a value keeps one token across all of them and every token
 * goes back to exactly one string. Never stored, never logged.
 */

import { detectPII } from '@dina/core';

import { NameMatcher } from './names';
import { detectTier2 } from './tier2_patterns';

/** One replacement: the token and the exact text it stands for. */
export interface PiiSessionEntry {
  token: string;
  type: string;
  value: string;
}

interface Span {
  start: number;
  end: number;
  type: string;
  value: string;
  /** Known names only: the person's group number. */
  group?: number;
}

const EMPTY_MATCHER = new NameMatcher([]);

/** The line the router adds to the system prompt when anything was replaced (§3). */
export const PII_TOKEN_NOTE =
  'Text in square brackets such as [PERSON_1] or [EMAIL_1] stands for a private value. ' +
  'Copy these tokens exactly as written, brackets included, wherever you need the value.';

export class PiiSession {
  private readonly byValue = new Map<string, PiiSessionEntry>();
  private readonly byToken = new Map<string, PiiSessionEntry>();
  private readonly typeCounts = new Map<string, number>();
  /** Person group → its number in this session, and how many forms it has. */
  private readonly people = new Map<number, { n: number; forms: number }>();
  /** Tokens found in the text that this session did not mint: never minted. */
  private readonly reserved = new Set<string>();
  /** `TYPE_N` numbers those tokens use (alias forms included): skipped when minting. */
  private readonly takenNumbers = new Set<string>();

  /**
   * `names`: the people the owner knows (§5). `strangers`: names a detector
   * found in this call's text (§7). A known name wins over a stranger's of the
   * same span.
   */
  constructor(
    private readonly names: NameMatcher = EMPTY_MATCHER,
    private readonly strangers: NameMatcher = EMPTY_MATCHER,
  ) {}

  /** Replace every private value in `text` with its token. */
  scrub(text: string): string {
    if (text === '') return text;
    const spans = this.detect(text);
    if (spans.length === 0) return text;
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + this.tokenFor(s);
      at = s.end;
    }
    return out + text.slice(at);
  }

  /**
   * Set aside every token already in these texts before anything is minted,
   * so a literal `[EMAIL_1]` in a later message never comes back as an
   * earlier message's value (§4). The router calls this with every text of a
   * call first; `scrub` also sets aside what it meets.
   */
  reserve(texts: readonly string[]): void {
    for (const text of texts) for (const t of text.matchAll(TOKEN_PATTERN)) this.setAside(t);
  }

  /**
   * Put the exact values back (§4): one pass over the text, so a restored
   * value is never read again. A token with its brackets, or one standing
   * alone as a word without them (a model sometimes drops the brackets), is
   * restored when this session minted it; anything else is left as written.
   */
  rehydrate(text: string): string {
    if (text === '' || this.byToken.size === 0) return text;
    return text.replace(
      RESTORE_PATTERN,
      (match: string, open: string, body: string, close: string, at: number) => {
        if (open === '[' && close === ']') return this.byToken.get(match)?.value ?? match;
        if (open !== '' || close !== '') return match;
        const entry = this.byToken.get(`[${body}]`);
        if (entry === undefined) return match;
        if (isWordChar(text[at - 1]) || isWordChar(text[at + match.length])) return match;
        return entry.value;
      },
    );
  }

  /** Rehydrate every string inside a JSON-shaped value. */
  rehydrateDeep<T>(value: T): T {
    return this.walk(value, (s) => this.rehydrate(s)) as T;
  }

  /** Scrub every string inside a JSON-shaped value. */
  scrubDeep<T>(value: T): T {
    return this.walk(value, (s) => this.scrub(s)) as T;
  }

  entries(): PiiSessionEntry[] {
    return [...this.byToken.values()];
  }

  get size(): number {
    return this.byToken.size;
  }

  clear(): void {
    this.byValue.clear();
    this.byToken.clear();
    this.typeCounts.clear();
    this.people.clear();
    this.reserved.clear();
    this.takenNumbers.clear();
  }

  private detect(text: string): Span[] {
    const spans: Span[] = [];
    for (const m of detectPII(text))
      spans.push({ start: m.start, end: m.end, type: m.type, value: m.value });
    for (const m of detectTier2(text))
      spans.push({ start: m.start, end: m.end, type: m.entity_type, value: m.value });
    for (const m of this.names.find(text))
      spans.push({ start: m.start, end: m.end, type: 'PERSON', value: m.value, group: m.group });
    for (const m of this.strangers.find(text))
      spans.push({ start: m.start, end: m.end, type: 'PERSON', value: m.value, group: m.group });
    // Text that already holds tokens (typed, or left unrestored): never detect
    // inside one, and never mint one this session did not, or it would restore
    // to our value.
    const tokens: { start: number; end: number }[] = [];
    for (const t of text.matchAll(TOKEN_PATTERN)) {
      tokens.push({ start: t.index, end: t.index + t[0].length });
      this.setAside(t);
    }
    // Longer spans win; a span inside or across one already kept is dropped.
    spans.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const kept: Span[] = [];
    for (const s of spans) {
      if (tokens.some((k) => s.start < k.end && k.start < s.end)) continue;
      if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
      kept.push(s);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  private tokenFor(s: Span): string {
    const known = this.byValue.get(key(s.type, s.value));
    if (known !== undefined) return known.token;
    let token: string;
    if (s.type === 'PERSON' && s.group !== undefined) {
      let person = this.people.get(s.group);
      if (person === undefined) {
        person = { n: this.next('PERSON'), forms: 0 };
        this.people.set(s.group, person);
      }
      do {
        person.forms += 1;
        token =
          person.forms === 1 ? `[PERSON_${person.n}]` : `[PERSON_${person.n}_${person.forms}]`;
      } while (this.reserved.has(token));
    } else {
      token = `[${s.type}_${this.next(s.type)}]`;
    }
    const entry: PiiSessionEntry = { token, type: s.type, value: s.value };
    this.byValue.set(key(s.type, s.value), entry);
    this.byToken.set(token, entry);
    return token;
  }

  /**
   * A token met in text: when not ours, never mint it, nor reuse its number.
   * The number is recorded as taken (counters skip it), never used to move a
   * counter, so a huge number in the text cannot push one past exact integers.
   */
  private setAside(t: RegExpMatchArray): void {
    if (this.byToken.has(t[0])) return;
    this.reserved.add(t[0]);
    this.takenNumbers.add(`${t[1] as string}_${t[2] as string}`);
  }

  /** The next free number for a type: one not minted and not set aside. */
  private next(type: string): number {
    let n = this.typeCounts.get(type) ?? 0;
    do n += 1;
    while (this.takenNumbers.has(`${type}_${n}`));
    this.typeCounts.set(type, n);
    return n;
  }

  private walk(value: unknown, f: (s: string) => string): unknown {
    if (typeof value === 'string') return f(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, f));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = this.walk(v, f);
      return out;
    }
    return value;
  }
}

/** Exact text is the key: "emma" and "Emma" are two forms, each restored as written. */
function key(type: string, value: string): string {
  return `${type}\u0000${value}`;
}

/** A token this module mints: `[TYPE_N]` or `[PERSON_N_M]`. */
const TOKEN_PATTERN = /\[([A-Z][A-Z0-9_]*?)_(\d+)(?:_\d+)?\]/g;
/** A token with or without its brackets, for restoring in one pass. */
const RESTORE_PATTERN = /(\[?)([A-Z][A-Z0-9_]*_\d+(?:_\d+)?)(\]?)/g;

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[A-Za-z0-9_]/.test(ch);
}
