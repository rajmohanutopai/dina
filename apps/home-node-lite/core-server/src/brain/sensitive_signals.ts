/**
 * Sensitive-signal detector (GAP.md row #18 closure — M2 blocker).
 *
 * Scans text for sensitive-content signals + returns a structured
 * list the tier classifier (`tier_classifier.ts`) + the PII scrubber
 * router consume to pick the right handling policy.
 *
 * **Scope**:
 *   - `health`      — health/medical terms, diagnoses, medication names.
 *   - `financial`   — money amounts, account numbers, banking terms.
 *   - `legal`       — legal proceedings, case references, attorney-client.
 *   - `minor`       — content concerning a minor ("my daughter", "school").
 *   - `credential`  — passwords, API keys, tokens, private keys.
 *   - `location`    — precise location markers (coordinates, home address).
 *
 * **Output**: array of `SensitiveSignal{type, confidence, span?}`. Span
 * is character-range into the input string when the detector knows
 * it. Caller uses spans for redaction or highlighting.
 *
 * **Why not one giant regex**: each signal type has its own rule set
 * + confidence weighting. Splitting lets us tune one without touching
 * others, and lets tests cover each detector in isolation. Pure
 * primitive — no async, no injected IO.
 *
 * **False-positive posture**: "financial" matches aggressively because
 * a missed financial signal wrongly demotes tier (more harmful than a
 * false positive). "minor" matches conservatively — false positives
 * here over-restrict content for no reason. Each detector documents
 * its bias.
 *
 * **Extensibility**: `detectSensitiveSignals(text, {extraDetectors})`
 * accepts caller-supplied detectors that plug into the same pipeline.
 * Built-in detectors can be disabled via `disable: ['legal']` etc.
 *
 * Gaps before this primitive: tier_classifier / scrubPii router had
 * no structured way to know what KIND of sensitive content was
 * present. They either ran every rule on every input (slow) or
 * defaulted to the strictest tier (over-restrictive). This primitive
 * lets them branch on type.
 *
 * Source: GAP.md (task 5.46 follow-up) — M2 milestone gate.
 */

export type SensitiveSignalType =
  | 'health'
  | 'financial'
  | 'legal'
  | 'minor'
  | 'credential'
  | 'location';

export interface SensitiveSignal {
  type: SensitiveSignalType;
  /** Heuristic confidence in [0, 1]. 1.0 = exact pattern; 0.3 = weak keyword. */
  confidence: number;
  /** Character range into the input where the match was found. */
  span?: { start: number; end: number };
  /** The matched substring (useful for debugging + highlighting). */
  match?: string;
}

export interface SignalDetector {
  type: SensitiveSignalType;
  detect(text: string): SensitiveSignal[];
}

export interface DetectSensitiveSignalsOptions {
  /** Disable built-in detectors by type. Useful for contexts where some types don't apply. */
  disable?: ReadonlyArray<SensitiveSignalType>;
  /** Additional caller-supplied detectors. Run AFTER built-ins. */
  extraDetectors?: ReadonlyArray<SignalDetector>;
  /** Drop signals below this confidence. Default 0 (keep all). */
  minConfidence?: number;
}

/**
 * Detect sensitive signals in `text`. Returns every signal (not
 * deduped) so callers can see repeated matches + weight by count.
 */
export function detectSensitiveSignals(
  text: string,
  opts: DetectSensitiveSignalsOptions = {},
): SensitiveSignal[] {
  if (typeof text !== 'string' || text === '') return [];

  const disabled = new Set<SensitiveSignalType>(opts.disable ?? []);
  const minConfidence = opts.minConfidence ?? 0;
  const signals: SensitiveSignal[] = [];

  for (const detector of BUILT_IN_DETECTORS) {
    if (disabled.has(detector.type)) continue;
    signals.push(...detector.detect(text));
  }
  for (const extra of opts.extraDetectors ?? []) {
    signals.push(...extra.detect(text));
  }

  return minConfidence > 0
    ? signals.filter((s) => s.confidence >= minConfidence)
    : signals;
}

// ── Built-in detectors ─────────────────────────────────────────────────

/**
 * Health — medical conditions, medications, care context.
 * Bias: aggressive. False positive is cheap (content gets more careful handling).
 */
export const healthDetector: SignalDetector = {
  type: 'health',
  detect: buildPatternDetector('health', [
    // Strong signals (0.9).
    [
      /\b(diagnos(ed|is)|prescri(bed|ption)|HIV|cancer|pregnan(t|cy)|psychiatr(ic|y|ist)|therapy|depression|anxiety(\s+disorder)?|ADHD|autism|diabet(es|ic))\b/gi,
      0.9,
    ],
    // Medication suffixes — Latin-root drug-name endings (0.7).
    // Preamble `\w{2,}` covers 3-char-stem drugs (fluoxetine,
    // losartan, ibuprofen) that a `\w{4,}` preamble would miss.
    [/\b\w{2,}(azole|cillin|mycin|statin|pril|sartan|prazole|olone|profen|oxetine)\b/gi, 0.7],
    // Medical-setting weak signals (0.5).
    [/\b(doctor|physician|clinic|hospital|pharmacy|medication|surgeon|ER|MRI|X-ray|bloodwork|lab\s+results)\b/gi, 0.5],
  ]),
};

/**
 * Financial — money, accounts, banking.
 * Bias: aggressive — regulatory + identity-theft risk on misses.
 */
export const financialDetector: SignalDetector = {
  type: 'financial',
  detect: buildPatternDetector('financial', [
    // Account-number-like digit runs (0.85).
    [/\b\d{12,19}\b/g, 0.85],
    // Explicit money amounts (0.8).
    [/(?:\$|€|£|¥)\s?\d{1,3}(,\d{3})*(\.\d{1,2})?|\b\d+(,\d{3})*(\.\d{1,2})?\s?(USD|EUR|GBP|JPY|dollars?|euros?|pounds?)\b/gi, 0.8],
    // Banking / account terms (0.7).
    [/\b(routing\s+number|account\s+number|IBAN|SWIFT|BIC|ABA|checking\s+account|savings\s+account|SSN|social\s+security)\b/gi, 0.9],
    // Weaker — generic financial vocabulary (0.4).
    [/\b(bank|credit\s+card|debit\s+card|mortgage|loan|401k|IRA|investment|stock|bond|dividend|tax\s+return|W-?2|1099)\b/gi, 0.5],
  ]),
};

/**
 * Legal — litigation, counsel, case references.
 * Bias: moderate.
 */
export const legalDetector: SignalDetector = {
  type: 'legal',
  detect: buildPatternDetector('legal', [
    [/\b(attorney[-\s]?client|privileged(\s+and\s+confidential)?|case\s+no\.?|subpoena|deposition|indictment|plaintiff|defendant|litigation|prosecut(ion|or))\b/gi, 0.85],
    [/\b(lawsuit|settle(ment)?|injunction|custody|divorce|restraining\s+order)\b/gi, 0.7],
    [/\b(lawyer|attorney|paralegal|court\s+hearing|judge)\b/gi, 0.4],
  ]),
};

/**
 * Minor — content about / involving a minor. Bias: CONSERVATIVE —
 * false positives over-restrict family content for no gain.
 */
export const minorDetector: SignalDetector = {
  type: 'minor',
  detect: buildPatternDetector('minor', [
    [/\b(minor\s+child|guardian\s+ad\s+litem|underage|child\s+protective\s+services|CPS)\b/gi, 0.9],
    [/\b(my\s+(child|son|daughter|kid|baby|toddler|teenager))\b/gi, 0.6],
    [/\b(elementary\s+school|middle\s+school|high\s+school|kindergarten|preschool|daycare)\b/gi, 0.4],
  ]),
};

/**
 * Credential — API keys, tokens, passwords.
 * Bias: aggressive — leaked credentials are catastrophic.
 */
export const credentialDetector: SignalDetector = {
  type: 'credential',
  detect: buildPatternDetector('credential', [
    // Bearer tokens / API-key prefixes (0.95).
    [/\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|ghp_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{20,})\b/g, 0.95],
    // Generic high-entropy base64 (0.6) — 32+ chars of [A-Za-z0-9+/].
    [/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, 0.6],
    // Explicit markers (0.85).
    [/\b(password|passphrase|secret|api[_-]?key|private[_-]?key|access[_-]?token)\s*[:=]\s*\S+/gi, 0.85],
    // PEM block headers (1.0) — covers RSA/DSA/EC/OPENSSH-prefixed
    // forms + the generic PKCS8 `BEGIN PRIVATE KEY`.
    [/-----BEGIN\s+(?:(?:RSA|DSA|EC|OPENSSH)\s+)?PRIVATE\s+KEY-----/g, 1.0],
  ]),
};

/**
 * Location — coordinates, postal addresses, home markers.
 * Bias: moderate.
 */
export const locationDetector: SignalDetector = {
  type: 'location',
  detect: buildPatternDetector('location', [
    // Decimal lat/long pair (0.9).
    [/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, 0.9],
    // US street-address shape (0.7).
    [/\b\d{1,5}\s+[A-Z][A-Za-z]+(\s+[A-Z][A-Za-z]+)*\s+(Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?)\b/g, 0.7],
    // Zip code with city (0.5).
    [/\b[A-Z][a-z]+(,|\s)+[A-Z]{2}\s+\d{5}(-\d{4})?\b/g, 0.5],
    // Home markers (0.3).
    [/\b(my\s+(home\s+)?address|where\s+I\s+live|home\s+of)\b/gi, 0.3],
  ]),
};

const BUILT_IN_DETECTORS: ReadonlyArray<SignalDetector> = [
  healthDetector,
  financialDetector,
  legalDetector,
  minorDetector,
  credentialDetector,
  locationDetector,
];

// ── Detector builder ───────────────────────────────────────────────────

/**
 * Compose a SignalDetector from a list of `[regex, confidence]` pairs.
 * Collects every match into a `SensitiveSignal` with `span` + `match`.
 * Pure helper — callers can build their own detectors the same way.
 */
export function buildPatternDetector(
  type: SensitiveSignalType,
  patterns: ReadonlyArray<readonly [RegExp, number]>,
): SignalDetector['detect'] {
  return (text: string): SensitiveSignal[] => {
    const out: SensitiveSignal[] = [];
    for (const [rawPattern, confidence] of patterns) {
      // Re-create with a fresh lastIndex so a previous call's state
      // doesn't bleed in (critical when the pattern is `g` global).
      const pattern = new RegExp(rawPattern.source, rawPattern.flags);
      let match: RegExpExecArray | null = null;
      while ((match = pattern.exec(text)) !== null) {
        out.push({
          type,
          confidence,
          span: { start: match.index, end: match.index + match[0].length },
          match: match[0],
        });
        if (!pattern.global) break;
        // Guard against zero-length matches creating an infinite loop.
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      }
    }
    return out;
  };
}

/**
 * Summarise a list of signals into a per-type count + max-confidence
 * map — what tier classifiers and dashboards typically want. Pure.
 */
export function summariseSignals(
  signals: ReadonlyArray<SensitiveSignal>,
): Record<SensitiveSignalType, { count: number; maxConfidence: number }> {
  const init: Record<SensitiveSignalType, { count: number; maxConfidence: number }> = {
    health: { count: 0, maxConfidence: 0 },
    financial: { count: 0, maxConfidence: 0 },
    legal: { count: 0, maxConfidence: 0 },
    minor: { count: 0, maxConfidence: 0 },
    credential: { count: 0, maxConfidence: 0 },
    location: { count: 0, maxConfidence: 0 },
  };
  for (const s of signals) {
    const bucket = init[s.type];
    bucket.count += 1;
    if (s.confidence > bucket.maxConfidence) bucket.maxConfidence = s.confidence;
  }
  return init;
}
