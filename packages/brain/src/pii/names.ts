/**
 * Known names (docs/PII_ARCHITECTURE_V2.md §5): finding the people the owner
 * talks about in text bound for a cloud model, and Brain's copy of the list.
 *
 * Matching runs on Hermes, so it uses no Unicode regex classes: a "letter" is
 * a character with distinct upper and lower forms, or a digit. Scripts
 * without case match as plain substrings.
 */

import type { PiiNameGroup, PiiNamesResult } from '@dina/core';

/** One name found in text: its span and the person it belongs to. */
export interface NameMatch {
  start: number;
  end: number;
  value: string;
  group: number;
}

/**
 * Names that are also everyday words. These match only with their capital
 * letter, so "in May" or "you will" are left alone. Compared in lower case.
 */
const EVERYDAY_WORD_NAMES: ReadonlySet<string> = new Set([
  'may',
  'june',
  'april',
  'august',
  'summer',
  'autumn',
  'winter',
  'dawn',
  'eve',
  'will',
  'bill',
  'mark',
  'pat',
  'sue',
  'jack',
  'frank',
  'rich',
  'art',
  'chase',
  'drew',
  'rose',
  'lily',
  'iris',
  'daisy',
  'violet',
  'holly',
  'ivy',
  'heather',
  'fern',
  'olive',
  'ruby',
  'pearl',
  'amber',
  'crystal',
  'jade',
  'jasmine',
  'hazel',
  'sage',
  'river',
  'sky',
  'storm',
  'hope',
  'faith',
  'grace',
  'joy',
  'glory',
  'honor',
  'honour',
  'patience',
  'charity',
  'mercy',
  'sunny',
  'rusty',
  'buddy',
  'max',
  'king',
  'prince',
  'earl',
  'duke',
  'dean',
  'guy',
  'gene',
  'norm',
  'rod',
  'ray',
  'skip',
  'chip',
  'gus',
  'bud',
  'cliff',
  'dale',
  'glen',
  'wade',
  'brook',
  'grant',
  'hunter',
  'miles',
  'neil',
  'pierce',
  'reed',
  'rob',
  'sterling',
  'win',
  'young',
]);

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === '') return false;
  if (ch >= '0' && ch <= '9') return true;
  if (ch === '_') return true;
  return ch.toLowerCase() !== ch.toUpperCase();
}

/** True when the name's script has case (Latin, Greek, Cyrillic...). */
function hasCase(name: string): boolean {
  for (const ch of name) if (ch.toLowerCase() !== ch.toUpperCase()) return true;
  return false;
}

interface Needle {
  name: string;
  lower: string;
  group: number;
  /** An everyday word: counts only when the text writes it with a capital. */
  exact: boolean;
  /** Needs a non-letter on each side (scripts with case). */
  bounded: boolean;
}

/** A compiled list of names, ready to search text. */
export class NameMatcher {
  private readonly needles: Needle[];

  constructor(groups: readonly PiiNameGroup[]) {
    const needles: Needle[] = [];
    for (const g of groups) {
      for (const raw of g.names) {
        const name = raw.trim();
        if (name.length < 2) continue;
        const lower = fold(name).folded;
        needles.push({
          name,
          lower,
          group: g.group,
          exact: EVERYDAY_WORD_NAMES.has(lower),
          bounded: hasCase(name),
        });
      }
    }
    // Longer names first, so "Emma Watson" wins over "Emma".
    needles.sort((a, b) => b.name.length - a.name.length);
    this.needles = needles;
  }

  get size(): number {
    return this.needles.length;
  }

  /** Every known name in `text`, longest first where they overlap. */
  find(text: string): NameMatch[] {
    if (text === '' || this.needles.length === 0) return [];
    // Lowered a character at a time with a map back to the text, so a
    // character whose lower case is longer (Turkish İ) stays local (§5.3).
    const { folded, origin } = fold(text);
    const taken: boolean[] = [];
    const out: NameMatch[] = [];
    for (const n of this.needles) {
      let from = 0;
      for (;;) {
        const hit = folded.indexOf(n.lower, from);
        if (hit < 0) break;
        from = hit + 1;
        const endHit = hit + n.lower.length;
        // A match must begin and end on whole characters of the text.
        if (hit > 0 && origin[hit - 1] === origin[hit]) continue;
        if (endHit < folded.length && origin[endHit - 1] === origin[endHit]) continue;
        const at = origin[hit] as number;
        const end = endHit < folded.length ? (origin[endHit] as number) : text.length;
        if (n.bounded && (isWordChar(text[at - 1]) || isWordChar(text[end]))) continue;
        // An everyday-word name counts only written with a capital: "May", never "may".
        if (n.exact && !startsUpper(text.slice(at, end))) continue;
        let free = true;
        for (let i = at; i < end; i++) if (taken[i] === true) free = false;
        if (!free) continue;
        for (let i = at; i < end; i++) taken[i] = true;
        out.push({ start: at, end, value: text.slice(at, end), group: n.group });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
}

/**
 * The text lowered character by character, and for each unit of the result
 * the offset of the character in `text` it came from.
 */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  let at = 0;
  for (const ch of text) {
    // Final sigma is sigma: lowered on its own, Σ always becomes σ.
    const lower = ch.toLowerCase().replace('ς', 'σ');
    folded += lower;
    // One entry per UTF-16 unit of the lowered character.
    origin.push(...new Array<number>(lower.length).fill(at));
    at += ch.length;
  }
  return { folded, origin };
}

function startsUpper(value: string): boolean {
  const first = [...value][0] ?? '';
  return first !== first.toLowerCase();
}

/** How Brain asks Core for the list (`CoreClient.piiNames`). */
export type PiiNamesFetch = (known?: string) => Promise<PiiNamesResult>;

export interface NameLexiconOptions {
  fetch: PiiNamesFetch;
  /** Told when no current list could be had; gets an error name, never names. */
  onDegraded?: (reason: string) => void;
}

/** No list at least as new as Core's could be had; nothing may leave the node. */
export class NamesUnavailableError extends Error {
  constructor(reason: string) {
    super(`pii names unavailable (${reason}); refusing to send`);
    this.name = 'NamesUnavailableError';
  }
}

/**
 * Brain's copy of the known names (§5.2; REAL_LIFE_FIXES §4.3).
 *
 * `freshMatcher()` is the only way to get a matcher. Each call asks Core,
 * at that moment, whether the copy is current (`known` = the version held);
 * Core answers "unchanged" or sends the new list. So a name written to the
 * people graph or contacts by any writer, on any client, is hidden on the
 * very next call that leaves the node. If Core cannot be asked, the call
 * throws: the caller must not send. Answers are applied in request order, so
 * a slow older answer never replaces a newer list.
 */
export class NameLexicon {
  private matcher = new NameMatcher([]);
  private version: string | null = null;
  private issued = 0;
  private applied = 0;

  constructor(private readonly options: NameLexiconOptions) {}

  /** A matcher built from a list at least as new as Core's at call time. */
  async freshMatcher(): Promise<NameMatcher> {
    const seq = ++this.issued;
    let known: string | undefined = this.version ?? undefined;
    let result: PiiNamesResult | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await this.options.fetch(known);
      } catch (err) {
        const reason = err instanceof Error ? err.name : 'unknown';
        this.options.onDegraded?.(reason);
        throw new NamesUnavailableError(reason);
      }
      if (result.unchanged !== true) break;
      // Matcher and version always change together, so a match is current.
      if (result.version === this.version) return this.matcher;
      // "Unchanged" against a version another call has since replaced:
      // ask once more for the whole list.
      known = undefined;
      result = undefined;
    }
    if (result === undefined || result.groups === undefined) {
      this.options.onDegraded?.('no_list');
      throw new NamesUnavailableError('no_list');
    }
    const matcher = new NameMatcher(result.groups);
    if (seq > this.applied) {
      this.applied = seq;
      this.matcher = matcher;
      this.version = result.version;
    }
    // This call uses the list its own answer carried, which is current as
    // of this call even when a newer answer has already been applied.
    return matcher;
  }

  /** Whether a list has ever loaded. */
  get loaded(): boolean {
    return this.version !== null;
  }
}

let installed: NameLexicon | null = null;

/**
 * The host's lexicon, installed at boot. Brain consumers that open a PII
 * session without one in hand (the cloud gate, safe embeddings) read it here.
 */
export function installNameLexicon(lexicon: NameLexicon | null): void {
  installed = lexicon;
}

export function getNameLexicon(): NameLexicon | null {
  return installed;
}
