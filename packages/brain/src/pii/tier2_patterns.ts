/**
 * Tier 2 PII pattern recognizers — TypeScript port of Presidio patterns.
 *
 * Scrubbed: EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IP_ADDRESS, US_SSN,
 *   AADHAAR_NUMBER, IN_PAN, IN_IFSC, IN_UPI_ID, IN_PASSPORT,
 *   DE_STEUER_ID, FR_NIR, NL_BSN, SWIFT_BIC
 *
 * Safe (never scrubbed): DATE, TIME, MONEY, PERCENT, QUANTITY, ORDINAL, CARDINAL, NORP
 *
 * Source: brain/tests/test_pii.py
 */

export interface PatternMatch {
  entity_type: string;
  start: number;
  end: number;
  score: number;
  value: string;
}

const SAFE_ENTITY_TYPES = new Set([
  'DATE',
  'TIME',
  'MONEY',
  'PERCENT',
  'QUANTITY',
  'ORDINAL',
  'CARDINAL',
  'NORP',
]);

interface PatternDef {
  entity_type: string;
  regex: RegExp;
  score: number;
  validate?: (m: string) => boolean;
}

const STRUCTURED_PATTERNS: PatternDef[] = [
  {
    entity_type: 'EMAIL_ADDRESS',
    regex: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    score: 0.95,
  },
  { entity_type: 'US_SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g, score: 0.9 },
  {
    entity_type: 'CREDIT_CARD',
    regex: /\b(\d[ \-]?){12,18}\d\b/g,
    score: 0.85,
    validate: (v: string) => {
      const d = v.replace(/[\s\-]/g, '');
      if (d.length < 13 || d.length > 19 || !/^\d+$/.test(d)) return false;
      let s = 0,
        a = false;
      for (let i = d.length - 1; i >= 0; i--) {
        let n = parseInt(d[i]);
        if (a) {
          n *= 2;
          if (n > 9) n -= 9;
        }
        s += n;
        a = !a;
      }
      return s % 10 === 0;
    },
  },
  {
    entity_type: 'IP_ADDRESS',
    regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    score: 0.8,
    validate: (m: string) =>
      m.split('.').every((o) => {
        const n = parseInt(o);
        return n >= 0 && n <= 255;
      }),
  },
  {
    entity_type: 'PHONE_NUMBER',
    regex: /(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g,
    score: 0.8,
    validate: (m: string) => {
      const d = m.replace(/\D/g, '');
      return d.length === 10 || (d.length === 11 && d[0] === '1');
    },
  },
];

const INDIAN_PATTERNS: PatternDef[] = [
  {
    entity_type: 'AADHAAR_NUMBER',
    regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    score: 0.85,
    validate: (m: string) => {
      const d = m.replace(/\s/g, '');
      return d.length === 12 && d[0] !== '0' && d[0] !== '1';
    },
  },
  { entity_type: 'IN_PAN', regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g, score: 0.9 },
  { entity_type: 'IN_IFSC', regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, score: 0.9 },
  {
    entity_type: 'IN_UPI_ID',
    regex: /\b[a-zA-Z0-9._]+@[a-zA-Z]{2,}\b/g,
    score: 0.75,
    validate: (m: string) => !m.split('@')[1].includes('.'),
  },
  { entity_type: 'PHONE_NUMBER', regex: /\+91\s?\d{5}\s?\d{5}\b/g, score: 0.85 },
];

const EU_PATTERNS: PatternDef[] = [
  // DE_STEUER_ID: 11 digits, first digit must be 1-9 (no leading zero).
  // Fixed: was \d{11} which allows leading zero (bug from §A76).
  { entity_type: 'DE_STEUER_ID', regex: /\b[1-9]\d{10}\b/g, score: 0.6 },
  {
    entity_type: 'FR_NIR',
    regex: /\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g,
    score: 0.7,
  },
  {
    entity_type: 'NL_BSN',
    regex: /\b\d{9}\b/g,
    score: 0.55,
    validate: (bsn: string) => {
      const d = bsn.replace(/\s/g, '');
      if (d.length !== 9 || !/^\d{9}$/.test(d)) return false;
      const w = [9, 8, 7, 6, 5, 4, 3, 2, -1];
      let s = 0;
      for (let i = 0; i < 9; i++) s += parseInt(d[i]) * w[i];
      return s % 11 === 0 && s > 0;
    },
  },
  // SWIFT_BIC: 8 or 11 characters. 8-char variant requires at least one digit
  // to avoid false positives on short English words.
  // Source: brain/src/adapter/recognizers_eu.py
  {
    entity_type: 'SWIFT_BIC',
    regex: /\b[A-Z]{4}[A-Z0-9]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
    score: 0.55,
    validate: (m: string) => {
      // 8-char BIC must contain at least one digit to reduce false positives
      if (m.length === 8) return /\d/.test(m);
      return true; // 11-char is less ambiguous
    },
  },
];

const ADDITIONAL_PATTERNS: PatternDef[] = [
  // IN_PASSPORT: 1 letter + 7 digits. Low base score (common false positives).
  // Source: brain/src/adapter/recognizers_india.py
  { entity_type: 'IN_PASSPORT', regex: /\b[A-Z]\d{7}\b/g, score: 0.3 },
];

/** Run all Tier 2 pattern recognizers on text. */
export function detectTier2(text: string): PatternMatch[] {
  if (!text) return [];
  return runPatterns(text, [
    ...STRUCTURED_PATTERNS,
    ...INDIAN_PATTERNS,
    ...EU_PATTERNS,
    ...ADDITIONAL_PATTERNS,
  ]);
}

/** Check if an entity type is on the safe list (never scrubbed). */
export function isSafeEntity(entityType: string): boolean {
  return SAFE_ENTITY_TYPES.has(entityType);
}

/** Get the list of all safe entity types. */
export function getSafeEntityTypes(): string[] {
  return Array.from(SAFE_ENTITY_TYPES);
}

/** Detect India-specific PII. */
export function detectIndianPII(text: string): PatternMatch[] {
  if (!text) return [];
  return runPatterns(text, INDIAN_PATTERNS);
}

/** Detect EU-specific PII. */
export function detectEUPII(text: string): PatternMatch[] {
  if (!text) return [];
  return runPatterns(text, EU_PATTERNS);
}

/** Apply synthetic replacement instead of token placeholders. */
export function applySyntheticReplacement(
  text: string,
  matches: PatternMatch[],
): { replaced: string; mappings: Array<{ original: string; synthetic: string }> } {
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  const mappings: Array<{ original: string; synthetic: string }> = [];
  let result = text;
  for (const match of sorted) {
    const synth = generateSynthetic(match.entity_type, mappings.length);
    result = result.slice(0, match.start) + synth + result.slice(match.end);
    mappings.push({ original: match.value, synthetic: synth });
  }
  return { replaced: result, mappings: mappings.reverse() };
}

function runPatterns(text: string, patterns: PatternDef[]): PatternMatch[] {
  const matches: PatternMatch[] = [];
  for (const pat of patterns) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      if (pat.validate && !pat.validate(m[0])) continue;
      matches.push({
        entity_type: pat.entity_type,
        start: m.index,
        end: m.index + m[0].length,
        score: pat.score,
        value: m[0],
      });
    }
  }
  // Resolve overlaps: prefer longer/earlier matches
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const result: PatternMatch[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      result.push(m);
      lastEnd = m.end;
    }
  }
  return result;
}

function generateSynthetic(entityType: string, index: number): string {
  const map: Record<string, string[]> = {
    PERSON: ['Jane Doe', 'John Smith', 'Alex Johnson'],
    EMAIL_ADDRESS: ['user@example.com', 'test@example.org'],
    PHONE_NUMBER: ['555-000-0001', '555-000-0002'],
    CREDIT_CARD: ['4000-0000-0000-0000'],
    US_SSN: ['000-00-0000'],
    IP_ADDRESS: ['0.0.0.0'],
  };
  const list = map[entityType] ?? [`[${entityType}]`];
  return list[index % list.length];
}
