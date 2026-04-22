/**
 * Guard scan — post-processing safety for LLM responses.
 *
 * Scans Dina's LLM-generated responses for safety violations before
 * delivering to the user. Four violation categories:
 *
 *   1. Anti-Her: therapy-style, engagement hooks, intimacy simulation
 *   2. PII leakage: tokens like [EMAIL_1] not rehydrated, or raw PII in
 *      a context where it should have been scrubbed
 *   3. Hallucinated trust: made-up trust scores or relationship claims
 *   4. Unsolicited recommendations: pushing products/services/actions
 *      the user didn't ask for
 *
 * Sentence-level tracking: each violation records the sentence index(es)
 * where it was detected, enabling precise removal by index.
 *
 * Injectable LLM guard scan: when registered, runs an LLM-based check
 * for subtle violations that regex can't catch.
 *
 * Source: brain/tests/test_guardian.py (guard scan section)
 */

import {
  detectResponseViolation,
  isTherapyStyle,
  isEngagementHook,
  isIntimacySimulation,
} from './anti_her';
import { detectPII, scrubPII } from '../../../core/src/pii/patterns';
import { GUARD_SCAN } from '../llm/prompts';

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

/** Unrehydrated PII token left in output. */
const PII_TOKEN_RE = /\[[A-Z_]+_\d+\]/g;

/** Hallucinated trust score pattern — LLM invents trust/safety/confidence numbers. */
const HALLUCINATED_TRUST_PATTERNS = [
  /\btrust\s+(score|level|rating)\s*[:=]?\s*\d/i,
  /\bsafety\s+(score|rating)\s*[:=]?\s*\d/i,
  /\breliability\s+(score|rating)\s*[:=]?\s*\d/i,
  /\b(?:this|the)\s+(?:sender|contact|source)\s+(?:is|has)\s+(?:a\s+)?(?:\d+%?|high|low|medium)\s+trust/i,
];

/** Unsolicited recommendation patterns — pushing products or actions. */
const UNSOLICITED_REC_PATTERNS = [
  /\bi\s+(?:would\s+)?recommend\s+(?:you\s+)?(?:buy|purchase|sign\s+up|subscribe|try|switch\s+to)/i,
  /\byou\s+should\s+(?:buy|purchase|sign\s+up|subscribe|switch\s+to|upgrade)/i,
  /\bhave\s+you\s+(?:considered|thought\s+about)\s+(?:buying|purchasing|signing\s+up|subscribing)/i,
  /\bcheck\s+out\s+(?:this|these)\s+(?:deal|offer|product|service)/i,
];

// ---------------------------------------------------------------
// Injectable LLM guard scan
// ---------------------------------------------------------------

/** LLM guard scan function: response text → JSON result. */
export type GuardScanLLMFn = (system: string, prompt: string) => Promise<string>;

let llmGuardFn: GuardScanLLMFn | null = null;

/** Register an LLM provider for advanced guard scan. */
export function registerGuardScanLLM(fn: GuardScanLLMFn): void {
  llmGuardFn = fn;
}

/** Reset the LLM guard scan provider (for testing). */
export function resetGuardScanLLM(): void {
  llmGuardFn = null;
}

// ---------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------

/** Common abbreviations that should not trigger sentence split. */
const ABBREVIATION_RE =
  /\b(?:Dr|Mr|Mrs|Ms|Prof|Rev|Gen|Sgt|Lt|Col|Jr|Sr|St|Inc|Corp|Ltd|Co|vs|etc|approx|dept|est|govt|org|univ)\.\s/gi;

/**
 * Split text into sentences. Returns array of sentence strings.
 *
 * Handles abbreviations by temporarily replacing them before splitting,
 * then restoring them. This prevents "Dr. Smith" from being split.
 */
export function splitSentences(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  // Protect abbreviations from splitting by replacing their period+space
  const placeholders: string[] = [];
  let protected_ = text.replace(ABBREVIATION_RE, (match) => {
    const idx = placeholders.length;
    placeholders.push(match);
    return `\x00ABBR${idx}\x00`;
  });

  // Split on sentence-ending punctuation followed by whitespace
  const parts = protected_.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);

  // Restore abbreviations
  return parts.map((part) => {
    let restored = part;
    for (let i = 0; i < placeholders.length; i++) {
      restored = restored.replace(`\x00ABBR${i}\x00`, placeholders[i]);
    }
    return restored;
  });
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Scan a response for all safety violations.
 *
 * Returns sentence-level violation tracking with indices for precise removal.
 *
 * @param response - The LLM-generated response text
 * @param context - Optional context: persona name, whether PII scrubbing was applied
 * @returns ScanResult with safe flag, violations with sentence indices, and flagged sentence list
 */
export async function scanResponse(
  response: string,
  context?: { persona?: string; piiScrubbed?: boolean; densityTier?: string },
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

  // 2. PII leakage — unrehydrated tokens
  PII_TOKEN_RE.lastIndex = 0;
  const tokenMatches = response.match(PII_TOKEN_RE);
  if (tokenMatches) {
    // Find which sentences contain PII tokens
    const piiSentenceIndices: number[] = [];
    for (let i = 0; i < sentences.length; i++) {
      PII_TOKEN_RE.lastIndex = 0;
      if (PII_TOKEN_RE.test(sentences[i])) {
        piiSentenceIndices.push(i);
      }
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

  // 3. Hallucinated trust scores (sentence-level)
  // Density-tier aware: when data is zero/single, fabricated trust scores are
  // especially dangerous (no data to back them), so severity escalates to 'block'.
  const lowDensity = context?.densityTier === 'zero' || context?.densityTier === 'single';
  for (let i = 0; i < sentences.length; i++) {
    for (const pattern of HALLUCINATED_TRUST_PATTERNS) {
      if (pattern.test(sentences[i])) {
        violations.push({
          category: 'hallucinated_trust',
          severity: lowDensity ? 'block' : 'warning',
          detail: lowDensity
            ? 'LLM hallucinated a trust score with zero/single data backing — blocked'
            : 'LLM hallucinated a trust/safety/reliability score',
          sentenceIndices: [i],
        });
        flaggedSet.add(i);
        break;
      }
    }
  }

  // 4. Unsolicited recommendations (sentence-level)
  for (let i = 0; i < sentences.length; i++) {
    for (const pattern of UNSOLICITED_REC_PATTERNS) {
      if (pattern.test(sentences[i])) {
        violations.push({
          category: 'unsolicited_recommendation',
          severity: 'warning',
          detail: 'Unsolicited product/service recommendation detected',
          sentenceIndices: [i],
        });
        flaggedSet.add(i);
        break;
      }
    }
  }

  // 5. LLM guard scan (optional — catches subtle violations regex misses)
  // Runs as a complement to regex, not a replacement. Regex handles known patterns;
  // LLM catches nuanced violations (fabricated claims, subtle emotional dependency).
  if (llmGuardFn) {
    try {
      const llmViolations = await runLLMGuardScan(response);
      for (const v of llmViolations) {
        // Deduplicate: skip LLM violations for sentences already flagged by regex
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
      // LLM guard failed — proceed with regex-only results
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
 * Strip violations from a response by removing flagged sentences by index.
 *
 * If a ScanResult is provided, uses its flaggedSentences for precise removal.
 * Otherwise falls back to re-scanning with regex.
 */
export function stripViolations(response: string, scanResult?: ScanResult): string {
  const sentences = splitSentences(response);

  if (scanResult && scanResult.flaggedSentences.length > 0) {
    // Precise removal by index
    const flagged = new Set(scanResult.flaggedSentences);
    const cleaned = sentences.filter((_, i) => !flagged.has(i));
    return cleaned.join(' ').trim();
  }

  // Fallback: re-scan each sentence with regex
  const cleaned = sentences.filter((sentence) => {
    return (
      !isTherapyStyle(sentence) && !isEngagementHook(sentence) && !isIntimacySimulation(sentence)
    );
  });
  return cleaned.join(' ').trim();
}

// ---------------------------------------------------------------
// Internal: LLM guard scan
// ---------------------------------------------------------------

async function runLLMGuardScan(response: string): Promise<GuardViolation[]> {
  if (!llmGuardFn) return [];

  // PII scrub before sending to cloud LLM — the response may contain
  // emails, phone numbers, etc. from vault context that shouldn't leak.
  const { scrubbed: scrubbedResponse } = scrubPII(response);

  // Number each sentence for the LLM to reference by index
  const sentences = splitSentences(scrubbedResponse);
  const numbered = sentences.map((s, i) => `[${i}] ${s}`).join('\n');

  const prompt = GUARD_SCAN.replace('{{numbered_response}}', numbered);
  const raw = await llmGuardFn(
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
 * Prefers direct sentence_indices from the LLM (when available).
 * Falls back to text-based matching if indices are not provided.
 *
 * Expected format:
 *   {"safe": false, "violations": [{"type": "therapy_style", "sentence_indices": [1, 3], "text": "..."}]}
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
