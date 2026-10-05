/**
 * Provenance, resolved by Core (A2A design A2A-I12, §6.2 step 2). Brain
 * proposes; it may say where parts of the outgoing text came from — a
 * message the owner sent in this conversation, or a vault item Core released
 * into it. Core believes none of it until its own log agrees, and a proof
 * covers a WHOLE unit only:
 *
 *  - an `owner` quote must be one complete message the owner sent in this
 *    conversation, word for word (Core recorded its digest at the chat
 *    entry, and keeps no copy of the words);
 *  - a `vault` quote must be the complete body of an item Core released
 *    into this conversation, still holding what was released, and written
 *    before the conversation began (Core re-reads it; a locked persona
 *    cannot prove);
 *  - nothing smaller proves. Any rule for cutting sentences out of a unit
 *    can be gamed (an abbreviation, an ellipsis, "a.m.", a list number) to
 *    drop the words that govern the rest; a whole unit has nothing dropped;
 *  - a claim Core cannot prove refuses the whole proposal;
 *  - everything no proven quote covers is `derived`: unverified, possibly
 *    sensitive (Core cannot see what else reached the model), and tainted by
 *    what the conversation read.
 *
 * What a proof does NOT stop: on the server, Brain's chat entry records the
 * owner's words, and Brain can write vault items. A prompt-injected model
 * cannot forge either (recording happens before any model runs, and an item
 * written during the conversation never proves), but compromised Brain code
 * could. The card says what each source is; it never replaces reading.
 *
 * Text is compared after the same cleaning the message gets (invisible
 * characters removed, NFC), so what is proven is what is sent.
 */

import { isPlainObject } from '@dina/a2a';

import { getPersonaTier } from '../persona/service';
import { getItem } from '../vault/crud';

import { cleanForProvenance, utteranceDigest } from './provenance_text';
import { releasedContentDigest, type A2AReleaseLog } from './release_log';

/** Quotes one proposal may claim at most; each costs Core a re-read. */
export const MAX_CLAIMED_SOURCES = 16;
/**
 * A quote must be at least this long and this many words: a proof of a
 * one-word message ("yes") tells the owner nothing worth a label.
 */
export const MIN_QUOTE_CHARS = 12;
export const MIN_QUOTE_WORDS = 3;

/** Tiers whose content the owner treats as restricted (§6.2 step 4). */
const RESTRICTED_TIERS: ReadonlySet<string> = new Set(['sensitive', 'locked']);

const WORD_CHAR = /[\p{L}\p{N}]/u;
const WORD = /[\p{L}\p{N}]+/gu;

export type SpanSource = { kind: 'owner' } | { kind: 'vault'; persona: string; itemId: string; restricted: boolean };

/** A proven stretch of the cleaned outgoing text, `[start, end)`. */
export interface ProvenSpan {
  start: number;
  end: number;
  source: SpanSource;
}

export type ProvenanceRefusal =
  | 'sources_malformed'
  | 'too_many_sources'
  | 'source_too_short'
  | 'source_not_in_message'
  | 'source_ambiguous'
  | 'sources_overlap'
  | 'source_unproven'
  | 'source_changed';

export interface ProvenanceResult {
  /** The cleaned text the spans index into. */
  text: string;
  /** Proven spans, sorted, never overlapping. */
  spans: ProvenSpan[];
  /** True when some letter or digit is covered by no proven span. */
  derived: boolean;
  /** Restricted personas the conversation has read (its read-set taint). */
  restrictedReads: string[];
}


type Claim = { quote: string; from: 'owner' } | { quote: string; from: 'vault'; persona: string; itemId: string };

function parseClaims(raw: unknown): Claim[] | ProvenanceRefusal {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'sources_malformed';
  if (raw.length > MAX_CLAIMED_SOURCES) return 'too_many_sources';
  const claims: Claim[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.quote !== 'string') return 'sources_malformed';
    const quote = cleanForProvenance(entry.quote);
    if (quote !== quote.trim()) return 'sources_malformed';
    if (quote.length < MIN_QUOTE_CHARS || (quote.match(WORD) ?? []).length < MIN_QUOTE_WORDS) return 'source_too_short';
    if (entry.from === 'owner') claims.push({ quote, from: 'owner' });
    else if (entry.from === 'vault' && typeof entry.persona === 'string' && typeof entry.item_id === 'string') {
      claims.push({ quote, from: 'vault', persona: entry.persona, itemId: entry.item_id });
    } else return 'sources_malformed';
  }
  return claims;
}

/** True when `[start, end)` of `text` begins and ends on a word boundary. */
function onWordBoundaries(text: string, start: number, end: number): boolean {
  const before = start === 0 ? '' : (text[start - 1] ?? '');
  const after = end >= text.length ? '' : (text[end] ?? '');
  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

/** The single place `quote` occurs in `text`, `'none'`, or `'many'`. */
function soleOccurrence(text: string, quote: string): number | 'none' | 'many' {
  const first = text.indexOf(quote);
  if (first === -1) return 'none';
  return text.indexOf(quote, first + 1) === -1 ? first : 'many';
}

/**
 * What may sit between proven units without being content: one or two ASCII
 * spaces or new lines — whole units carry their own punctuation, so a mark
 * between them could only join or change them ("Bob" + "'" + "s"). Before the
 * first unit and after the last, at most the same, or nothing. Anything else
 * is text no quote proves.
 */
const BETWEEN_UNITS = /^[ \n]{1,2}$/;
const AT_EDGE = /^[ \n]{0,2}$/;

/** The source a vault claim proves, or why it does not. */
function proveVault(
  log: A2AReleaseLog,
  sessionId: string,
  claim: Extract<Claim, { from: 'vault' }>,
): SpanSource | ProvenanceRefusal {
  const releases = log.releasesOf(sessionId, claim.persona, claim.itemId);
  if (releases.length === 0) return 'source_unproven';
  let item;
  try {
    item = getItem(claim.persona, claim.itemId);
  } catch {
    return 'source_unproven'; // the persona is locked or gone: Core cannot re-read it
  }
  if (item === null) return 'source_unproven';
  const digest = releasedContentDigest(item);
  if (!releases.some((r) => r.content_digest === digest)) return 'source_changed';
  // The whole body, as the owner's vault holds it: never a part of it, and
  // never the model-written summaries beside it.
  if (cleanForProvenance(item.body ?? '').trim() !== claim.quote) return 'source_unproven';
  // An item written during the conversation proves nothing: Brain writes
  // vault items, so a fresh one could be anything it was just shown. Core
  // stamps `updated_at` itself on every write.
  const start = log.conversationStart(sessionId);
  if (start === null || item.updated_at >= start) return 'source_unproven';
  return {
    kind: 'vault',
    persona: claim.persona,
    itemId: claim.itemId,
    // The read-set rule (`restrictedReads`): private if its persona was private when read OR is now.
    restricted: releases.some((r) => RESTRICTED_TIERS.has(r.persona_tier)) || RESTRICTED_TIERS.has(currentTier(claim.persona)),
  };
}

/**
 * Resolve Brain's claims about `rawText` against the conversation's log.
 * `rawText` is the outgoing text before scrubbing; spans index its cleaned form.
 */
export function resolveProvenance(
  log: A2AReleaseLog,
  sessionId: string,
  rawText: string,
  rawClaims: unknown,
): ProvenanceResult | { refused: ProvenanceRefusal } {
  const text = cleanForProvenance(rawText);
  const claims = parseClaims(rawClaims);
  if (typeof claims === 'string') return { refused: claims };
  // Each message the owner sent here, compared whole, by digest.
  const utterances = new Set(
    claims.some((c) => c.from === 'owner') ? log.utterances(sessionId).map((u) => u.digest) : [],
  );
  const spans: ProvenSpan[] = [];
  for (const claim of claims) {
    // One claim, one place: a quote that occurs twice could prove text it never covered.
    const at = soleOccurrence(text, claim.quote);
    if (at === 'none') return { refused: 'source_not_in_message' };
    if (at === 'many') return { refused: 'source_ambiguous' };
    const end = at + claim.quote.length;
    if (!onWordBoundaries(text, at, end)) return { refused: 'source_not_in_message' };
    let source: SpanSource | ProvenanceRefusal;
    if (claim.from === 'owner') {
      source = utterances.has(utteranceDigest(claim.quote)) ? { kind: 'owner' } : 'source_unproven';
    } else {
      source = proveVault(log, sessionId, claim);
    }
    if (typeof source === 'string') return { refused: source };
    spans.push({ start: at, end, source });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i += 1) {
    if ((spans[i]?.start ?? 0) < (spans[i - 1]?.end ?? 0)) return { refused: 'sources_overlap' };
  }
  // Derived: any gap between proven spans that is more than a little ASCII
  // space and punctuation (an allow-list: a symbol or a strange space can
  // carry content as well as a letter can).
  let derived = false;
  let cursor = 0;
  const bounds = [...spans, { start: text.length, end: text.length }];
  for (let i = 0; i < bounds.length; i += 1) {
    const gap = text.slice(cursor, bounds[i]?.start ?? text.length);
    const edge = i === 0 || i === bounds.length - 1;
    if (!(edge ? AT_EDGE : BETWEEN_UNITS).test(gap)) {
      derived = true;
      break;
    }
    cursor = bounds[i]?.end ?? text.length;
  }
  return { text, spans, derived, restrictedReads: restrictedReads(log, sessionId) };
}

/**
 * The private (sensitive or locked) personas a conversation has read: its
 * read-set taint. A read counts as private if its persona was private when
 * read OR is now (a persona raised later taints earlier reads; a persona no
 * longer known counts as private).
 */
export function restrictedReads(log: A2AReleaseLog, sessionId: string): string[] {
  return [
    ...new Set(
      log
        .readSet(sessionId)
        .filter((r) => isRestrictedRead(r.persona_tier, r.persona))
        .map((r) => r.persona),
    ),
  ].sort();
}

/**
 * Whether a read taints: the persona was restricted (sensitive or locked) when
 * read, or is now (a persona no longer known counts as private).
 */
export function isRestrictedRead(tierAtRead: string, persona: string): boolean {
  return RESTRICTED_TIERS.has(tierAtRead) || RESTRICTED_TIERS.has(currentTier(persona));
}

function currentTier(persona: string): string {
  try {
    return getPersonaTier(persona);
  } catch {
    return 'sensitive';
  }
}

/** Two sources are the same source. */
export function sameSource(a: SpanSource, b: SpanSource): boolean {
  if (a.kind === 'owner' || b.kind === 'owner') return a.kind === b.kind;
  return a.persona === b.persona && a.itemId === b.itemId;
}

/**
 * The one source whose proven span holds EVERY occurrence of `value` in the
 * text, or null when some occurrence is outside the spans or two sources
 * hold it: only a single provable source keeps an original (A2A-I9). The
 * spans are few and sorted; the occurrences are found once.
 */
export function singleSourceOf(result: ProvenanceResult, value: string): SpanSource | null {
  if (value === '') return null;
  let found: SpanSource | null = null;
  for (let at = result.text.indexOf(value); at !== -1; at = result.text.indexOf(value, at + value.length)) {
    const span = result.spans.find((s) => s.start <= at && s.end >= at + value.length);
    if (span === undefined) return null;
    if (found === null) found = span.source;
    else if (!sameSource(found, span.source)) return null;
  }
  return found;
}
