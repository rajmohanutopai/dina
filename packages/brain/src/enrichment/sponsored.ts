/**
 * Sponsored content detection — identify and tag promotional content.
 *
 * Detects sponsored/promotional content via:
 *   1. Source-based detection: promo/marketing/newsletter sources
 *   2. Sender heuristics: noreply@, automated senders
 *   3. Content patterns: discount codes, "buy now", affiliate links
 *   4. Trust-level based: marketing sender_trust
 *
 * When detected, items are tagged with:
 *   - is_sponsored: true in metadata
 *   - [Sponsored] prefix on L0 headline
 *
 * Sponsored items are still stored (not dropped) but clearly labeled
 * so users can distinguish curated content from ads.
 *
 * Source: brain/src/service/guardian.py — sponsored content tagging
 */

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface SponsoredCheckInput {
  source?: string;
  sender?: string;
  sender_trust?: string;
  subject?: string;
  body?: string;
  labels?: string[];
}

export interface SponsoredResult {
  isSponsored: boolean;
  reason: string;
  confidence: number;
  method: 'source' | 'sender' | 'content' | 'trust' | 'label';
}

// ---------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------

/** Sources that indicate promotional content. */
const SPONSORED_SOURCES = new Set([
  'promo',
  'promotion',
  'promotions',
  'marketing',
  'newsletter',
  'sponsored',
  'ad',
  'advertisement',
  'affiliate',
]);

/** Sender patterns that indicate automated promotional email. */
const PROMO_SENDER_PATTERNS = [
  /^(noreply|no-reply|no\.reply|newsletter|marketing|promo|deals|offers|sales)@/i,
  /\b(newsletter|digest|weekly|daily\s*deal|offer|coupon)\b/i,
];

/** Content patterns that indicate sponsored/promotional text. */
const PROMO_CONTENT_PATTERNS = [
  /\b(use\s+code|promo\s*code|discount\s*code|coupon\s*code)\b/i,
  /\b(buy\s+now|shop\s+now|order\s+now|limited\s+time\s+offer)\b/i,
  /\b(unsubscribe|opt[\s-]*out|manage\s+preferences)\b/i,
  /\b(sponsored\s+(?:by|content|post|message))\b/i,
  /\b(affiliate|referral\s+link|partner\s+offer)\b/i,
  /\b(\d+%?\s+off|free\s+shipping|save\s+\$?\d+)\b/i,
];

/** Gmail/email labels that indicate promotions. */
const PROMO_LABELS = new Set(['promotions', 'promo', 'marketing', 'sponsored', 'ads']);

/** Trust levels that indicate promotional sender. */
const PROMO_TRUST_LEVELS = new Set(['marketing', 'spam']);

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Check if content is sponsored/promotional.
 *
 * Returns the highest-confidence detection result.
 * Priority: label > trust > source > sender > content
 */
export function detectSponsored(input: SponsoredCheckInput): SponsoredResult {
  // 1. Label-based (highest confidence — explicit categorization)
  if (input.labels) {
    for (const label of input.labels) {
      if (PROMO_LABELS.has(label.toLowerCase())) {
        return {
          isSponsored: true,
          reason: `Label "${label}" indicates promotional content`,
          confidence: 0.95,
          method: 'label',
        };
      }
    }
  }

  // 2. Trust-level based (sender classified as marketing)
  if (input.sender_trust && PROMO_TRUST_LEVELS.has(input.sender_trust.toLowerCase())) {
    return {
      isSponsored: true,
      reason: `Sender trust level "${input.sender_trust}" indicates promotional content`,
      confidence: 0.9,
      method: 'trust',
    };
  }

  // 3. Source-based (promo/marketing/newsletter sources)
  if (input.source && SPONSORED_SOURCES.has(input.source.toLowerCase())) {
    return {
      isSponsored: true,
      reason: `Source "${input.source}" is a known promotional channel`,
      confidence: 0.85,
      method: 'source',
    };
  }

  // 4. Sender heuristics (automated/newsletter senders)
  if (input.sender) {
    for (const pattern of PROMO_SENDER_PATTERNS) {
      if (pattern.test(input.sender)) {
        return {
          isSponsored: true,
          reason: 'Sender matches promotional/newsletter pattern',
          confidence: 0.75,
          method: 'sender',
        };
      }
    }
  }

  // 5. Content patterns (discount codes, "buy now", unsubscribe links)
  const text = `${input.subject ?? ''} ${input.body ?? ''}`;
  let contentMatches = 0;
  for (const pattern of PROMO_CONTENT_PATTERNS) {
    if (pattern.test(text)) contentMatches++;
  }
  // Require 2+ content matches to reduce false positives
  if (contentMatches >= 2) {
    return {
      isSponsored: true,
      reason: `${contentMatches} promotional content patterns detected`,
      confidence: 0.5 + Math.min(0.2, contentMatches * 0.1),
      method: 'content',
    };
  }

  return {
    isSponsored: false,
    reason: 'No promotional signals detected',
    confidence: 0,
    method: 'content',
  };
}

/**
 * Apply [Sponsored] tag to an L0 headline.
 *
 * If already tagged, returns unchanged.
 */
export function tagSponsored(headline: string): string {
  if (headline.startsWith('[Sponsored]')) return headline;
  return `[Sponsored] ${headline}`;
}

/**
 * Remove [Sponsored] tag from an L0 headline (for re-classification).
 */
export function untagSponsored(headline: string): string {
  return headline.replace(/^\[Sponsored\]\s*/, '');
}
