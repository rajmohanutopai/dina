/**
 * Smoke test — verify extracted JSON fixtures load correctly.
 */

import { loadFixture, hasFixture } from '@dina/test-harness';

describe('Fixture Loading Smoke Test', () => {
  const expectedFixtures = [
    'crypto/bip39_mnemonic_to_seed.json',
    'crypto/hkdf_persona_deks.json',
    'auth/canonical_payload.json',
    'pii/regex_patterns.json',
    'gatekeeper/intent_decisions.json',
    'staging/state_transitions.json',
  ];

  for (const path of expectedFixtures) {
    it(`loads ${path}`, () => {
      expect(hasFixture(path)).toBe(true);
      const fixture = loadFixture(path);
      expect(fixture.domain).toBeDefined();
      expect(fixture.version).toBe(1);
      expect(fixture.vectors.length).toBeGreaterThan(0);
    });
  }

  it('auth canonical has 3 vectors', () => {
    const f = loadFixture('auth/canonical_payload.json');
    expect(f.vectors).toHaveLength(3);
  });

  it('auth canonical vector has expected canonical string format', () => {
    const f = loadFixture('auth/canonical_payload.json');
    const v = f.vectors[0] as { expected: { canonical_string: string; body_hash_hex: string } };
    expect(v.expected.canonical_string).toContain('POST\n/v1/vault/store');
    expect(v.expected.body_hash_hex).toHaveLength(64); // SHA-256 hex
  });

  it('PII has 7 test cases', () => {
    const f = loadFixture('pii/regex_patterns.json');
    expect(f.vectors).toHaveLength(7);
  });

  it('gatekeeper has 20 vectors (15 policies + 5 brain-denied)', () => {
    const f = loadFixture('gatekeeper/intent_decisions.json');
    expect(f.vectors).toHaveLength(20);
  });

  it('staging has 17 transitions (7 valid + 10 invalid)', () => {
    const f = loadFixture('staging/state_transitions.json');
    expect(f.vectors).toHaveLength(17);
  });

  it('HKDF has 11 persona vectors', () => {
    const f = loadFixture('crypto/hkdf_persona_deks.json');
    expect(f.vectors).toHaveLength(11);
  });
});
