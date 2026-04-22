/**
 * Cross-language test vector validator.
 *
 * Loads JSON fixture files generated from Go/Python test suites and
 * verifies that our TypeScript crypto implementations produce identical
 * outputs. This is the critical cross-language correctness gate.
 *
 * Supported domains:
 *   - crypto/ed25519: keypair, sign, verify
 *   - crypto/hkdf: persona DEK derivation
 *   - crypto/slip0010: root signing key, persona keys, rotation keys
 *   - crypto/aesgcm: wrap/unwrap seed
 *   - crypto/argon2id: KEK derivation
 *   - crypto/nacl: seal/unseal
 *   - crypto/bip39: mnemonic to seed
 *   - crypto/x25519: Ed25519 → X25519 key conversion
 *
 * Source: ARCHITECTURE.md Task 0.6
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TestVector {
  description: string;
  source_test?: string;
  inputs: Record<string, string>;
  expected: Record<string, string>;
}

export interface VectorFile {
  domain: string;
  version: number;
  generated_from?: string;
  generated_at?: string;
  vectors: TestVector[];
}

export interface ValidationResult {
  domain: string;
  total: number;
  passed: number;
  failed: number;
  errors: Array<{
    description: string;
    field: string;
    expected: string;
    actual: string;
  }>;
}

/**
 * Load all fixture files from the fixtures/crypto directory.
 */
export function loadFixtures(fixturesDir: string): VectorFile[] {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

  return files.map((f) => {
    const content = fs.readFileSync(path.join(fixturesDir, f), 'utf-8');
    return JSON.parse(content) as VectorFile;
  });
}

/**
 * Load a specific fixture file by name.
 */
export function loadFixture(fixturesDir: string, name: string): VectorFile {
  const filePath = path.join(fixturesDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as VectorFile;
}

/**
 * Validate a single test vector against an implementation function.
 *
 * The validator calls `implementationFn(inputs)` and compares the result
 * against the expected outputs.
 */
export function validateVector(
  vector: TestVector,
  implementationFn: (inputs: Record<string, string>) => Record<string, string>,
): { passed: boolean; errors: Array<{ field: string; expected: string; actual: string }> } {
  const errors: Array<{ field: string; expected: string; actual: string }> = [];

  try {
    const actual = implementationFn(vector.inputs);

    for (const [field, expected] of Object.entries(vector.expected)) {
      const actualValue = actual[field];
      if (actualValue === undefined) {
        errors.push({ field, expected, actual: '(missing)' });
      } else if (actualValue.toLowerCase() !== expected.toLowerCase()) {
        errors.push({ field, expected, actual: actualValue });
      }
    }
  } catch (err) {
    errors.push({
      field: '(exception)',
      expected: 'no error',
      actual: err instanceof Error ? err.message : String(err),
    });
  }

  return { passed: errors.length === 0, errors };
}

/**
 * Validate all vectors in a file against an implementation.
 */
export function validateFixture(
  fixture: VectorFile,
  implementationFn: (inputs: Record<string, string>) => Record<string, string>,
): ValidationResult {
  const result: ValidationResult = {
    domain: fixture.domain,
    total: fixture.vectors.length,
    passed: 0,
    failed: 0,
    errors: [],
  };

  for (const vector of fixture.vectors) {
    const { passed, errors } = validateVector(vector, implementationFn);
    if (passed) {
      result.passed++;
    } else {
      result.failed++;
      for (const err of errors) {
        result.errors.push({ description: vector.description, ...err });
      }
    }
  }

  return result;
}

/**
 * Summary of all validation results.
 */
export function summarizeResults(results: ValidationResult[]): {
  totalDomains: number;
  totalVectors: number;
  totalPassed: number;
  totalFailed: number;
  allPassed: boolean;
} {
  let totalVectors = 0;
  let totalPassed = 0;
  let totalFailed = 0;

  for (const r of results) {
    totalVectors += r.total;
    totalPassed += r.passed;
    totalFailed += r.failed;
  }

  return {
    totalDomains: results.length,
    totalVectors,
    totalPassed,
    totalFailed,
    allPassed: totalFailed === 0,
  };
}
