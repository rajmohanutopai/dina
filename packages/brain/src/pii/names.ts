/**
 * Known names (docs/PII_ARCHITECTURE_V2.md §5): finding the people the owner
 * talks about in text bound for a cloud model, and Brain's copy of the list.
 *
 * Matching runs on Hermes, so it uses no Unicode regex classes: a "letter" is
 * a character with distinct upper and lower forms, or a digit. Scripts
 * without case match as plain substrings.
 */

import type { PiiNameGroup } from '@dina/core';

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
export type PiiNamesFetch = () => Promise<PiiNameGroup[]>;

export interface NameLexiconOptions {
  fetch: PiiNamesFetch;
  nowMs?: () => number;
  /** A copy older than this is refreshed in the background. */
  refreshAfterMs?: number;
  /** How long the first model call waits for the first copy. */
  firstWaitMs?: number;
  /** Told when no copy could be had; gets counts only, never names. */
  onDegraded?: (reason: string) => void;
}

export const NAME_LEXICON_REFRESH_MS = 30_000;
export const NAME_LEXICON_FIRST_WAIT_MS = 2_000;

/**
 * Brain's copy of the known names (§5.2). The first call waits briefly for a
 * copy; later calls use the current one and refresh it in the background once
 * it is old. When Core does not answer, the last good copy stays in use; with
 * none, the matcher is empty and the call goes ahead on patterns alone.
 */
export class NameLexicon {
  private matcher = new NameMatcher([]);
  private loadedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  /** An invalidate came during a fetch. */
  private again = false;
  private readonly now: () => number;
  private readonly refreshAfterMs: number;
  private readonly firstWaitMs: number;

  constructor(private readonly options: NameLexiconOptions) {
    this.now = options.nowMs ?? Date.now;
    this.refreshAfterMs = options.refreshAfterMs ?? NAME_LEXICON_REFRESH_MS;
    this.firstWaitMs = options.firstWaitMs ?? NAME_LEXICON_FIRST_WAIT_MS;
  }

  /** The matcher to use now, refreshing first or in the background as §5.2 says. */
  async current(): Promise<NameMatcher> {
    if (this.loadedAt === null) {
      await this.waitAtMost(this.refresh(), this.firstWaitMs);
    } else if (this.now() - this.loadedAt >= this.refreshAfterMs) {
      void this.refresh();
    }
    return this.matcher;
  }

  /**
   * The matcher to use now, without waiting: for callers that scrub
   * synchronously. Starts a refresh when there is no copy or it is old.
   */
  peek(): NameMatcher {
    if (this.loadedAt === null || this.now() - this.loadedAt >= this.refreshAfterMs)
      void this.refresh();
    return this.matcher;
  }

  /** The people graph changed: fetch a new copy now. */
  invalidate(): void {
    // A fetch already under way may have started before the change: fetch
    // again once it settles.
    if (this.inFlight !== null) this.again = true;
    else void this.refresh();
  }

  /** Whether a copy has ever loaded. */
  get loaded(): boolean {
    return this.loadedAt !== null;
  }

  private refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const run = (async () => {
      try {
        const groups = await this.options.fetch();
        this.matcher = new NameMatcher(groups);
        this.loadedAt = this.now();
      } catch (err) {
        if (this.loadedAt === null)
          this.options.onDegraded?.(err instanceof Error ? err.name : 'unknown');
      } finally {
        this.inFlight = null;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      }
    })();
    this.inFlight = run;
    return run;
  }

  private async waitAtMost(p: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([p, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
