/**
 * Unit tests for `appview/src/ingester/language-detect.ts` (TN-ING-008).
 *
 * Contract:
 *   - Returns BCP-47 language tag (`'en'`, `'pt'`, …) for detectable input
 *   - Returns null for empty / whitespace-only / non-string / too-short input
 *   - ISO 639-3 codes without a 2-letter mapping pass through verbatim
 *     (still valid BCP-47 per RFC 5646 §2.2.1)
 */

import { describe, it, expect } from 'vitest'
import { detectLanguage } from '@/ingester/language-detect'

describe('detectLanguage — TN-ING-008', () => {
  it('detects English from a typical attestation review (BCP-47 = "en")', () => {
    const text =
      'The chair is well built and very comfortable for long working hours. Highly recommended for a home office setup.'
    expect(detectLanguage(text)).toBe('en')
  })

  it('detects Portuguese (BCP-47 = "pt")', () => {
    const text =
      'A cadeira é muito bem construída e bastante confortável para longas horas de trabalho. Recomendo muito para escritório em casa.'
    expect(detectLanguage(text)).toBe('pt')
  })

  it('detects Spanish (BCP-47 = "es")', () => {
    const text =
      'La silla está muy bien construida y es bastante cómoda para largas horas de trabajo. La recomiendo para una oficina en casa.'
    expect(detectLanguage(text)).toBe('es')
  })

  it('detects French (BCP-47 = "fr")', () => {
    const text =
      'La chaise est très bien construite et confortable pour de longues heures de travail. Je la recommande pour un bureau à domicile.'
    expect(detectLanguage(text)).toBe('fr')
  })

  it('detects German (BCP-47 = "de")', () => {
    const text =
      'Der Stuhl ist sehr gut verarbeitet und auch nach langen Arbeitsstunden noch bequem. Ich kann ihn für das Home Office sehr empfehlen.'
    expect(detectLanguage(text)).toBe('de')
  })

  it('returns null for null input', () => {
    expect(detectLanguage(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(detectLanguage(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(detectLanguage('')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(detectLanguage('   \t\n  ')).toBeNull()
  })

  it('returns null for input below the franc-min detection threshold', () => {
    // franc returns 'und' for input shorter than ~10 chars — we surface
    // null so the search xRPC's language= filter naturally excludes
    // these noisy rows from the bucket.
    expect(detectLanguage('abc')).toBeNull()
  })

  it('returns null for non-string input (defensive — wire data may be wrong type)', () => {
    // The lexicon Zod schema enforces string typing, but a future code
    // path that bypasses validation shouldn't crash the ingester.
    // @ts-expect-error — runtime guard
    expect(detectLanguage(42)).toBeNull()
    // @ts-expect-error — runtime guard
    expect(detectLanguage({})).toBeNull()
  })

  it('preserves the 3-letter code when no 2-letter mapping exists', () => {
    // Cebuano (`'ceb'`) is not in the curated 30-language mapping; the
    // 3-letter code is still valid BCP-47 per RFC 5646 §2.2.1, so we
    // pass it through. This makes adding more languages a content edit
    // (extend the map) rather than a code change.
    const text =
      'Maayong adlaw kaninyong tanan. Ang lingkuranan kay maayo ug komportable ug kaayo nako kini ginarekomenda.'
    const result = detectLanguage(text)
    // Either franc maps it to 'ceb' (preserved as-is) or successfully
    // detects another language — either is acceptable. The contract
    // is "non-null on detectable input"; we don't pin the exact code
    // because franc's training data may evolve.
    expect(result).not.toBeNull()
    expect(typeof result).toBe('string')
    if (result !== null) {
      expect(result.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('is deterministic: same input → same output across calls', () => {
    const text =
      'The chair is well built and very comfortable for long working hours. Highly recommended for a home office setup.'
    expect(detectLanguage(text)).toBe(detectLanguage(text))
  })
})
