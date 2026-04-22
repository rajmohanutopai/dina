/**
 * Two-pass email triage — reduce inbox volume before staging.
 *
 * Pass 1 (deterministic, fast):
 *   - Gmail category filter: PROMOTIONS, SOCIAL, FORUMS → SKIP
 *   - Sender heuristics: noreply@, no-reply@, notifications@ → SKIP
 *   - Subject heuristics: "Unsubscribe" in body → SKIP
 *   - Fiduciary override: security keywords → always INGEST regardless of category
 *
 * Pass 2 (LLM batch classify, optional):
 *   - Batch remaining items through LLM with INGEST/SKIP decision
 *   - Respects confidence threshold (default 0.7)
 *   - Falls back to INGEST if LLM unavailable (never lose data)
 *
 * Target: ~70% email volume reduction (promotions + social + bot notifications).
 *
 * Source: ARCHITECTURE.md Task 7.3
 */

export type TriageDecision = 'ingest' | 'skip';

export interface TriageResult {
  decision: TriageDecision;
  reason: string;
  pass: 1 | 2;
  confidence: number;
}

export interface EmailItem {
  id: string;
  from: string;
  subject: string;
  body: string;
  category?: string; // Gmail category: primary, social, promotions, updates, forums
  labels?: string[];
  timestamp?: number;
}

/** Injectable LLM classifier for Pass 2. */
export type LLMTriageClassifier = (items: EmailItem[]) => Promise<
  Array<{
    id: string;
    decision: TriageDecision;
    confidence: number;
  }>
>;

// ---------------------------------------------------------------
// Pass 1: Deterministic filters
// ---------------------------------------------------------------

/** Gmail categories that are auto-skipped. */
const SKIP_CATEGORIES = new Set(['promotions', 'social', 'forums']);

/** Sender patterns that indicate automated/bot messages. */
const BOT_SENDER_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^no\.reply@/i,
  /^notifications?@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^automated@/i,
  /^bounce[s]?@/i,
  /^info@.*\.noreply\./i,
];

/** Fiduciary keywords that override any skip decision. */
const FIDUCIARY_PATTERN =
  /\b(security alert|breach|unusual login|password reset|overdrawn|lab result|diagnosis|emergency|fraud alert|account locked|payment due|eviction|court|subpoena)\b/i;

/**
 * Pass 1: Deterministic triage.
 *
 * Fast, no LLM needed. Applies category, sender, and keyword filters.
 * Fiduciary keywords always force INGEST.
 */
export function triagePass1(item: EmailItem): TriageResult {
  const fullText = `${item.subject} ${item.body}`;

  // Fiduciary override — security/health/legal keywords always ingest
  if (FIDUCIARY_PATTERN.test(fullText)) {
    return {
      decision: 'ingest',
      reason: 'Fiduciary keyword detected — forced ingest',
      pass: 1,
      confidence: 0.99,
    };
  }

  // Gmail category filter
  if (item.category && SKIP_CATEGORIES.has(item.category.toLowerCase())) {
    return {
      decision: 'skip',
      reason: `Gmail category: ${item.category}`,
      pass: 1,
      confidence: 0.95,
    };
  }

  // Bot sender detection
  const fromAddr = extractEmail(item.from);
  if (isBotSender(fromAddr)) {
    return {
      decision: 'skip',
      reason: `Bot sender: ${fromAddr}`,
      pass: 1,
      confidence: 0.9,
    };
  }

  // Unsubscribe link heuristic (marketing emails)
  if (hasUnsubscribeSignal(item.body)) {
    return {
      decision: 'skip',
      reason: 'Unsubscribe link detected (marketing)',
      pass: 1,
      confidence: 0.8,
    };
  }

  // Pass 1 cannot decide — forward to Pass 2
  return {
    decision: 'ingest',
    reason: 'No skip signal — forwarding to Pass 2 or ingesting',
    pass: 1,
    confidence: 0.5,
  };
}

// ---------------------------------------------------------------
// Pass 2: LLM batch classify
// ---------------------------------------------------------------

import { TRIAGE_CONFIDENCE_THRESHOLD } from '../constants';
/** Default confidence threshold for LLM skip decisions. */
const LLM_CONFIDENCE_THRESHOLD = TRIAGE_CONFIDENCE_THRESHOLD;

/**
 * Pass 2: LLM-assisted triage for items that Pass 1 couldn't decide.
 *
 * If no LLM classifier is provided, defaults to INGEST (never lose data).
 */
export async function triagePass2(
  items: EmailItem[],
  classifier?: LLMTriageClassifier,
  confidenceThreshold?: number,
): Promise<Map<string, TriageResult>> {
  const results = new Map<string, TriageResult>();
  const threshold = confidenceThreshold ?? LLM_CONFIDENCE_THRESHOLD;

  if (!classifier || items.length === 0) {
    // No LLM available — default to ingest everything
    for (const item of items) {
      results.set(item.id, {
        decision: 'ingest',
        reason: 'No LLM classifier — default ingest',
        pass: 2,
        confidence: 0.5,
      });
    }
    return results;
  }

  const llmResults = await classifier(items);

  for (const llmResult of llmResults) {
    if (llmResult.decision === 'skip' && llmResult.confidence >= threshold) {
      results.set(llmResult.id, {
        decision: 'skip',
        reason: `LLM classified as skip (confidence: ${llmResult.confidence.toFixed(2)})`,
        pass: 2,
        confidence: llmResult.confidence,
      });
    } else {
      results.set(llmResult.id, {
        decision: 'ingest',
        reason:
          llmResult.decision === 'skip'
            ? `LLM skip below threshold (${llmResult.confidence.toFixed(2)} < ${threshold})`
            : 'LLM classified as ingest',
        pass: 2,
        confidence: llmResult.confidence,
      });
    }
  }

  // Items not returned by LLM → default ingest
  for (const item of items) {
    if (!results.has(item.id)) {
      results.set(item.id, {
        decision: 'ingest',
        reason: 'LLM did not classify this item — default ingest',
        pass: 2,
        confidence: 0.5,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------

/**
 * Run the full two-pass triage on a batch of emails.
 *
 * Returns a map of email ID → TriageResult.
 */
export async function triageBatch(
  items: EmailItem[],
  classifier?: LLMTriageClassifier,
): Promise<Map<string, TriageResult>> {
  const results = new Map<string, TriageResult>();
  const pass2Candidates: EmailItem[] = [];

  // Pass 1: deterministic
  for (const item of items) {
    const result = triagePass1(item);
    if (result.decision === 'skip' || result.confidence >= 0.9) {
      results.set(item.id, result);
    } else {
      pass2Candidates.push(item);
    }
  }

  // Pass 2: LLM (for undecided items)
  if (pass2Candidates.length > 0) {
    const pass2Results = await triagePass2(pass2Candidates, classifier);
    for (const [id, result] of pass2Results) {
      results.set(id, result);
    }
  }

  return results;
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** Extract email address from "Name <email>" or plain email. */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

/** Check if sender matches bot patterns. */
function isBotSender(email: string): boolean {
  return BOT_SENDER_PATTERNS.some((p) => p.test(email));
}

/** Check if body contains unsubscribe signals. */
function hasUnsubscribeSignal(body: string): boolean {
  return /\bunsubscribe\b/i.test(body) && /\bhttp/i.test(body);
}
