/**
 * T0.6 — Cross-language test vector validator.
 *
 * Validates that fixture JSON files can be loaded, parsed, and used
 * to verify crypto implementations.
 *
 * Source: ARCHITECTURE.md Task 0.6
 */

import * as path from 'path';
import {
  loadFixtures,
  loadFixture,
  validateVector,
  validateFixture,
  summarizeResults,
  type TestVector,
  type VectorFile,
} from '../../src/testing/vector_validator';
import { getPublicKey, sign, verify } from '../../src/crypto/ed25519';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures/crypto');

describe('Cross-Language Test Vector Validator (0.6)', () => {
  describe('loadFixtures', () => {
    it('loads all fixture files from directory', () => {
      const fixtures = loadFixtures(FIXTURES_DIR);
      expect(fixtures.length).toBeGreaterThanOrEqual(8);

      for (const f of fixtures) {
        expect(f.domain).toBeTruthy();
        expect(f.version).toBeGreaterThanOrEqual(1);
        expect(f.vectors.length).toBeGreaterThan(0);
      }
    });

    it('each fixture has valid structure', () => {
      const fixtures = loadFixtures(FIXTURES_DIR);

      for (const f of fixtures) {
        for (const v of f.vectors) {
          expect(v.description).toBeTruthy();
          expect(v.inputs).toBeDefined();
          expect(v.expected).toBeDefined();
        }
      }
    });
  });

  describe('loadFixture', () => {
    it('loads a specific fixture by name', () => {
      const fixture = loadFixture(FIXTURES_DIR, 'ed25519_sign_verify.json');
      expect(fixture.domain).toBe('crypto/ed25519');
      expect(fixture.vectors.length).toBeGreaterThan(0);
    });

    it('throws for missing fixture', () => {
      expect(() => loadFixture(FIXTURES_DIR, 'nonexistent.json')).toThrow('not found');
    });
  });

  describe('validateVector — Ed25519', () => {
    it('validates keypair generation against Go fixture', () => {
      const vector: TestVector = {
        description: 'Generate keypair from seed',
        inputs: {
          seed_hex: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        },
        expected: {
          public_key_hex: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        },
      };

      const result = validateVector(vector, (inputs) => {
        const seed = hexToBytes(inputs.seed_hex);
        const pubKey = getPublicKey(seed);
        return { public_key_hex: bytesToHex(pubKey) };
      });

      expect(result.passed).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects mismatched output', () => {
      const vector: TestVector = {
        description: 'Wrong output test',
        inputs: { seed_hex: '0000000000000000000000000000000000000000000000000000000000000000' },
        expected: {
          public_key_hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      };

      const result = validateVector(vector, (inputs) => {
        const seed = hexToBytes(inputs.seed_hex);
        return { public_key_hex: bytesToHex(getPublicKey(seed)) };
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('public_key_hex');
    });

    it('handles implementation errors gracefully', () => {
      const vector: TestVector = {
        description: 'Error test',
        inputs: { bad_field: 'x' },
        expected: { output: 'anything' },
      };

      const result = validateVector(vector, () => {
        throw new Error('not implemented');
      });

      expect(result.passed).toBe(false);
      expect(result.errors[0].field).toBe('(exception)');
    });
  });

  describe('validateFixture — Ed25519 keypair + sign vectors', () => {
    it('validates keypair and sign vectors from Go fixtures', () => {
      const fixture = loadFixture(FIXTURES_DIR, 'ed25519_sign_verify.json');

      // Filter to vectors we can fully compute (keypair + sign)
      const computableVectors = fixture.vectors.filter(
        (v) =>
          (v.inputs.seed_hex && !v.inputs.message_hex) ||
          (v.inputs.message_hex && v.inputs.private_key_hex && !v.inputs.signature_hex),
      );

      expect(computableVectors.length).toBeGreaterThan(0);

      const subFixture: VectorFile = { ...fixture, vectors: computableVectors };
      const result = validateFixture(subFixture, (inputs) => {
        const outputs: Record<string, string> = {};

        if (inputs.seed_hex && !inputs.message_hex) {
          const seed = hexToBytes(inputs.seed_hex);
          const pubKey = getPublicKey(seed);
          outputs.public_key_hex = bytesToHex(pubKey);
          outputs.private_key_hex = inputs.seed_hex;
        } else if (inputs.message_hex && inputs.private_key_hex) {
          const seed = hexToBytes(inputs.private_key_hex);
          const msg = hexToBytes(inputs.message_hex);
          const sig = sign(seed, msg);
          outputs.signature_hex = bytesToHex(sig);
          outputs.signature_length = String(sig.length);
        }

        return outputs;
      });

      expect(result.domain).toBe('crypto/ed25519');
      expect(result.passed).toBeGreaterThan(0);
      expect(result.failed).toBe(0);
    });

    it('validates verify vectors from Go fixtures', () => {
      const fixture = loadFixture(FIXTURES_DIR, 'ed25519_sign_verify.json');

      const verifyVectors = fixture.vectors.filter(
        (v) => v.inputs.message_hex && v.inputs.signature_hex && v.inputs.public_key_hex,
      );

      for (const v of verifyVectors) {
        const pubKey = hexToBytes(v.inputs.public_key_hex);
        const msg = hexToBytes(v.inputs.message_hex);
        const sig = hexToBytes(v.inputs.signature_hex);
        const valid = verify(pubKey, msg, sig);
        const expectedValid = String(v.expected.valid).toLowerCase() === 'true';
        expect(valid).toBe(expectedValid);
      }
    });
  });

  describe('summarizeResults', () => {
    it('summarizes multiple validation results', () => {
      const results = [
        { domain: 'a', total: 5, passed: 5, failed: 0, errors: [] },
        {
          domain: 'b',
          total: 3,
          passed: 2,
          failed: 1,
          errors: [{ description: 'x', field: 'y', expected: '1', actual: '2' }],
        },
      ];

      const summary = summarizeResults(results);
      expect(summary.totalDomains).toBe(2);
      expect(summary.totalVectors).toBe(8);
      expect(summary.totalPassed).toBe(7);
      expect(summary.totalFailed).toBe(1);
      expect(summary.allPassed).toBe(false);
    });

    it('reports allPassed when everything passes', () => {
      const results = [{ domain: 'a', total: 5, passed: 5, failed: 0, errors: [] }];

      expect(summarizeResults(results).allPassed).toBe(true);
    });
  });
});
