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

import { GUARD_SCAN } from '../llm/prompts';
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
   * Trust Network tool names — when the reasoning loop fired one of
   * these, the guard scanner ONLY strips Anti-Her sentences. Other
   * categories (fabricated / consensus / unsolicited) are suppressed
   * because the data came back from a verified source and over-
   * redacting would paint legit trust data as hallucinated.
   *
   * Defaults to `['search_trust_network']`. Override when adding new
   * verified-data tools.
   */
  trustToolNames?: string[];
}

const DEFAULT_TRUST_TOOL_NAMES = ['search_trust_network'];

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
  const trustToolNames = new Set(options.trustToolNames ?? DEFAULT_TRUST_TOOL_NAMES);

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

    let violations: GuardScanViolations;
    try {
      const resp = await provider.chat(
        [{ role: 'user', content: promptText }],
        { temperature: 0, maxTokens: 1024 },
      );
      const parsed = parseGuardScanResponse(resp.content);
      if (parsed === null) {
        return {
          content: response,
          mutated: false,
          reason: 'scan_failed',
          flagged: {},
        };
      }
      violations = parsed;
    } catch {
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
    const trustToolUsed = toolsCalled.some((name) => trustToolNames.has(name));
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
