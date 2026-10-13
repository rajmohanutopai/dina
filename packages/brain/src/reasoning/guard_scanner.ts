/**
 * Guard-scan post-processor for /ask responses.
 *
 * Port of `brain/src/service/guardian.py::_guard_scan` +
 * `_split_sentences` + `_remove_sentences` + `_build_anti_her_redirect`.
 * Runs the `GUARD_SCAN` LLM prompt on the assistant's answer + the
 * user's query, parses the 1-indexed violation arrays, removes flagged
 * sentences, and optionally rewrites the response to a human-redirect
 * when everything gets stripped because of an Anti-Her violation.
 *
 * Fail-open: ANY error (LLM timeout, JSON parse fail, missing fields)
 * returns the original response unchanged. Python does the same — the
 * guard is a safety net, not a blocking checkpoint. Breaking /ask on a
 * guard-scan outage is a worse failure than letting a single response
 * through unscanned.
 *
 * Wire format (matches Python's schema exactly — do NOT paraphrase):
 *   {
 *     "entities": {"did": null, "name": null},
 *     "trust_relevant": false,
 *     "anti_her_sentences": [1, 3],
 *     "unsolicited_sentences": [],
 *     "fabricated_sentences": [],
 *     "consensus_sentences": []
 *   }
 * Sentence indices are 1-indexed integers that line up with the [N]
 * labels in the numbered response block.
 */

import { peoplePointerLine } from '../guardian/anti_her';
import { isTrustTool } from '../guardian/peerlens_tools';
import { SMALL_TASK_MAX_TOKENS } from '../constants';
import { GUARD_SCAN } from '../llm/prompts';

import type { DecisionAnswers, DecisionRequest } from '../llm/decisions';

import type { LLMProvider } from '../llm/adapters/provider';

export interface GuardScanViolations {
  anti_her_sentences: number[];
  unsolicited_sentences: number[];
  fabricated_sentences: number[];
  consensus_sentences: number[];
  entities?: { did: string | null; name: string | null };
  trust_relevant?: boolean;
}

export interface GuardScanDecision {
  /** The content after flagged-sentence removal — may equal the input
   *  verbatim when nothing was flagged. */
  content: string;
  /** True when the scanner made at least one mutation (sentence
   *  removed, redirected to humans). Useful for telemetry. */
  mutated: boolean;
  /** Reason the scanner acted — surfaced in telemetry / debug logs. */
  reason:
    | 'no_scan'
    | 'no_violations'
    | 'sentences_removed'
    | 'anti_her_redirect'
    | 'empty_after_scan'
    | 'scan_failed';
  /** Which categories fired (empty when `reason === 'no_scan'` /
   *  `'no_violations'`). */
  flagged: Partial<Record<keyof GuardScanViolations, number[]>>;
}

/**
 * Message Python emits when every sentence gets stripped AND Anti-Her
 * was a cause — pulled out as a constant so tests + mobile-side
 * redirects can render it verbatim. Matches
 * `_build_anti_her_redirect()` in `guardian.py`.
 */
export const ANTI_HER_REDIRECT_MESSAGE =
  "This sounds like something to share with someone who knows you. " +
  "Is there a friend or family member you'd like to reach out to? " +
  "I can help you draft a message if you'd like.";

/**
 * Neutral fallback when sentences got stripped for non-Anti-Her
 * reasons (unsolicited / fabricated / consensus) and nothing remains.
 * Matches Python's "I don't have relevant information stored for that
 * query."
 */
export const NEUTRAL_EMPTY_MESSAGE =
  "I don't have relevant information stored for that query.";

export interface GuardScannerOptions {
  /**
   * Override the trust-tool registry. Useful for tests that want to
   * pin a custom set; production callers should leave this undefined
   * and rely on the canonical registry in
   * `guardian/peerlens_tools.ts`. When provided, the override REPLACES
   * the canonical registry entirely (no merge) — a deliberate choice
   * so tests can exercise the "no trust tool used" branch by passing
   * `[]`.
   */
  trustToolNames?: readonly string[];
  /**
   * Up to three close contacts' names (REAL_LIFE_FIXES §8). When Anti-Her
   * sentences are removed, the reply gains one line pointing to people.
   */
  closeContacts?: () => Promise<string[]>;
  /**
   * Fixed-choice decisions (`LLMRouter.decide`, e.g. Jev). When it answers,
   * its flags are used and the GUARD_SCAN prompt is not sent; when it
   * answers null or throws, the prompt runs as before.
   */
  decide?: (request: DecisionRequest) => Promise<DecisionAnswers | null>;
}

export type GuardScanner = (args: {
  userPrompt: string;
  response: string;
  /** Names of tools the agentic loop invoked on its way to this
   *  response. Drives the "trust tool used → skip fabricated/consensus
   *  stripping" logic. */
  toolsCalled?: string[];
}) => Promise<GuardScanDecision>;

/**
 * Factory: build a guard scanner backed by `provider`. Call the
 * returned function after the reasoning loop lands; pass its `content`
 * through verbatim to the user.
 */
export function createGuardScanner(
  provider: LLMProvider,
  options: GuardScannerOptions = {},
): GuardScanner {
  // When the caller supplies an override, use it verbatim (Set lookup
  // only). Otherwise delegate to the canonical registry in
  // `guardian/peerlens_tools.ts`, which also handles prefix families.
  const overrideSet = options.trustToolNames ? new Set(options.trustToolNames) : null;
  const isTrustToolName = (name: string): boolean =>
    overrideSet ? overrideSet.has(name) : isTrustTool(name);

  return async ({ userPrompt, response, toolsCalled = [] }) => {
    if (!response || response.trim() === '') {
      return {
        content: response,
        mutated: false,
        reason: 'no_scan',
        flagged: {},
      };
    }

    const sentences = splitSentences(response);
    if (sentences.length === 0) {
      return {
        content: response,
        mutated: false,
        reason: 'no_scan',
        flagged: {},
      };
    }

    // Build the numbered block the prompt expects — 1-indexed so the
    // LLM's `anti_her_sentences: [1]` actually points at sentence #1.
    const numberedContent = sentences.map((s, i) => `[${i + 1}] ${s}`).join('\n');
    const promptText = GUARD_SCAN.replace('{{prompt}}', userPrompt).replace(
      '{{numbered_content}}',
      numberedContent,
    );

    const trustToolUsedEarly = toolsCalled.some(isTrustToolName);
    let decided: GuardScanViolations | null = null;
    if (options.decide !== undefined) {
      try {
        const answers = await options.decide(guardDecisionRequest(userPrompt, sentences, !trustToolUsedEarly));
        decided = answers === null ? null : violationsFromDecisions(answers, sentences.length);
      } catch (err) {
        console.log('[guard_scanner] decision backend failed; using the model prompt', {
          message: err instanceof Error ? err.message.slice(0, 120) : '',
        });
        decided = null;
      }
    }

    let violations: GuardScanViolations;
    if (decided !== null) {
      violations = decided;
    } else try {
      const resp = await provider.chat(
        [{ role: 'user', content: promptText }],
        // The shared small-task budget: a reasoning model spent 1024 tokens
        // thinking and returned nothing, so every scan failed open unseen.
        { temperature: 0, maxTokens: SMALL_TASK_MAX_TOKENS },
      );
      const parsed = parseGuardScanResponse(resp.content);
      if (parsed === null) {
        console.log('[guard_scanner] unparsable', { contentLen: resp.content.length, finishReason: resp.finishReason });
        return {
          content: response,
          mutated: false,
          reason: 'scan_failed',
          flagged: {},
        };
      }
      violations = parsed;
    } catch (err) {
      console.log('[guard_scanner] call failed', { message: err instanceof Error ? err.message.slice(0, 200) : '' });
      // LLM outage, timeout — fail-open. Python does the same.
      return {
        content: response,
        mutated: false,
        reason: 'scan_failed',
        flagged: {},
      };
    }

    // Decide which categories to strip. Anti-Her is ALWAYS enforced
    // (Law 4, non-negotiable). The rest only fires when the reasoning
    // agent didn't cite a verified-trust tool.
    const trustToolUsed = toolsCalled.some(isTrustToolName);
    const removeIndices = new Set<number>();
    const flagged: GuardScanDecision['flagged'] = {};

    const addFromCategory = (key: keyof GuardScanViolations): void => {
      const arr = violations[key];
      if (!Array.isArray(arr)) return;
      const kept: number[] = [];
      for (const idx of arr) {
        if (typeof idx !== 'number' || !Number.isInteger(idx)) continue;
        if (idx < 1 || idx > sentences.length) continue;
        removeIndices.add(idx);
        kept.push(idx);
      }
      if (kept.length > 0) flagged[key] = kept;
    };

    addFromCategory('anti_her_sentences');
    if (!trustToolUsed) {
      addFromCategory('unsolicited_sentences');
      addFromCategory('fabricated_sentences');
      addFromCategory('consensus_sentences');
    }

    if (removeIndices.size === 0) {
      return {
        content: response,
        mutated: false,
        reason: 'no_violations',
        flagged,
      };
    }

    const stripped = removeSentences(sentences, removeIndices);
    if (stripped.trim() !== '') {
      // REAL_LIFE_FIXES §8: removing Anti-Her sentences must still point the
      // user to people, not only when everything was removed.
      if (flagged.anti_her_sentences !== undefined && flagged.anti_her_sentences.length > 0) {
        let names: string[] = [];
        try {
          names = (await options.closeContacts?.()) ?? [];
        } catch {
          names = [];
        }
        return {
          content: `${stripped.trim()} ${peoplePointerLine(names)}`,
          mutated: true,
          reason: 'sentences_removed',
          flagged,
        };
      }
      return {
        content: stripped,
        mutated: true,
        reason: 'sentences_removed',
        flagged,
      };
    }

    // Everything got stripped. Branch on WHY: if Anti-Her flagged,
    // Law 4 wants a human-redirect; otherwise a neutral "no info".
    if (flagged.anti_her_sentences !== undefined && flagged.anti_her_sentences.length > 0) {
      return {
        content: ANTI_HER_REDIRECT_MESSAGE,
        mutated: true,
        reason: 'anti_her_redirect',
        flagged,
      };
    }
    return {
      content: NEUTRAL_EMPTY_MESSAGE,
      mutated: true,
      reason: 'empty_after_scan',
      flagged,
    };
  };
}

// ---------------------------------------------------------------------------
// Sentence helpers — kept pure + exported for targeted tests
// ---------------------------------------------------------------------------

/**
 * Split text into sentences on `[.!?]` followed by whitespace. Matches
 * Python's `re.split(r'(?<=[.!?])\s+', text.strip())` so both stacks
 * number identical sentence counts given the same input.
 */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  return parts.filter((p) => p.trim() !== '');
}

/**
 * Remove the 1-indexed sentences at `indices` and rejoin the rest
 * with a single space. Collapses double-spaces + trims — matches
 * Python's `_remove_sentences`.
 */
export function removeSentences(sentences: string[], indices: Set<number>): string {
  const kept: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (indices.has(i + 1)) continue;
    kept.push(sentences[i]!);
  }
  return kept.join(' ').replace(/ {2,}/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// JSON parsing — tolerant of markdown code fences, strict on schema
// ---------------------------------------------------------------------------

export function parseGuardScanResponse(raw: string): GuardScanViolations | null {
  if (!raw || raw.trim() === '') return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const out: GuardScanViolations = {
    anti_her_sentences: indexArrayOrEmpty(rec.anti_her_sentences),
    unsolicited_sentences: indexArrayOrEmpty(rec.unsolicited_sentences),
    fabricated_sentences: indexArrayOrEmpty(rec.fabricated_sentences),
    consensus_sentences: indexArrayOrEmpty(rec.consensus_sentences),
  };
  if (typeof rec.trust_relevant === 'boolean') out.trust_relevant = rec.trust_relevant;
  if (rec.entities !== null && typeof rec.entities === 'object') {
    const e = rec.entities as Record<string, unknown>;
    out.entities = {
      did: typeof e.did === 'string' ? e.did : null,
      name: typeof e.name === 'string' ? e.name : null,
    };
  }
  return out;
}

function indexArrayOrEmpty(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1,
  );
}

// ---------------------------------------------------------------------------
// The same checks as fixed-choice decisions (one yes/no per sentence)
// ---------------------------------------------------------------------------

/** A sentence is flagged when the backend's probability of yes reaches this. */
export const DECISION_FLAG_THRESHOLD = 0.5;

const DECISION_CHECKS = {
  ah: {
    key: 'anti_her_sentences',
    ask: 'Does sentence {n} of the assistant response act as an emotional companion, therapist or friend?',
    yes: 'It offers the assistant itself as company or someone to talk to or listen ("I\'ll listen", "here to talk", "keep you company"), uses a hook that extends an emotional conversation ("I\'m here for you", "how are you holding up?"), asks a therapy-style question, or simulates warmth or intimacy ("I care about you").',
    no: 'It is factual or task-oriented, or it points the user to a real person (a friend, family, a professional or a helpline).',
  },
  un: {
    key: 'unsolicited_sentences',
    ask: 'Does sentence {n} of the assistant response push a product, vendor or service the user did not ask for?',
    yes: 'Cross-sell, "you might also like", trending picks, or products or services unrelated to the question.',
    no: 'It answers the user\'s question, the user asked for suggestions, or it suggests contacting a real person (family, a friend, a doctor, a helpline).',
  },
  fa: {
    key: 'fabricated_sentences',
    ask: 'Does sentence {n} of the assistant response state invented trust or review data?',
    yes: 'A numeric rating (4.2/5, 9/10), an attestation count or a "community review" claim with no source in the conversation.',
    no: 'Anything else, including personal facts (names, dates, amounts) recalled from the user\'s own records.',
  },
  co: {
    key: 'consensus_sentences',
    ask: 'Does sentence {n} of the assistant response claim reviewer consensus or wide agreement?',
    yes: 'It says reviewers, experts or most people agree, with no data shown for it.',
    no: 'It makes no claim about what many people think.',
  },
} as const;

/**
 * One yes/no question per sentence per check. The trust checks are asked
 * only when they would be applied (no verified-trust tool was used).
 */
export function guardDecisionRequest(
  userPrompt: string,
  sentences: readonly string[],
  includeTrustChecks: boolean,
): DecisionRequest {
  const checks = includeTrustChecks ? (['ah', 'un', 'fa', 'co'] as const) : (['ah'] as const);
  const questions: DecisionRequest['questions'] = {};
  for (let i = 1; i <= sentences.length; i++) {
    for (const c of checks) {
      const d = DECISION_CHECKS[c];
      questions[`${c}_${i}`] = {
        type: 'noul',
        instructions: d.ask.replace('{n}', String(i)),
        criteria: { true: d.yes, false: d.no },
      };
    }
  }
  return {
    questions,
    state: {
      user_prompt: userPrompt,
      assistant_response: sentences.map((s, i) => `[${i + 1}] ${s}`).join('\n'),
    },
  };
}

/** Turn per-sentence answers back into the scanner's violation lists. */
export function violationsFromDecisions(answers: DecisionAnswers, sentenceCount: number): GuardScanViolations {
  const out: GuardScanViolations = {
    anti_her_sentences: [],
    unsolicited_sentences: [],
    fabricated_sentences: [],
    consensus_sentences: [],
  };
  for (let i = 1; i <= sentenceCount; i++) {
    for (const c of ['ah', 'un', 'fa', 'co'] as const) {
      const a = answers[`${c}_${i}`];
      if (a?.type === 'noul' && a.noul >= DECISION_FLAG_THRESHOLD) out[DECISION_CHECKS[c].key].push(i);
    }
  }
  return out;
}

