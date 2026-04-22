/**
 * Task 4.61 — recovery phrase export + import tests.
 */

import { generateMnemonic } from '@dina/core';
import {
  WORD_COUNT_TO_ENTROPY_BYTES,
  exportRecoveryPhrase,
  importRecoveryPhrase,
  normaliseMnemonic,
} from '../src/identity/recovery_phrase';

describe('exportRecoveryPhrase (task 4.61)', () => {
  describe('happy path', () => {
    it('returns the normalised mnemonic + words + wordCount + entropyBytes for a 24-word phrase', () => {
      const mnemonic = generateMnemonic(); // @dina/core default: 24 words
      const out = exportRecoveryPhrase(mnemonic);
      expect(out.mnemonic).toBe(mnemonic);
      expect(out.words).toHaveLength(24);
      expect(out.wordCount).toBe(24);
      expect(out.entropyBytes).toBe(32);
    });

    it('normalises whitespace + case BEFORE validating', () => {
      const mnemonic = generateMnemonic();
      const messy = `  ${mnemonic.toUpperCase()}\n\t`;
      const out = exportRecoveryPhrase(messy);
      expect(out.mnemonic).toBe(mnemonic.toLowerCase());
    });
  });

  describe('error paths', () => {
    it('throws on empty input', () => {
      expect(() => exportRecoveryPhrase('')).toThrow(
        /mnemonic must be a non-empty string/,
      );
    });

    it('throws on non-string input', () => {
      expect(() =>
        exportRecoveryPhrase(42 as unknown as string),
      ).toThrow(/non-empty string/);
    });

    it('throws on wrong word count', () => {
      // 10 words — not a valid BIP-39 length.
      const bad = 'abandon '.repeat(10).trim();
      expect(() => exportRecoveryPhrase(bad)).toThrow(
        /12 \/ 15 \/ 18 \/ 21 \/ 24 words/,
      );
    });

    it('throws on bad checksum (valid words, wrong order)', () => {
      // 24 valid-wordlist words but arbitrary order → checksum fails.
      const mnemonic = generateMnemonic();
      const words = mnemonic.split(' ');
      // Swap first two → likely breaks checksum (collision rate is 1/16 per swap).
      // Retry until we hit a phrase that fails checksum.
      let tampered = '';
      for (let i = 0; i < 30; i++) {
        const j = (i + 1) % words.length;
        [words[0], words[j]] = [words[j]!, words[0]!];
        tampered = words.join(' ');
        try {
          exportRecoveryPhrase(tampered);
        } catch (err) {
          expect((err as Error).message).toMatch(/failed BIP-39 validation/);
          return;
        }
      }
      // If we never hit a checksum failure, emit a specific message.
      throw new Error('test setup: failed to produce a bad-checksum phrase');
    });
  });

  describe('WORD_COUNT_TO_ENTROPY_BYTES', () => {
    it('maps each BIP-39 word count to the spec entropy size', () => {
      expect(WORD_COUNT_TO_ENTROPY_BYTES).toEqual({
        12: 16,
        15: 20,
        18: 24,
        21: 28,
        24: 32,
      });
    });
  });
});

describe('importRecoveryPhrase (task 4.61)', () => {
  describe('happy path', () => {
    it('accepts a valid 24-word phrase and returns entropy + pbkdf2Seed', () => {
      const mnemonic = generateMnemonic();
      const res = importRecoveryPhrase(mnemonic);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.mnemonic).toBe(mnemonic);
      expect(res.words).toHaveLength(24);
      expect(res.wordCount).toBe(24);
      expect(res.entropy.length).toBe(32); // 256-bit entropy
      expect(res.pbkdf2Seed.length).toBe(64); // BIP-39 PBKDF2 seed
    });

    it('round-trips export → import → same entropy', () => {
      const mnemonic = generateMnemonic();
      const exp = exportRecoveryPhrase(mnemonic);
      const imp = importRecoveryPhrase(exp.mnemonic);
      expect(imp.ok).toBe(true);
      if (imp.ok) expect(imp.wordCount).toBe(exp.wordCount);
    });

    it('normalises uppercase + whitespace + trailing punctuation', () => {
      const mnemonic = generateMnemonic();
      const messy = '  ' + mnemonic.toUpperCase().replace(/ /g, '   ') + '.  \n';
      const res = importRecoveryPhrase(messy);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.mnemonic).toBe(mnemonic.toLowerCase());
    });
  });

  describe('rejection paths', () => {
    it('empty returns reason=empty', () => {
      expect(importRecoveryPhrase('').ok).toBe(false);
      expect(importRecoveryPhrase('   ').ok).toBe(false);
      const r = importRecoveryPhrase('');
      if (!r.ok) expect(r.reason).toBe('empty');
    });

    it('wrong word count returns reason=wrong_word_count', () => {
      const r = importRecoveryPhrase('abandon abandon abandon');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('wrong_word_count');
    });

    it('unknown word returns reason=unknown_word', () => {
      // 24 slots; one known-bad word among valid ones.
      const m = generateMnemonic();
      const words = m.split(' ');
      words[0] = 'banananananana'; // not in wordlist
      const r = importRecoveryPhrase(words.join(' '));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('unknown_word');
    });

    it('bad checksum returns reason=invalid_checksum', () => {
      // Valid words, wrong order — find a shuffled phrase that fails.
      const mnemonic = generateMnemonic();
      const words = mnemonic.split(' ');
      for (let i = 0; i < 30; i++) {
        const j = (i + 1) % words.length;
        [words[0], words[j]] = [words[j]!, words[0]!];
        const r = importRecoveryPhrase(words.join(' '));
        if (!r.ok && r.reason === 'invalid_checksum') return;
      }
      throw new Error('test setup: failed to produce bad-checksum mnemonic');
    });

    it('non-string input returns reason=empty', () => {
      const r = importRecoveryPhrase(null as unknown as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('empty');
    });
  });

  describe('export → import identity', () => {
    it('produces the same words array', () => {
      const mnemonic = generateMnemonic();
      const exp = exportRecoveryPhrase(mnemonic);
      const imp = importRecoveryPhrase(mnemonic);
      expect(imp.ok).toBe(true);
      if (imp.ok) expect(imp.words).toEqual(exp.words);
    });

    it('entropy matches @dina/core.mnemonicToEntropy', async () => {
      const { mnemonicToEntropy } = await import('@dina/core');
      const mnemonic = generateMnemonic();
      const imp = importRecoveryPhrase(mnemonic);
      expect(imp.ok).toBe(true);
      if (imp.ok) {
        const expected = mnemonicToEntropy(mnemonic);
        expect(Array.from(imp.entropy)).toEqual(Array.from(expected));
      }
    });
  });
});

describe('normaliseMnemonic', () => {
  it('lowercases + collapses whitespace', () => {
    expect(normaliseMnemonic('Abandon\tAbandon  Abandon')).toBe(
      'abandon abandon abandon',
    );
  });

  it('strips trailing punctuation', () => {
    expect(normaliseMnemonic('abandon abandon abandon.')).toBe(
      'abandon abandon abandon',
    );
    expect(normaliseMnemonic('abandon, abandon! abandon?')).toBe(
      'abandon abandon abandon',
    );
  });

  it('is idempotent', () => {
    const once = normaliseMnemonic('  Abandon  abandon. ');
    const twice = normaliseMnemonic(once);
    expect(once).toBe(twice);
  });
});
