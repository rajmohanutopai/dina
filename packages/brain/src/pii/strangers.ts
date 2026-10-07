/**
 * Names of people Dina does not know (docs/PII_ARCHITECTURE_V2.md §7): a
 * host installs a detector (on iPhone, Apple's on-device model with NLTagger
 * as fallback); this module decides which of its candidates to hide.
 *
 * A detector only proposes. Here a candidate is dropped when it is a pronoun
 * or relationship word, shorter than two letters, scored under the hide
 * score, holds a token, or does not appear in the text. Results are cached
 * per paragraph by hash (no text is kept), and each model call spends at
 * most a fixed time on detection, newest text first.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { NameMatcher } from './names';

/** One candidate a detector found: the text as written, and how sure it is (0..1). */
export interface DetectedName {
  value: string;
  score: number;
}

/** What a host plugs in: candidate people's names in one text. */
export interface NameDetector {
  /**
   * `budgetMs`: the time left for this call. A detector should stop its slow
   * work by then (the iPhone finder falls back to its fast tagger); Brain
   * stops waiting at that point either way.
   */
  detect(text: string, budgetMs: number): Promise<DetectedName[]>;
}

/**
 * Below this a candidate is left visible. The design's band of 0.40–0.85 is
 * for a referee; with none yet, those are hidden (the privacy side). Apple's
 * model answers count as 0.9.
 */
export const STRANGER_HIDE_SCORE = 0.4;
/** Detection time one model call may spend; text left over runs on known names only. */
export const STRANGER_BUDGET_MS = 2_500;
/**
 * How much sooner than Brain's own cut-off the detector is told to stop, so
 * its fallback answer (the iPhone tagger, the trip back) arrives in time.
 */
export const DETECTOR_MARGIN_MS = 250;
/** Paragraphs remembered; a conversation repeats its history on every turn. */
const CACHE_SIZE = 1_000;
/** Strangers' groups never collide with the known names' group numbers. */
const STRANGER_GROUP_BASE = 1_000_000;

/** Never anyone's name, whatever a detector says. Compared in lower case. */
const NOT_NAMES: ReadonlySet<string> = new Set([
  'i',
  'me',
  'my',
  'mine',
  'we',
  'us',
  'our',
  'ours',
  'you',
  'your',
  'yours',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'they',
  'them',
  'their',
  'theirs',
  'it',
  'its',
  'someone',
  'somebody',
  'everyone',
  'everybody',
  'anyone',
  'nobody',
  'user',
  'owner',
  'dina',
  'mom',
  'mum',
  'mother',
  'dad',
  'father',
  'wife',
  'husband',
  'son',
  'daughter',
  'brother',
  'sister',
  'grandmother',
  'grandfather',
  'grandma',
  'grandpa',
  'aunt',
  'uncle',
  'cousin',
  'nephew',
  'niece',
  'boss',
]);

export interface StrangerNamesOptions {
  detector: NameDetector;
  nowMs?: () => number;
  budgetMs?: number;
  /** Told how many paragraphs went undetected in a call; never their text. */
  onDegraded?: (skipped: number) => void;
}

/** Keep a candidate? (See the module note.) */
export function keepCandidate(text: string, c: DetectedName): boolean {
  const value = c.value.trim();
  if (value.length < 2 || !(c.score >= STRANGER_HIDE_SCORE)) return false;
  if (value.includes('[') || value.includes(']')) return false;
  if (NOT_NAMES.has(value.toLowerCase())) return false;
  return text.includes(value);
}

/** Split into the units results are cached by: paragraphs. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
}

/** Where a kept name sits in its paragraph; the cache holds these, never text. */
type Span = [start: number, end: number];

export class StrangerNames {
  /** Paragraph hash → spans of the names in it. */
  private readonly cache = new Map<string, Span[]>();
  private readonly now: () => number;
  private readonly budgetMs: number;

  constructor(private readonly options: StrangerNamesOptions) {
    this.now = options.nowMs ?? Date.now;
    this.budgetMs = options.budgetMs ?? STRANGER_BUDGET_MS;
  }

  /**
   * A matcher for the strangers named in `texts`, given newest first. A
   * detector call is cut off at the time left; what the budget does not
   * reach is left to known names alone, and counted.
   */
  async matcherFor(texts: readonly string[]): Promise<NameMatcher> {
    const started = this.now();
    const found = new Set<string>();
    let skipped = 0;
    for (const text of texts) {
      for (const para of paragraphs(text)) {
        const key = bytesToHex(sha256(new TextEncoder().encode(para)));
        let spans = this.cache.get(key);
        if (spans === undefined) {
          const left = this.budgetMs - (this.now() - started);
          if (left <= 0) {
            skipped++;
            continue;
          }
          // The detector gets less time than Brain waits: when it runs out it
          // answers from its fast fallback, and that answer must arrive (and
          // be cached) rather than be cut off.
          const given = Math.max(0, left - Math.min(DETECTOR_MARGIN_MS, left / 4));
          const candidates = await within(this.options.detector.detect(para, given), left);
          if (candidates === null) {
            skipped++;
            continue;
          }
          spans = spansOf(para, candidates);
          this.remember(key, spans);
        }
        for (const [a, b] of spans) found.add(para.slice(a, b));
      }
    }
    if (skipped > 0) this.options.onDegraded?.(skipped);
    return new NameMatcher(
      [...found].map((name, i) => ({ group: STRANGER_GROUP_BASE + i, names: [name] })),
    );
  }

  /** Forget everything detected (the owner locked the app, or a test resets). */
  clear(): void {
    this.cache.clear();
  }

  private remember(key: string, spans: Span[]): void {
    if (this.cache.size >= CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, spans);
  }
}

/** The kept candidates of a paragraph, as where they first occur in it. */
function spansOf(para: string, candidates: readonly DetectedName[]): Span[] {
  const spans: Span[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!keepCandidate(para, c)) continue;
    const value = c.value.trim();
    if (seen.has(value)) continue;
    seen.add(value);
    const at = para.indexOf(value);
    spans.push([at, at + value.length]);
  }
  return spans;
}

/** The detector's answer, or null when it failed or did not come in `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p.catch(() => null), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let installed: StrangerNames | null = null;

/** The host's stranger detection, installed at boot; none on hosts without a detector. */
export function installStrangerNames(strangers: StrangerNames | null): void {
  installed = strangers;
}

export function getStrangerNames(): StrangerNames | null {
  return installed;
}
