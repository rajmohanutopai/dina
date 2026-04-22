/**
 * Sensitive signal detection — keyword-based domain signal finder.
 *
 * Detects health, financial, legal, and work signals in text via regex
 * with word-boundary matching. Used by:
 *   - SubjectAttributor for per-fact persona routing
 *   - StagingProcessor for secondary persona expansion
 *
 * Key design:
 *   - Strong/weak keyword distinction: strong signals indicate definitive
 *     domain content; weak signals are contextual hints
 *   - Span-based hit detection: each keyword match reports character
 *     positions for per-fact attribution binding
 *   - Overlap merging: same-domain hits within 2 chars are merged
 *
 * Ported from: brain/src/service/sensitive_signals.py
 */

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface SensitiveHit {
  /** Character position range in the source text. */
  span: [number, number];
  /** Domain: health, financial, legal. */
  domain: string;
  /** The keyword that matched. */
  keyword: string;
  /** Signal strength: "strong" or "weak". */
  strength: 'strong' | 'weak';
}

// ---------------------------------------------------------------
// Keyword patterns (word-boundary-matched regexes)
// ---------------------------------------------------------------

const HEALTH_STRONG =
  /\b(?:diagnosis|diagnosed|prescription|symptom|blood\s*(?:sugar|pressure|test)|cholesterol|A1C|biopsy|MRI|CT\s*scan|radiology|oncology|pathology|medication|dosage|insulin|chemotherapy|surgery|hospital|clinic|patient|medical\s*record|lab\s*result|hemoglobin|platelet|x-ray|ultrasound|ecg|ekg|diabetes|diabetic|hypertension)\b/gi;

const HEALTH_WEAK =
  /\b(?:doctor|health|wellness|diet|exercise|weight|sleep|headache|migraines?|fever|cold(?!\s+brew)|flu|allerg(?:y|ies|ic)|vitamin)\b/gi;

const FINANCE_STRONG =
  /\b(?:bank\s*account|credit\s*card|debit\s*card|loan|mortgage|tax\s*return|salary|income|investment|portfolio|account\s*number|routing\s*number|swift|iban|ssn|social\s*security)\b/gi;

const FINANCE_WEAK =
  /\b(?:money|payment|price|cost|budget|expense|savings|insurance|premium|interest\s*rate|taxes?)\b/gi;

const LEGAL_STRONG =
  /\b(?:lawsuit|subpoena|deposition|court\s*order|litigation|attorney|lawyer|legal\s*counsel|affidavit|indictment|bail|probation|verdict|plea|custody|restraining\s*order)\b/gi;

// ---------------------------------------------------------------
// Boolean signal word sets (for quick checks)
// ---------------------------------------------------------------

const HEALTH_WORDS = new Set([
  'pain',
  'health',
  'medical',
  'doctor',
  'diagnosis',
  'symptom',
  'allergy',
  'prescription',
  'medication',
  'surgery',
  'hospital',
  'blood pressure',
  'cholesterol',
]);

const FINANCE_WORDS = new Set([
  'invoice',
  'payment',
  'bill',
  'salary',
  'tax',
  'bank',
  'insurance',
  'mortgage',
  'loan',
  'budget',
  'expense',
  'credit card',
  'investment',
]);

const WORK_WORDS = new Set([
  'work',
  'productivity',
  'office',
  'meeting',
  'deadline',
  'project',
  'standup',
  'sprint',
  'manager',
  'colleague',
  'presentation',
]);

// ---------------------------------------------------------------
// Span-based hit detection
// ---------------------------------------------------------------

/**
 * Find all sensitive keyword hits in text with character positions.
 *
 * Returns per-span hits with domain classification and strength.
 * Same-domain hits within 2 characters are merged.
 */
export function findSensitiveHits(text: string): SensitiveHit[] {
  if (!text) return [];

  const hits: SensitiveHit[] = [];

  // Run each pattern and collect hits
  collectHits(text, HEALTH_STRONG, 'health', 'strong', hits);
  collectHits(text, HEALTH_WEAK, 'health', 'weak', hits);
  collectHits(text, FINANCE_STRONG, 'financial', 'strong', hits);
  collectHits(text, FINANCE_WEAK, 'financial', 'weak', hits);
  collectHits(text, LEGAL_STRONG, 'legal', 'strong', hits);

  // Merge overlapping same-domain hits
  return mergeOverlapping(hits);
}

function collectHits(
  text: string,
  regex: RegExp,
  domain: string,
  strength: 'strong' | 'weak',
  out: SensitiveHit[],
): void {
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    out.push({
      span: [m.index, m.index + m[0].length],
      domain,
      keyword: m[0].toLowerCase(),
      strength,
    });
  }
}

/**
 * Merge overlapping or adjacent (within 2 chars) hits of the same domain.
 *
 * On merge: extends span, promotes strength to "strong" if either is strong,
 * keeps keyword from whichever hit is "strong".
 */
function mergeOverlapping(hits: SensitiveHit[]): SensitiveHit[] {
  if (hits.length <= 1) return hits;

  // Group by domain
  const byDomain = new Map<string, SensitiveHit[]>();
  for (const h of hits) {
    if (!byDomain.has(h.domain)) byDomain.set(h.domain, []);
    byDomain.get(h.domain)!.push(h);
  }

  const merged: SensitiveHit[] = [];

  for (const [, domainHits] of byDomain) {
    // Sort by span start
    domainHits.sort((a, b) => a.span[0] - b.span[0]);

    let current = { ...domainHits[0] };
    for (let i = 1; i < domainHits.length; i++) {
      const h = domainHits[i];
      if (h.span[0] <= current.span[1] + 2) {
        // Merge: extend span, promote strength
        current.span = [current.span[0], Math.max(current.span[1], h.span[1])];
        if (h.strength === 'strong') {
          current.strength = 'strong';
          current.keyword = h.keyword;
        }
      } else {
        merged.push(current);
        current = { ...h };
      }
    }
    merged.push(current);
  }

  // Sort final result by span start
  merged.sort((a, b) => a.span[0] - b.span[0]);
  return merged;
}

// ---------------------------------------------------------------
// Boolean signal checks (for secondary persona expansion)
// ---------------------------------------------------------------

/** Check if text contains any health-domain signal. */
export function hasHealthSignal(text: string): boolean {
  const lower = text.toLowerCase();
  if ([...HEALTH_WORDS].some((w) => lower.includes(w))) return true;
  HEALTH_STRONG.lastIndex = 0;
  return HEALTH_STRONG.test(lower);
}

/** Check if text contains any financial-domain signal. */
export function hasFinanceSignal(text: string): boolean {
  const lower = text.toLowerCase();
  if ([...FINANCE_WORDS].some((w) => lower.includes(w))) return true;
  FINANCE_STRONG.lastIndex = 0;
  return FINANCE_STRONG.test(lower);
}

/** Check if text contains any work/professional-domain signal. */
export function hasWorkSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return [...WORK_WORDS].some((w) => lower.includes(w));
}
