/**
 * Guard scan — post-processing safety for LLM responses.
 *
 * Scans Dina's LLM-generated responses for safety violations before
 * delivering to the user. Four violation categories:
 *
 *   1. Anti-Her: therapy-style, engagement hooks, intimacy simulation
 *   2. PII leakage: unrehydrated placeholders like [EMAIL_1], or raw
 *      PII in a context where it should have been scrubbed
 *   3. Hallucinated rating claims: rating/score language paired with a
 *      number, when no trust-providing tool fired this turn
 *   4. Unsolicited commercial recommendations: action verbs paired
 *      with commercial targets, when the user didn't ask
 *
 * Sentence-level tracking: each violation records the sentence
 * index(es) where it was detected, enabling precise removal by index.
 *
 * Optional LLM-backed pass: callers can hand `scanResponse` an
 * `llmFn` in the context bag to run an extra LLM-driven check after
 * the word-class layer. Catches subtler violations (e.g. fabricated
 * relationship claims without a number) the word-class layer doesn't
 * see. The injection is per-call rather than module-global so
 * parallel callers don't clobber each other's configuration.
 *
 * Source: brain/tests/test_guardian.py (guard scan section)
 */

import { detectPII, scrubPII } from '@dina/core';

import { GUARD_SCAN } from '../llm/prompts';

import { isTherapyStyle, isEngagementHook, isIntimacySimulation } from './anti_her';
import { trustToolUsed } from './peerlens_tools';

// ---------------------------------------------------------------
// Violation types
// ---------------------------------------------------------------

export interface GuardViolation {
  category: 'anti_her' | 'pii_leakage' | 'hallucinated_trust' | 'unsolicited_recommendation';
  severity: 'warning' | 'block';
  detail: string;
  matchedText?: string;
  /** Sentence indices where this violation was detected (0-based). */
  sentenceIndices: number[];
}

export interface ScanResult {
  safe: boolean;
  violations: GuardViolation[];
  /** Total sentences in the response. */
  sentenceCount: number;
  /** Sentence indices flagged for removal. */
  flaggedSentences: number[];
}

// ---------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------

/**
 * Unrehydrated PII placeholder. The scrubber emits this exact
 * structural shape — `[CATEGORY_INDEX]` with uppercase/underscore
 * category and digit index (`[EMAIL_1]`, `[PHONE_2]`, …). Matching a
 * deterministic format we control is a different category from the
 * brand-/phrasing-fragile patterns we removed elsewhere; this is
 * structural plumbing.
 *
 * The two helpers below are the only ways the rest of the module
 * looks for these tokens — the `/g`-flag stateful `RegExp.test` /
 * `RegExp.exec` footgun (where `lastIndex` carries between calls) is
 * avoided by keeping all callers funneled through `String.matchAll`.
 */
const PII_TOKEN_RE = /\[[A-Z_]+_\d+\]/g;

/** All unrehydrated PII placeholders in `text`, in document order. */
function findPIITokens(text: string): string[] {
  return Array.from(text.matchAll(PII_TOKEN_RE), (m) => m[0]);
}

/** Cheaper boolean form for the per-sentence check. */
function hasPIIToken(text: string): boolean {
  // `matchAll` returns an iterator; pulling the first entry is enough
  // to answer "any match?" without materialising the rest.
  return text.matchAll(PII_TOKEN_RE).next().done === false;
}

/**
 * Two surface-level violation categories — hallucinated trust claims
 * and unsolicited commercial recommendations — share the same shape:
 *
 *   1. WORD-CLASS DETECTION — does the sentence pair a "claim word"
 *      with a "target word"? Generic word-membership checks rather
 *      than brand-specific regex; the word lists capture the semantic
 *      class, so a brand rename ("Trust" → "PeerLens") doesn't silently
 *      stop catching anything.
 *
 *   2. AUDIT — is there a runtime signal that the claim/recommendation
 *      was earned? For trust: a trust-providing tool was called this
 *      turn (`peerlens_tools.ts`). For unsolicited: the user prompt
 *      explicitly invited a recommendation. If the audit passes, the
 *      sentence is data/intent-backed and not flagged.
 *
 * The proximity window keeps the pair from coupling across long
 * distances ("I trust your judgment about the 9 documents" → not
 * a rating claim because trust and 9 are 4 tokens apart).
 *
 * The agentic loop's separate LLM-based scanner
 * (`reasoning/guard_scanner.ts`) does the same audit on its own
 * fabricated-sentence path; both scanners share the trust-tool
 * registry via `peerlens_tools.ts`.
 */

/** Maximum token-distance between a claim word and its companion
 *  (target word, number, or quantifier) for the pair to count. Tuned
 *  so the typical "X has rating 9", "I recommend you buy" surface
 *  forms hit, but unrelated co-occurrences ("I trust your judgment
 *  about the 9 documents") don't. */
const PROXIMITY_WINDOW = 5;

/** Rating-claim words. Kept tight — only words that strongly imply
 *  "evaluation against a scale". `level` and `index` were dropped
 *  because they collide with neutral usage ("the next level of
 *  approval", "the file index"). */
const RATING_CLAIM_WORDS: ReadonlySet<string> = new Set([
  'rating',
  'ratings',
  'score',
  'scores',
  'trust',
  'safety',
  'reliability',
  'confidence',
  // The current product brand — included so the family stays covered
  // even if Gemini paraphrases. Other rating words still do work if
  // this one ages out at the next rename.
  'peerlens',
]);

const QUANTIFIER_WORDS: ReadonlySet<string> = new Set(['high', 'low', 'medium']);

/** Action verbs that introduce a recommendation or imperative. */
const RECOMMENDATION_VERBS: ReadonlySet<string> = new Set([
  'recommend',
  'recommends',
  'recommended',
  'recommending',
  'suggest',
  'suggests',
  'suggested',
  'suggesting',
  'advise',
  'advised',
  'advising',
  'should',
  'consider',
  'considered',
  'considering',
  'try',
  'trying',
  // For "check out this deal" — `check` is the action token; the
  // `out` particle splits to a separate token but the proximity
  // window covers it.
  'check',
]);

/** Commercial targets — the things a recommendation would push. */
const COMMERCIAL_TARGETS: ReadonlySet<string> = new Set([
  'buy',
  'buys',
  'buying',
  'bought',
  'purchase',
  'purchases',
  'purchased',
  'purchasing',
  'subscribe',
  'subscribes',
  'subscribed',
  'subscribing',
  'subscription',
  'subscriptions',
  'upgrade',
  'upgrades',
  'upgraded',
  'upgrading',
  'switch',
  'switches',
  'switched',
  'switching',
  'deal',
  'deals',
  'offer',
  'offers',
  'plan',
  'plans',
  // `product`, `service` are too broad on their own — they'd flag
  // perfectly innocent factual sentences ("Your service was
  // restored"). A recommendation that mentions those words almost
  // always also mentions a more specific target above.
]);

/** Tokens in a USER prompt that mark recommendation as solicited. The
 *  audit is conservative: any one match counts. False positives here
 *  only mean an unsolicited recommendation slips through; they don't
 *  silently break a request. */
const RECOMMENDATION_INVITATION_WORDS: ReadonlySet<string> = new Set([
  'recommend',
  'recommendation',
  'recommendations',
  'suggest',
  'suggestion',
  'suggestions',
  'advise',
  'advice',
  'best',
  'top',
  'options',
  'compare',
  'comparison',
  'should',
  'find',
  'looking',
  'where',
  'which',
  'buy',
  'purchase',
  'pick',
]);

/**
 * Tokenise a sentence into lowercase alphanumeric runs. Regex-free —
 * splitting on punctuation/whitespace happens via a character-code
 * scan so the helper is easy to read and trivially correct.
 *
 * "PeerLens rating: 8/10" → ["peerlens", "rating", "8", "10"]
 */
function tokenise(s: string): string[] {
  const out: string[] = [];
  let current = '';
  const lower = s.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    const isWordChar = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (isWordChar) {
      current += lower[i];
    } else if (current.length > 0) {
      out.push(current);
      current = '';
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** True iff `token` is composed entirely of digits. After tokenise,
 *  punctuation has been split off, so `8/10` is two tokens (`8`,
 *  `10`) and `9.5` is also two tokens (`9`, `5`). `9th` retains its
 *  letters and is correctly NOT treated as a number. */
function isPureDigitToken(token: string): boolean {
  if (token.length === 0) return false;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/**
 * Does ANY token in `classA` appear within `window` of ANY token in
 * `classB`? One linear pass; tracks the most recent index of each
 * class and emits true the first time they collide.
 *
 * `classB` accepts either a Set (membership test) or a predicate
 * (`isPureDigitToken`, etc.) since the rating-claim audit pairs
 * words against numbers, not just other words.
 */
function tokensWithinWindow(
  tokens: readonly string[],
  classA: ReadonlySet<string>,
  classB: ReadonlySet<string> | ((token: string) => boolean),
  window: number,
): boolean {
  const inB = typeof classB === 'function' ? classB : (t: string): boolean => classB.has(t);
  let lastA = Number.NEGATIVE_INFINITY;
  let lastB = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (classA.has(t)) {
      if (i - lastB <= window) return true;
      lastA = i;
    }
    if (inB(t)) {
      if (i - lastA <= window) return true;
      lastB = i;
    }
  }
  return false;
}

/**
 * Does this sentence make a rating claim? True when a rating-claim
 * word and a number (or quantifier) co-occur within the proximity
 * window. Generic and brand-name-immune.
 *
 *   "You can trust your instincts."         → false (no quantifier)
 *   "The sender has high trust."            → true  ("high" near "trust")
 *   "PeerLens rating: 8/10"                 → true  ("rating" near "8")
 *   "I trust your judgment about the 9
 *    documents you reviewed."               → false (>5 tokens apart)
 *   "the 9th principle of trust"            → false ("9th" isn't a number token)
 */
function makesRatingClaim(sentence: string): boolean {
  return tokensWithinWindow(
    tokenise(sentence),
    RATING_CLAIM_WORDS,
    (t) => QUANTIFIER_WORDS.has(t) || isPureDigitToken(t),
    PROXIMITY_WINDOW,
  );
}

/**
 * Does this sentence push the user toward a commercial action? True
 * when a recommendation verb and a commercial target co-occur within
 * the proximity window.
 *
 *   "I recommend you buy the premium plan."  → true
 *   "You should subscribe to the newsletter." → true
 *   "Check out this deal on headphones."     → true
 *   "Your order for headphones was delivered." → false (no rec verb)
 *   "You should call your dentist."           → false (no commercial target)
 */
function makesUnsolicitedRecommendation(sentence: string): boolean {
  return tokensWithinWindow(
    tokenise(sentence),
    RECOMMENDATION_VERBS,
    COMMERCIAL_TARGETS,
    PROXIMITY_WINDOW,
  );
}

/** Did the user prompt explicitly invite a recommendation? (Word
 *  membership only — the prompt is short and a single match is
 *  enough.) */
function userInvitedRecommendation(userPrompt: string | undefined): boolean {
  if (userPrompt === undefined || userPrompt.length === 0) return false;
  for (const token of tokenise(userPrompt)) {
    if (RECOMMENDATION_INVITATION_WORDS.has(token)) return true;
  }
  return false;
}

// ---------------------------------------------------------------
// Optional LLM-backed pass
// ---------------------------------------------------------------

/**
 * Injected into `scanResponse` via the context bag when callers want
 * the extra LLM-driven check. The function takes the system prompt
 * and the numbered-sentences user prompt, and returns the raw model
 * output (a JSON string conforming to either the Python-parity or
 * legacy TS schema — see `parseLLMGuardResult`). Per-call injection
 * keeps parallel callers from clobbering each other's configuration.
 */
export type GuardScanLLMFn = (system: string, prompt: string) => Promise<string>;

// ---------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------

/**
 * Common abbreviations whose trailing period must NOT be treated as
 * a sentence boundary. Stored lowercase; the matcher lowercases the
 * candidate word before lookup.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'rev',
  'gen',
  'sgt',
  'lt',
  'col',
  'jr',
  'sr',
  'st',
  'inc',
  'corp',
  'ltd',
  'co',
  'vs',
  'etc',
  'approx',
  'dept',
  'est',
  'govt',
  'org',
  'univ',
]);

/** True when `ch` is ASCII whitespace (space, tab, newline, CR). */
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** True when the alphanumeric word ENDING immediately before `dotIdx`
 *  is a known abbreviation — i.e. the period is part of the word, not
 *  a sentence boundary. */
function endsWithAbbreviation(text: string, dotIdx: number): boolean {
  let wordStart = dotIdx;
  while (wordStart > 0) {
    const code = text.charCodeAt(wordStart - 1);
    const isWordChar =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122); // a-z
    if (!isWordChar) break;
    wordStart--;
  }
  if (wordStart === dotIdx) return false;
  return ABBREVIATIONS.has(text.slice(wordStart, dotIdx).toLowerCase());
}

/**
 * Split text into sentences. Char-scan; no regex, no placeholder
 * sentinels.
 *
 * A sentence boundary is `.`, `!`, or `?` followed by whitespace (or
 * end of string), UNLESS the period closes a known abbreviation
 * (`Dr.`, `Mr.`, …) — in which case it stays inside the current
 * sentence and the scan continues.
 *
 *   "Sentence one. Sentence two."           → ["Sentence one.", "Sentence two."]
 *   "Dr. Smith said hello."                  → ["Dr. Smith said hello."]
 *   "Hello! How are you?"                    → ["Hello!", "How are you?"]
 *   "No trailing punctuation"                → ["No trailing punctuation"]
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    const atEnd = i === trimmed.length - 1;
    const followedByWS = atEnd || isWhitespace(trimmed[i + 1]);
    if (!followedByWS) continue;
    if (ch === '.' && endsWithAbbreviation(trimmed, i)) continue;

    const sentence = trimmed.slice(start, i + 1).trim();
    if (sentence.length > 0) sentences.push(sentence);

    // Skip past the boundary's trailing whitespace.
    let j = i + 1;
    while (j < trimmed.length && isWhitespace(trimmed[j])) j++;
    start = j;
    i = j - 1; // outer loop's i++ moves to j
  }

  // Trailing fragment with no closing punctuation.
  if (start < trimmed.length) {
    const tail = trimmed.slice(start).trim();
    if (tail.length > 0) sentences.push(tail);
  }
  return sentences;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Scan a response for all safety violations. Returns sentence-level
 * violation tracking with indices the caller can use for precise
 * removal via `stripViolations`.
 *
 * Each context field is optional and biases the scan conservatively
 * when missing:
 *
 *   - `persona`        — the persona this response is destined for.
 *                        Currently informational; reserved for
 *                        per-persona policy that doesn't yet exist.
 *   - `piiScrubbed`    — true when the upstream pipeline ran the LLM
 *                        through the PII gate. Enables an extra
 *                        "raw PII slipped through" check (a
 *                        leftover-after-rehydrate alarm).
 *   - `densityTier`    — `'zero' | 'single' | 'dense'` from
 *                        `analyzeDensity`. Drives severity for the
 *                        rating-claim check: zero/single elevates a
 *                        warning to a block.
 *   - `toolsCalled`    — names of tools the loop called this turn.
 *                        Drives the rating-claim audit: ANY trust-
 *                        providing tool fired (`peerlens_tools.ts`) →
 *                        suppress. Single-shot reasoners should pass
 *                        `[]` (no tools) — that flags conservatively.
 *   - `userPrompt`     — the user's original question. Drives the
 *                        unsolicited-recommendation audit: if the
 *                        user invited a recommendation, "I recommend
 *                        you buy X" is solicited; suppress.
 */
export async function scanResponse(
  response: string,
  context?: {
    persona?: string;
    piiScrubbed?: boolean;
    densityTier?: string;
    /**
     * Names of tools the agentic loop / reasoning path invoked on the
     * way to producing this response. Drives the hallucinated-trust
     * audit: if a trust-providing tool fired, rating claims are
     * data-backed and not flagged. Single-shot reasoners that don't
     * make tool calls can leave this undefined — the audit then
     * defaults to "no trust tool used" and flags conservatively.
     */
    toolsCalled?: readonly string[];
    /**
     * The user's original prompt. Drives the unsolicited-recommendation
     * audit: a "I recommend you buy X" sentence is fine when the user
     * asked "what should I buy", suspect when they asked "what's the
     * weather". Optional — when missing, the audit defaults to "user
     * did not invite" and flags conservatively.
     */
    userPrompt?: string;
    /**
     * Optional LLM-backed pass. When provided, runs after the
     * word-class checks and merges any extra violations into the
     * result (skipping sentences already flagged). When omitted the
     * scan is purely deterministic.
     */
    llmFn?: GuardScanLLMFn;
  },
): Promise<ScanResult> {
  const sentences = splitSentences(response);
  const violations: GuardViolation[] = [];
  const flaggedSet = new Set<number>();

  // 1. Anti-Her violations (sentence-level)
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const suites: string[] = [];

    if (isTherapyStyle(sentence)) suites.push('therapy_style');
    if (isEngagementHook(sentence)) suites.push('engagement_hook');
    if (isIntimacySimulation(sentence)) suites.push('intimacy_simulation');

    if (suites.length > 0) {
      violations.push({
        category: 'anti_her',
        severity: 'block',
        detail: `Anti-Her violation: ${suites.join(', ')}`,
        sentenceIndices: [i],
      });
      flaggedSet.add(i);
    }
  }

  // 2. PII leakage — unrehydrated placeholders
  const tokenMatches = findPIITokens(response);
  if (tokenMatches.length > 0) {
    const piiSentenceIndices: number[] = [];
    for (let i = 0; i < sentences.length; i++) {
      if (hasPIIToken(sentences[i])) piiSentenceIndices.push(i);
    }
    violations.push({
      category: 'pii_leakage',
      severity: 'block',
      detail: `Unrehydrated PII tokens found: ${tokenMatches.join(', ')}`,
      matchedText: tokenMatches.join(', '),
      sentenceIndices: piiSentenceIndices,
    });
  }

  // 2b. Raw PII in response when scrubbing was expected
  if (context?.piiScrubbed) {
    const rawPII = detectPII(response);
    if (rawPII.length > 0) {
      // Find which sentences contain raw PII
      const piiSentenceIndices: number[] = [];
      for (let i = 0; i < sentences.length; i++) {
        const sentencePII = detectPII(sentences[i]);
        if (sentencePII.length > 0) {
          piiSentenceIndices.push(i);
          flaggedSet.add(i);
        }
      }
      violations.push({
        category: 'pii_leakage',
        severity: 'warning',
        detail: `Raw PII detected in scrubbed context: ${rawPII.map((p) => p.type).join(', ')}`,
        sentenceIndices: piiSentenceIndices,
      });
    }
  }

  // 3. Hallucinated rating claims (sentence-level)
  //
  // Two-step audit (see module-top docs):
  //   a) Did this sentence make a rating claim? — generic word-set
  //      check, brand-name-immune.
  //   b) Did the loop call a trust-providing tool this turn? — if yes,
  //      the claim is data-backed; if no, flag.
  //
  // Density tier still drives severity: when the trust tool didn't
  // fire AND density is zero/single, the claim is most likely
  // fabricated, so a warning escalates to a block.
  const lowDensity = context?.densityTier === 'zero' || context?.densityTier === 'single';
  const dataBacked = trustToolUsed(context?.toolsCalled);
  if (!dataBacked) {
    for (let i = 0; i < sentences.length; i++) {
      if (!makesRatingClaim(sentences[i])) continue;
      violations.push({
        category: 'hallucinated_trust',
        severity: lowDensity ? 'block' : 'warning',
        detail: lowDensity
          ? 'Rating claim with zero/single data backing and no trust tool call — blocked'
          : 'Rating claim with no trust tool call this turn — possibly fabricated',
        sentenceIndices: [i],
      });
      flaggedSet.add(i);
    }
  }

  // 4. Unsolicited commercial recommendations (sentence-level)
  //
  // Same two-step audit as #3 (rating claims):
  //   a) Did this sentence pair a recommendation verb with a
  //      commercial target?
  //   b) Did the user's prompt invite a recommendation? — if yes,
  //      the recommendation is solicited; suppress.
  //
  // The audit reads the user prompt verbatim, so a query like "what
  // should I buy" or "best coffee maker" lets a downstream
  // recommendation pass; a query like "what's my email" doesn't.
  const userInvited = userInvitedRecommendation(context?.userPrompt);
  if (!userInvited) {
    for (let i = 0; i < sentences.length; i++) {
      if (!makesUnsolicitedRecommendation(sentences[i])) continue;
      violations.push({
        category: 'unsolicited_recommendation',
        severity: 'warning',
        detail: 'Commercial recommendation without an explicit user invitation',
        sentenceIndices: [i],
      });
      flaggedSet.add(i);
    }
  }

  // 5. Optional LLM-backed pass — catches subtler violations the
  // word-class layer doesn't see. Runs as a complement, not a
  // replacement: any sentence the deterministic checks already
  // flagged is skipped here (deduplication).
  if (context?.llmFn) {
    try {
      const llmViolations = await runLLMGuardScan(response, context.llmFn);
      for (const v of llmViolations) {
        const newIndices = v.sentenceIndices.filter((idx) => !flaggedSet.has(idx));
        if (newIndices.length > 0 || v.sentenceIndices.length === 0) {
          violations.push({
            ...v,
            sentenceIndices: newIndices.length > 0 ? newIndices : v.sentenceIndices,
          });
          for (const idx of newIndices) flaggedSet.add(idx);
        }
      }
    } catch {
      // LLM-backed pass failed (timeout, parse error, …) — proceed
      // with the deterministic result so a transient outage doesn't
      // block the whole response.
    }
  }

  return {
    safe: violations.length === 0,
    violations,
    sentenceCount: sentences.length,
    flaggedSentences: [...flaggedSet].sort((a, b) => a - b),
  };
}

/**
 * Strip violations from a response by removing the sentences flagged
 * by `scanResult.flaggedSentences`.
 *
 * `scanResult` is required: the prior optional-fallback path silently
 * differed from the primary path (only re-checking Anti-Her, ignoring
 * the other three categories). Forcing the caller to pass a real
 * scan result removes that footgun and matches the only production
 * call site (`pipeline/chat_reasoning.ts`), which always scans first.
 */
export function stripViolations(response: string, scanResult: ScanResult): string {
  if (scanResult.flaggedSentences.length === 0) return response;
  const sentences = splitSentences(response);
  const flagged = new Set(scanResult.flaggedSentences);
  const cleaned = sentences.filter((_, i) => !flagged.has(i));
  return cleaned.join(' ').trim();
}

// ---------------------------------------------------------------
// Internal: LLM guard scan
// ---------------------------------------------------------------

async function runLLMGuardScan(
  response: string,
  llmFn: GuardScanLLMFn,
): Promise<GuardViolation[]> {
  // PII scrub before sending to cloud LLM — the response may contain
  // emails, phone numbers, etc. from vault context that shouldn't leak.
  const { scrubbed: scrubbedResponse } = scrubPII(response);

  // Number each sentence for the LLM to reference by index. The
  // Python-parity GUARD_SCAN prompt is 1-indexed and uses
  // `{{numbered_content}}` as its placeholder (not
  // `{{numbered_response}}`). This single-shot caller doesn't
  // currently thread the user prompt through, so `{{prompt}}` gets an
  // empty-string substitution — the LLM still flags violations, just
  // without the "was this solicited?" context. The agentic
  // `reasoning/guard_scanner.ts` path fills `{{prompt}}` properly.
  const sentences = splitSentences(scrubbedResponse);
  const numbered = sentences.map((s, i) => `[${i + 1}] ${s}`).join('\n');

  const prompt = GUARD_SCAN.replace('{{prompt}}', '').replace(
    '{{numbered_content}}',
    numbered,
  );
  const raw = await llmFn(
    'You are a safety classifier for Dina, a personal AI assistant. Check responses for violations.',
    prompt,
  );

  // Parse against the ORIGINAL response (not scrubbed) so sentence indices
  // align with the actual text that will be stripped.
  return parseLLMGuardResult(raw, response);
}

/**
 * Parse the LLM guard scan JSON result.
 *
 * Handles two wire formats:
 *
 *   - **Python-parity schema** (preferred, emitted by the current
 *     `GUARD_SCAN` prompt): named arrays per category
 *     `{anti_her_sentences: [1,3], unsolicited_sentences: [], …}` —
 *     1-indexed sentence numbers aligned with the `[N]` labels we
 *     emit when numbering the response.
 *   - **Legacy TS schema**: `{safe: bool, violations: [{type, sentence_indices, text}]}`
 *     with 0-indexed sentence numbers. Kept for any external callers
 *     still on the pre-Python-port format.
 *
 * Returns violations in the TS internal shape (`GuardViolation[]`
 * with 0-indexed `sentenceIndices`). Category mapping for the Python
 * format: anti_her_sentences → 'anti_her', unsolicited_sentences →
 * 'unsolicited_recommendation', fabricated_sentences / consensus_sentences
 * → 'hallucinated_trust'.
 */
export function parseLLMGuardResult(output: string, originalResponse: string): GuardViolation[] {
  if (!output) return [];

  let cleaned = output.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }

  try {
    const parsed = JSON.parse(cleaned);

    // ── Python-parity format detection ──
    // Any of the named category arrays present → treat as the new
    // shape. 1-indexed → convert to 0-indexed for the TS internal
    // `GuardViolation.sentenceIndices`.
    if (
      Array.isArray(parsed.anti_her_sentences) ||
      Array.isArray(parsed.unsolicited_sentences) ||
      Array.isArray(parsed.fabricated_sentences) ||
      Array.isArray(parsed.consensus_sentences)
    ) {
      const sentences = splitSentences(originalResponse);
      const violations: GuardViolation[] = [];
      const pushCategory = (
        key: 'anti_her_sentences' | 'unsolicited_sentences' | 'fabricated_sentences' | 'consensus_sentences',
        category: GuardViolation['category'],
        severity: GuardViolation['severity'],
      ): void => {
        const raw = Array.isArray(parsed[key]) ? parsed[key] : [];
        const indices: number[] = [];
        for (const v of raw) {
          if (typeof v !== 'number' || !Number.isInteger(v)) continue;
          const zero = v - 1; // 1-indexed → 0-indexed
          if (zero < 0 || zero >= sentences.length) continue;
          indices.push(zero);
        }
        if (indices.length > 0) {
          violations.push({ category, severity, detail: `LLM guard: ${key}`, sentenceIndices: indices });
        }
      };
      pushCategory('anti_her_sentences', 'anti_her', 'block');
      pushCategory('unsolicited_sentences', 'unsolicited_recommendation', 'warning');
      pushCategory('fabricated_sentences', 'hallucinated_trust', 'warning');
      pushCategory('consensus_sentences', 'hallucinated_trust', 'warning');
      return violations;
    }

    // ── Legacy TS format ──
    if (parsed.safe === true) return [];
    if (!Array.isArray(parsed.violations)) return [];

    const sentences = splitSentences(originalResponse);
    const violations: GuardViolation[] = [];

    for (const v of parsed.violations) {
      const type = String(v.type ?? '');
      const text = String(v.text ?? '');

      const category = mapLLMViolationType(type);
      if (!category) continue;

      // Prefer direct sentence_indices from the LLM (more precise)
      let indices: number[] = [];
      if (Array.isArray(v.sentence_indices)) {
        indices = v.sentence_indices
          .filter((i: unknown) => typeof i === 'number' && i >= 0 && i < sentences.length)
          .map(Number);
      }

      // Fallback: text-based matching if no direct indices
      if (indices.length === 0 && text) {
        const lower = text.toLowerCase();
        for (let i = 0; i < sentences.length; i++) {
          if (sentences[i].toLowerCase().includes(lower)) {
            indices.push(i);
          }
        }
      }

      violations.push({
        category,
        severity: category === 'anti_her' ? 'block' : 'warning',
        detail: `LLM guard: ${type}`,
        matchedText: text || undefined,
        sentenceIndices: indices,
      });
    }

    return violations;
  } catch {
    return [];
  }
}

function mapLLMViolationType(type: string): GuardViolation['category'] | null {
  const lower = type.toLowerCase();
  if (
    lower.includes('therapy') ||
    lower.includes('engagement') ||
    lower.includes('intimacy') ||
    lower.includes('affection')
  ) {
    return 'anti_her';
  }
  if (lower.includes('recommendation') || lower.includes('unsolicited')) {
    return 'unsolicited_recommendation';
  }
  if (lower.includes('trust') || lower.includes('hallucin')) {
    return 'hallucinated_trust';
  }
  return null;
}
