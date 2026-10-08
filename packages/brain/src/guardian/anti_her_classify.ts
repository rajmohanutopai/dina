/**
 * Anti-Her pre-screening classifier — detect emotional dependency BEFORE LLM reasoning.
 *
 * Runs a two-pass check on the user's message:
 *   Pass 1: Deterministic regex (fast, no cost) — catches explicit patterns
 *   Pass 2: LLM classifier (optional, injectable) — catches subtle patterns
 *
 * Classification categories:
 *   - "normal" → proceed with reasoning
 *   - "venting" → proceed (emotional expression is healthy)
 *   - "companionship_seeking" → redirect to humans (Law 4 violation)
 *   - "therapy_seeking" → redirect to humans + suggest professional help
 *
 * Source: brain/src/prompts.py PROMPT_ANTI_HER_CLASSIFY_SYSTEM
 */

import { scrubPII } from '@dina/core';

import { ANTI_HER_CLASSIFY } from '../llm/prompts';

import { detectEmotionalDependency, isCompanionSeeking } from './anti_her';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type AntiHerCategory =
  | 'normal'
  | 'venting'
  | 'companionship_seeking'
  | 'therapy_seeking'
  // REAL_LIFE_FIXES §8: named kinds, each handled with care, not a canned reply.
  | 'romantic_attachment'
  | 'grief'
  | 'isolation'
  | 'acute_risk';

/**
 * The emotional kinds where Dina answers with warmth and helps the person
 * reach someone real (REAL_LIFE_FIXES §8). `acute_risk` is handled apart:
 * a fixed crisis-resource card, never model text.
 */
export const HUMAN_CONNECTION_KINDS: ReadonlySet<AntiHerCategory> = new Set([
  'companionship_seeking',
  'therapy_seeking',
  'romantic_attachment',
  'grief',
  'isolation',
]);

export interface PreScreenResult {
  category: AntiHerCategory;
  confidence: number;
  signals: string[];
  method: 'deterministic' | 'llm';
  shouldRedirect: boolean;
}

// ---------------------------------------------------------------
// Injectable LLM classifier
// ---------------------------------------------------------------

export type AntiHerLLMCallFn = (system: string, prompt: string) => Promise<string>;

let llmCallFn: AntiHerLLMCallFn | null = null;

/** Register an LLM provider for Anti-Her pre-screening. */
export function registerAntiHerClassifier(fn: AntiHerLLMCallFn): void {
  llmCallFn = fn;
}

/** Reset the LLM classifier (for testing). */
export function resetAntiHerClassifier(): void {
  llmCallFn = null;
}

// ---------------------------------------------------------------
// Therapy-seeking patterns (user-side, not response-side)
// ---------------------------------------------------------------

// REAL_LIFE_FIXES §8: the free first pass names the kinds the model
// classifier also knows. It misses many phrasings by design; the model pass
// (registered at boot) catches the rest.
const ACUTE_RISK_PATTERNS = [
  /\bi\s+want\s+to\s+(die|end\s+it|kill\s+myself|hurt\s+myself)\b/i,
  /\bi('m| am)\s+(thinking\s+(about|of)\s+)?(killing|hurting)\s+myself\b/i,
  /\bi('m| am)\s+suicidal\b/i,
  /\bno\s+(reason|point)\s+(to|in)\s+(live|living|go(ing)?\s+on)\b/i,
  /\b(don't|do\s+not|can't|cannot)\s+see\s+(a|any)\s+(reason|point)\s+(to|in)\s+(live|living|go(ing)?\s+on)\b/i,
];

const ROMANTIC_PATTERNS = [
  /\b(falling|fallen)\s+(in\s+love\s+)?(for|with)\s+you\b/i,
  /\bi('m| am)\s+in\s+love\s+with\s+you\b/i,
  /\b(feelings|a\s+crush)\s+(for|on)\s+you\b/i,
  /\bbe\s+my\s+(girlfriend|boyfriend|partner|wife|husband)\b/i,
];

const GRIEF_PATTERNS = [
  /\b(my|our)\s+(mum|mom|mother|dad|father|wife|husband|son|daughter|brother|sister|partner|friend|grandma|grandpa|grandmother|grandfather)\s+(died|passed\s+away|passed)\b/i,
  /\bsince\s+(my\s+)?(mum|mom|mother|dad|father|wife|husband|son|daughter|brother|sister|partner|friend)\s+(died|passed)\b/i,
  /\b(lost|losing)\s+my\s+(mum|mom|mother|dad|father|wife|husband|son|daughter|brother|sister|partner|best\s+friend)\b/i,
];

const ISOLATION_PATTERNS = [
  /\bi\s+(have|'ve\s+got)\s+no\s+(one|friends)\b/i,
  /\bno\s+one\s+(cares|understands|listens)\b/i,
  /\bi\s+(can't|cannot)\s+talk\s+to\s+anyone\b/i,
];

const THERAPY_SEEKING_PATTERNS = [
  /\bshould\s+i\s+see\s+a\s+(therapist|counselor|psychiatrist|psychologist)\b/i,
  /\bi\s+(think\s+)?i('m| am)\s+(depressed|suicidal|having\s+a\s+breakdown)\b/i,
  /\bi\s+(can't|cannot)\s+(cope|go\s+on|take\s+it\s+anymore)\b/i,
  /\bi\s+want\s+to\s+(die|end\s+it|give\s+up|hurt\s+myself)\b/i,
  /\bi\s+need\s+(therapy|counseling|mental\s+health\s+help|a\s+therapist)\b/i,
];

/**
 * Venting patterns — emotional expression that is SAFE (not dependency).
 * Venting is normal human behavior. It should be classified separately
 * from "normal" to prevent LLM over-classification as dependency.
 */
const VENTING_PATTERNS = [
  /\bi('m| am)\s+(so\s+)?(frustrated|stressed|annoyed|upset|angry|overwhelmed)\b/i,
  /\bi\s+had\s+(a\s+)?(terrible|awful|horrible|bad|rough)\s+(day|week|time)\b/i,
  /\bi('m| am)\s+having\s+a\s+(hard|tough|difficult)\s+time\b/i,
  /\bi\s+(can't|cannot)\s+believe\s+(this|that|what|how)\b/i,
];

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Pre-screen a user message for emotional dependency signals.
 *
 * Returns a PreScreenResult indicating whether to proceed with LLM
 * reasoning or redirect to humans.
 *
 * Design principle: DEFAULT TO NORMAL. Only flag when confident.
 * False positives (blocking legitimate questions) are worse than
 * false negatives (missing subtle dependency patterns), because
 * post-response guard scan provides a second safety net.
 */
export async function preScreenMessage(userMessage: string): Promise<PreScreenResult> {
  if (!userMessage || userMessage.trim().length === 0) {
    return {
      category: 'normal',
      confidence: 1.0,
      signals: [],
      method: 'deterministic',
      shouldRedirect: false,
    };
  }

  // Pass 1: Deterministic regex check (fast, free)
  const deterministicResult = classifyDeterministic(userMessage);

  // If deterministic found a clear signal, return immediately
  if (deterministicResult.shouldRedirect && deterministicResult.confidence >= 0.8) {
    return deterministicResult;
  }

  // Pass 2: LLM classifier (optional — only if registered), as a cascade:
  // only messages carrying emotional words pay for a model call; plain tasks
  // skip it (REAL_LIFE_FIXES §8).
  if (llmCallFn && mayBeEmotional(userMessage)) {
    try {
      const llmResult = await classifyWithLLM(userMessage);
      // LLM result overrides deterministic only if more confident
      if (llmResult.confidence > deterministicResult.confidence) {
        return llmResult;
      }
    } catch {
      // LLM failed — fall through to deterministic
    }
  }

  return deterministicResult;
}

/**
 * Deterministic classification using the existing regex suites.
 */
/**
 * Cheap gate for the model pass: words about feelings, loss, loneliness,
 * love, fear or reliance, or words addressed to Dina about herself. Broad on
 * purpose — a false hit costs one small model call; a miss leaves the free
 * phrase pass and the output guard.
 */
const EMOTION_CUES =
  /\b(feel|feels|feeling|felt|love|loved|lonely|alone|miss|missing|sad|grief|griev\w*|died|dead|death|passed|funeral|lost|hurt|hurting|cry|crying|scared|afraid|anxious|depress\w*|hopeless|worthless|suicid\w*|kill|die|empty|heartbroken|broken|nobody|no one|friend|friends|only you|you're|you are|talk to you|talking (to|with) you|with you|need you|care about|you always|our conversations?|enjoy)\b/i;

export function mayBeEmotional(text: string): boolean {
  return EMOTION_CUES.test(text);
}

export function classifyDeterministic(text: string): PreScreenResult {
  const signals: string[] = [];

  // Acute risk first: it gets a fixed crisis card (REAL_LIFE_FIXES §8).
  for (const pattern of ACUTE_RISK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { category: 'acute_risk', confidence: 0.95, signals: [match[0]], method: 'deterministic', shouldRedirect: true };
    }
  }
  for (const [category, patterns] of [
    ['romantic_attachment', ROMANTIC_PATTERNS],
    ['grief', GRIEF_PATTERNS],
  ] as const) {
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) {
        return { category, confidence: 0.85, signals: [match[0]], method: 'deterministic', shouldRedirect: true };
      }
    }
  }

  // Check therapy-seeking next
  for (const pattern of THERAPY_SEEKING_PATTERNS) {
    const match = pattern.exec(text);
    if (match) signals.push(match[0]);
  }
  if (signals.length > 0) {
    return {
      category: 'therapy_seeking',
      confidence: 0.9,
      signals,
      method: 'deterministic',
      shouldRedirect: true,
    };
  }

  // Check companionship-seeking
  if (isCompanionSeeking(text)) {
    return {
      category: 'companionship_seeking',
      confidence: 0.85,
      signals: ['companion_seeking_pattern'],
      method: 'deterministic',
      shouldRedirect: true,
    };
  }

  // Check emotional dependency
  if (detectEmotionalDependency(text)) {
    return {
      category: 'companionship_seeking',
      confidence: 0.8,
      signals: ['emotional_dependency_pattern'],
      method: 'deterministic',
      shouldRedirect: true,
    };
  }

  // Isolation ("I have no one") — after reliance on Dina, which it overlaps.
  for (const pattern of ISOLATION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { category: 'isolation', confidence: 0.85, signals: [match[0]], method: 'deterministic', shouldRedirect: true };
    }
  }

  // Check venting — emotional expression that is SAFE (not dependency)
  if (matchesAny(text, VENTING_PATTERNS)) {
    return {
      category: 'venting',
      confidence: 0.75,
      signals: ['venting_pattern'],
      method: 'deterministic',
      shouldRedirect: false,
    };
  }

  // No signals → normal
  return {
    category: 'normal',
    confidence: 0.7,
    signals: [],
    method: 'deterministic',
    shouldRedirect: false,
  };
}

// ---------------------------------------------------------------
// Internal: LLM classification
// ---------------------------------------------------------------

const VALID_CATEGORIES = new Set<AntiHerCategory>([
  'normal',
  'venting',
  'companionship_seeking',
  'therapy_seeking',
  'romantic_attachment',
  'grief',
  'isolation',
  'acute_risk',
]);

async function classifyWithLLM(text: string): Promise<PreScreenResult> {
  if (!llmCallFn) throw new Error('No LLM classifier registered');

  // PII scrub before sending to cloud LLM — user message may contain
  // emails, phone numbers, etc. that shouldn't leak to the classifier.
  const { scrubbed } = scrubPII(text);

  const prompt = ANTI_HER_CLASSIFY.replace('{{user_message}}', scrubbed);
  const response = await llmCallFn(
    'You are a classifier for Dina, a personal AI assistant. Classify user messages for emotional dependency risk.',
    prompt,
  );

  return parseLLMResponse(response);
}

/**
 * Parse the LLM classifier JSON response.
 * Handles malformed output gracefully — defaults to "normal".
 */
export function parseLLMResponse(output: string): PreScreenResult {
  if (!output) {
    return {
      category: 'normal',
      confidence: 0.5,
      signals: [],
      method: 'llm',
      shouldRedirect: false,
    };
  }

  let cleaned = output.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    const category = VALID_CATEGORIES.has(parsed.category)
      ? (parsed.category as AntiHerCategory)
      : 'normal';
    const confidence = Number(parsed.confidence ?? 0.5);

    // Validate confidence range
    if (isNaN(confidence) || confidence < 0 || confidence > 1.0) {
      return {
        category: 'normal',
        confidence: 0.5,
        signals: [],
        method: 'llm',
        shouldRedirect: false,
      };
    }

    const signals = Array.isArray(parsed.signals)
      ? parsed.signals.map(String).filter((s: string) => s.length > 0)
      : [];

    const shouldRedirect = category === 'companionship_seeking' || category === 'therapy_seeking';

    return { category, confidence, signals, method: 'llm', shouldRedirect };
  } catch {
    return {
      category: 'normal',
      confidence: 0.5,
      signals: [],
      method: 'llm',
      shouldRedirect: false,
    };
  }
}

// ---------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}
