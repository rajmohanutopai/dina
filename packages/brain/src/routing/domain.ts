/**
 * Domain classifier — keyword-based persona routing.
 *
 * Routes incoming items to personas based on keyword matching.
 * Used as the first pass before LLM-based persona selection (task 3.11).
 *
 * Priority: strongest keyword match wins. If ambiguous or no match → "general".
 * Brain never invents persona names — only routes to known personas.
 *
 * Design aligned with Python domain_classifier.py:
 *   - Strong/weak keyword distinction (strong = definitive, weak = contextual)
 *   - Regex word-boundary matching (prevents "flu" matching "influence")
 *   - Confidence: strong*0.25 + weak*0.10, capped at 0.85
 *   - Legal domain included
 *
 * Source: brain/tests/test_routing.py, brain/src/service/domain_classifier.py
 */

import { resolveAlias } from '../persona/registry';

export interface ClassificationInput {
  type?: string;
  source?: string;
  sender?: string;
  subject?: string;
  body?: string;
}

export interface ClassificationResult {
  persona: string;
  confidence: number;
  matchedKeywords: string[];
  method: 'keyword' | 'fallback';
}

// ---------------------------------------------------------------
// Keyword tables per domain — strong/weak distinction
//
// Strong: definitive domain indicators (e.g., "diagnosis" → health)
// Weak:   contextual hints (e.g., "doctor" could be non-medical)
//
// Scoring: strong * 0.25, weak * 0.10 (matching Python classifier)
// ---------------------------------------------------------------

const HEALTH_STRONG = [
  'lab result',
  'diagnosis',
  'prescription',
  'medical',
  'hospital',
  'clinic',
  'pharmacy',
  'patient',
  'blood test',
  'x-ray',
  'mri',
  'ct scan',
  'vaccine',
  'symptom',
  'treatment',
  'therapy',
  'surgery',
  'blood sugar',
  'blood pressure',
  'cholesterol',
  'a1c',
  'biopsy',
  'oncology',
  'pathology',
  'medication',
  'dosage',
  'insulin',
  'hemoglobin',
  'diabetes',
  'hypertension',
  'chemotherapy',
];

const HEALTH_WEAK = [
  'doctor',
  'health',
  'appointment',
  'insurance claim',
  'copay',
  'deductible',
  'wellness',
  'diet',
  'exercise',
  'weight',
  'headache',
  'fever',
  'allergy',
];

const FINANCIAL_STRONG = [
  'invoice',
  'bank',
  'transaction',
  'credit card',
  'debit',
  'wire transfer',
  'tax',
  'salary',
  'payroll',
  'investment',
  'portfolio',
  'dividend',
  'stock',
  'mutual fund',
  'loan',
  'mortgage',
  'interest rate',
  'account balance',
  'statement',
  'bank account',
  'tax return',
  'income',
  'account number',
  'routing number',
  'swift',
  'iban',
];

const FINANCIAL_WEAK = [
  'payment',
  'receipt',
  'expense',
  'budget',
  'refund',
  'overdue',
  'money',
  'price',
  'cost',
  'savings',
  'insurance',
  'premium',
];

const PROFESSIONAL_STRONG = [
  'deadline',
  'project',
  'standup',
  'sprint',
  'quarterly',
  'annual report',
  'presentation',
  'proposal',
  'contract',
  'client',
  'performance review',
  'conference',
  'workshop',
];

const PROFESSIONAL_WEAK = [
  'meeting',
  'colleague',
  'manager',
  'team',
  'onboarding',
  'interview',
  'resume',
  'training',
];

const SOCIAL_STRONG = ['birthday', 'wedding', 'baby shower', 'graduation', 'reunion'];

const SOCIAL_WEAK = [
  'party',
  'dinner',
  'hangout',
  'catch up',
  'holiday',
  'vacation',
  'trip',
  'festival',
];

const CONSUMER_STRONG = ['order', 'shipment', 'delivery', 'tracking', 'subscription', 'warranty'];

const CONSUMER_WEAK = ['purchase', 'return', 'discount', 'coupon', 'sale', 'deal', 'amazon'];

const LEGAL_STRONG = [
  'lawsuit',
  'subpoena',
  'deposition',
  'court order',
  'litigation',
  'attorney',
  'lawyer',
  'legal counsel',
  'affidavit',
  'indictment',
  'bail',
  'probation',
  'verdict',
  'plea',
  'custody',
  'restraining order',
];

// ---------------------------------------------------------------
// Domain definitions
// ---------------------------------------------------------------

interface DomainDef {
  persona: string;
  strong: string[];
  weak: string[];
}

// Ordered by sensitivity: more sensitive domains win ties.
// Matches Python's sensitivity-based priority ordering.
const DOMAINS: DomainDef[] = [
  { persona: 'health', strong: HEALTH_STRONG, weak: HEALTH_WEAK },
  { persona: 'financial', strong: FINANCIAL_STRONG, weak: FINANCIAL_WEAK },
  { persona: 'legal', strong: LEGAL_STRONG, weak: [] },
  { persona: 'professional', strong: PROFESSIONAL_STRONG, weak: PROFESSIONAL_WEAK },
  { persona: 'social', strong: SOCIAL_STRONG, weak: SOCIAL_WEAK },
  { persona: 'consumer', strong: CONSUMER_STRONG, weak: CONSUMER_WEAK },
];

// ---------------------------------------------------------------
// Source-based hints (higher confidence than keyword alone)
// ---------------------------------------------------------------

const SOURCE_HINTS: Record<string, string> = {
  health_system: 'health',
  hospital: 'health',
  clinic: 'health',
  pharmacy: 'health',
  bank: 'financial',
  payroll: 'financial',
  tax: 'financial',
  hr: 'professional',
  jira: 'professional',
  slack: 'professional',
};

// ---------------------------------------------------------------
// Regex cache — built once per keyword, reused across calls
// ---------------------------------------------------------------

const regexCache = new Map<string, RegExp>();

/**
 * Build a word-boundary regex for a keyword.
 *
 * Uses \b on the left side only — prevents mid-word false positives
 * (e.g., "flu" won't match "influence") while allowing plural/suffix
 * forms (e.g., "lab result" matches "lab results").
 *
 * Multi-word keywords use flexible whitespace: "lab result" → /\blab\s+result/i
 */
function getKeywordRegex(keyword: string): RegExp {
  let re = regexCache.get(keyword);
  if (!re) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/\s+/g, '\\s+');
    re = new RegExp('\\b' + pattern, 'i');
    regexCache.set(keyword, re);
  }
  return re;
}

// ---------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------

/** Strong keyword match contributes this much to confidence. */
const STRONG_WEIGHT = 0.25;
/** Weak keyword match contributes this much to confidence. */
const WEAK_WEIGHT = 0.1;
/** Maximum keyword-based confidence (below source hint 0.90). */
const MAX_KEYWORD_CONFIDENCE = 0.85;

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Classify an item into a persona domain using keyword matching.
 *
 * Scoring: strong keywords contribute 0.25, weak contribute 0.10.
 * Word-boundary regex prevents mid-word false positives.
 *
 * @param input - Item metadata (type, source, sender, subject, body)
 * @returns Classification with persona name, confidence, matched keywords
 */
export function classifyDomain(input: ClassificationInput): ClassificationResult {
  const text = buildSearchText(input);
  const source = (input.source || '').toLowerCase();

  // Source-based hint (high confidence)
  const sourceHint = SOURCE_HINTS[source];
  if (sourceHint) {
    return {
      persona: sourceHint,
      confidence: 0.9,
      matchedKeywords: [`source:${source}`],
      method: 'keyword',
    };
  }

  // Keyword matching across all domains
  let bestPersona = 'general';
  let bestConfidence = 0;
  let bestKeywords: string[] = [];
  let bestSpecificity = 0; // longest keyword length — tiebreaker for equal confidence

  for (const domain of DOMAINS) {
    const { strongMatched, weakMatched, confidence } = scoreDomain(text, domain);
    const allMatched = [...strongMatched, ...weakMatched];
    const specificity = allMatched.reduce((max, kw) => Math.max(max, kw.length), 0);

    // Prefer higher confidence; on tie, prefer more specific (longer) keyword match
    if (
      confidence > bestConfidence ||
      (confidence === bestConfidence && specificity > bestSpecificity)
    ) {
      bestConfidence = confidence;
      bestPersona = domain.persona;
      bestKeywords = allMatched;
      bestSpecificity = specificity;
    }
  }

  if (bestConfidence > 0) {
    return {
      persona: bestPersona,
      confidence: Math.min(MAX_KEYWORD_CONFIDENCE, bestConfidence),
      matchedKeywords: bestKeywords,
      method: 'keyword',
    };
  }

  // No match → default to general
  return {
    persona: 'general',
    confidence: 0.3,
    matchedKeywords: [],
    method: 'fallback',
  };
}

/**
 * Fanout variant: return every persona whose score crossed the
 * confidence threshold, not just the single best.
 *
 * Main-dina's staging processor fans an item out to one-or-more
 * personas so the same memory lands on every persona it's relevant
 * to — a clinic email about a child's vaccination belongs on both
 * `health` and `family`. Returning just the single best persona
 * silently drops the secondary matches.
 *
 * Strategy: run the same keyword scoring as `classifyDomain`, then
 * include EVERY persona whose confidence is ≥ 0.5 (the same
 * threshold `isStrongMatch` uses). The primary (highest confidence)
 * is always first. On a no-match fallback, returns `['general']`.
 */
export function classifyPersonas(input: ClassificationInput): string[] {
  const text = buildSearchText(input);
  const source = (input.source || '').toLowerCase();

  const sourceHint = SOURCE_HINTS[source];
  if (sourceHint !== undefined) return [sourceHint];

  const scored: Array<{ persona: string; confidence: number }> = [];
  for (const domain of DOMAINS) {
    const { confidence } = scoreDomain(text, domain);
    if (confidence >= 0.5) {
      scored.push({ persona: domain.persona, confidence });
    }
  }
  if (scored.length === 0) return ['general'];

  // Sort DESC by confidence so the primary persona is first.
  scored.sort((a, b) => b.confidence - a.confidence);
  // Dedup in case two domain entries point at the same persona.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    if (!seen.has(s.persona)) {
      seen.add(s.persona);
      out.push(s.persona);
    }
  }
  return out;
}

/**
 * Classify and resolve through alias table.
 * Returns canonical persona name via resolveAlias, or "general" if unknown.
 */
export function classifyAndResolve(input: ClassificationInput): ClassificationResult {
  const result = classifyDomain(input);
  const resolved = resolveAlias(result.persona);
  if (resolved) {
    result.persona = resolved;
  } else {
    result.persona = 'general';
    result.confidence = 0.3;
  }
  return result;
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/** Build a single lowercase search string from all input fields. */
function buildSearchText(input: ClassificationInput): string {
  return [
    input.type || '',
    input.source || '',
    input.sender || '',
    input.subject || '',
    input.body || '',
  ]
    .join(' ')
    .toLowerCase();
}

/** Score a single domain against text. Returns matched keywords and confidence. */
function scoreDomain(
  text: string,
  domain: DomainDef,
): {
  strongMatched: string[];
  weakMatched: string[];
  confidence: number;
} {
  const strongMatched = matchKeywords(text, domain.strong);
  const weakMatched = matchKeywords(text, domain.weak);
  const confidence = strongMatched.length * STRONG_WEIGHT + weakMatched.length * WEAK_WEIGHT;
  return { strongMatched, weakMatched, confidence };
}

/**
 * Find which keywords from the list appear in the text.
 *
 * Uses word-boundary regex on the left side to prevent mid-word
 * false positives while allowing plural/suffix forms.
 */
function matchKeywords(text: string, keywords: string[]): string[] {
  const matched: string[] = [];
  for (const kw of keywords) {
    if (getKeywordRegex(kw).test(text)) {
      matched.push(kw);
    }
  }
  return matched;
}
