/**
 * Fixture loader — loads JSON test vector files extracted from Go/Python
 * test suites.
 *
 * Design decisions:
 * - Loads synchronously at module init (fixtures are small, <1MB total).
 * - Validates fixture schema on load (fail-fast if fixture format wrong).
 * - Provides typed accessors per fixture domain.
 * - Caches parsed fixtures (loaded once per test run).
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types for fixture file structure
// ---------------------------------------------------------------------------

export interface FixtureVector<TInput, TExpected> {
  description: string;
  source_test: string;
  inputs: TInput;
  expected: TExpected;
}

export interface FixtureFile<TInput, TExpected> {
  domain: string;
  version: number;
  generated_from: string;
  generated_at: string;
  vectors: Array<FixtureVector<TInput, TExpected>>;
}

// ---------------------------------------------------------------------------
// Fixture directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve fixtures directory robustly — works whether consumed as source
 * (packages/test-harness/src/fixtures/) or compiled (packages/test-harness/dist/fixtures/).
 * Walks up from __dirname looking for a sibling `fixtures` directory with a README.
 */
function resolveFixturesDir(): string {
  // Explicit env override for CI or non-standard layouts
  if (process.env.DINA_FIXTURES_DIR) {
    return process.env.DINA_FIXTURES_DIR;
  }
  // Walk up from this file to find packages/fixtures/
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'fixtures');
    if (
      fs.existsSync(path.join(candidate, 'crypto')) ||
      fs.existsSync(path.join(candidate, 'auth'))
    ) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
  // Fallback to the expected monorepo location
  return path.resolve(__dirname, '..', '..', '..', 'fixtures');
}

const FIXTURES_DIR = resolveFixturesDir();

function fixtureExists(relativePath: string): boolean {
  return fs.existsSync(path.join(FIXTURES_DIR, relativePath));
}

// ---------------------------------------------------------------------------
// Generic loader with validation
// ---------------------------------------------------------------------------

/**
 * Fixture cache. Keyed by relative path.
 *
 * TYPE SAFETY NOTE: Generic types on loadFixture<T, U> are erased at runtime.
 * The cache stores `unknown` and casts on retrieval. If two callers load the
 * same fixture with different generic types, the second gets the first's data
 * cast to the wrong type. This is safe in practice because each fixture file
 * has a single schema, but callers must ensure they use consistent types for
 * the same path.
 */
const cache = new Map<string, unknown>();

export function loadFixture<TInput, TExpected>(
  relativePath: string,
): FixtureFile<TInput, TExpected> {
  const cached = cache.get(relativePath);
  if (cached) return cached as FixtureFile<TInput, TExpected>;

  const fullPath = path.join(FIXTURES_DIR, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Fixture file not found: ${fullPath}\n` +
        `Run fixture extraction (Phase F0) before running tests.\n` +
        `See TESTCASE_TASKS.md for extraction instructions.`,
    );
  }

  const raw = fs.readFileSync(fullPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Fixture file is not valid JSON: ${fullPath}`);
  }

  const fixture = parsed as FixtureFile<TInput, TExpected>;

  // Structural validation
  if (!fixture.domain || typeof fixture.domain !== 'string') {
    throw new Error(`Fixture missing 'domain' field: ${fullPath}`);
  }
  if (!fixture.version || typeof fixture.version !== 'number') {
    throw new Error(`Fixture missing 'version' field: ${fullPath}`);
  }
  if (!Array.isArray(fixture.vectors)) {
    throw new Error(`Fixture missing 'vectors' array: ${fullPath}`);
  }
  if (fixture.vectors.length === 0) {
    throw new Error(`Fixture has zero vectors (empty test data): ${fullPath}`);
  }

  cache.set(relativePath, fixture);
  return fixture;
}

/**
 * Load fixture vectors only (skip metadata).
 * Convenience for test loops: `for (const v of loadVectors(...)) { ... }`
 */
export function loadVectors<TInput, TExpected>(
  relativePath: string,
): Array<FixtureVector<TInput, TExpected>> {
  return loadFixture<TInput, TExpected>(relativePath).vectors;
}

/**
 * Check if a fixture file exists without throwing.
 * Use in conditional `describe` blocks to skip tests when fixtures
 * haven't been extracted yet.
 */
export function hasFixture(relativePath: string): boolean {
  return fixtureExists(relativePath);
}

/**
 * Whether fixture loading is in strict mode.
 *
 * - `false` (default during bootstrap): missing fixtures → skip tests.
 * - `true` (set in CI after Phase F0): missing fixtures → fail tests.
 *
 * Set via: `process.env.DINA_FIXTURES_STRICT = '1'`
 *
 * This prevents the silent-skip problem: once fixtures are committed,
 * a missing fixture is a bug (accidental deletion, path change), not
 * "hasn't been extracted yet."
 */
function isStrictMode(): boolean {
  return process.env.DINA_FIXTURES_STRICT === '1';
}

/**
 * Returns a Jest-compatible `describe` or `describe.skip` based on fixture
 * availability. In strict mode (DINA_FIXTURES_STRICT=1), always returns
 * `describe` — if the fixture is missing, the test will fail loudly at load
 * time rather than being silently skipped.
 *
 * Usage:
 *   const suite = describeWithFixture('crypto/slip0010.json');
 *   suite('SLIP-0010 derivation', () => { ... });
 */
export function describeWithFixture(relativePath: string): typeof describe {
  if (fixtureExists(relativePath)) {
    return describe;
  }
  if (isStrictMode()) {
    // In strict mode, do NOT skip — return describe so the test runs,
    // and loadVectors() will throw a clear error when it tries to load.
    return describe;
  }
  return describe.skip;
}

/**
 * Assert fixture exists. Always throws if missing (use in beforeAll).
 * Use when the fixture SHOULD exist and missing = bug.
 */
export function assertFixtureExists(relativePath: string): void {
  if (!fixtureExists(relativePath)) {
    throw new Error(
      `Fixture file missing: ${relativePath}. ` +
        `Run Phase F0 fixture extraction. See TESTCASE_TASKS.md.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Typed fixture accessors (one per domain)
// ---------------------------------------------------------------------------

// These provide strong typing for each fixture domain's input/expected shapes.
// They are thin wrappers around loadVectors with domain-specific types.

export interface CryptoDerivationInput {
  seed_hex: string;
  path: string;
}

export interface CryptoDerivationExpected {
  private_key_hex: string;
  public_key_hex: string;
  chain_code_hex?: string;
}

export interface HKDFInput {
  seed_hex: string;
  persona_name: string;
  info_string: string;
  salt_hex: string;
}

export interface HKDFExpected {
  dek_hex: string;
}

export interface Argon2idInput {
  passphrase: string;
  salt_hex: string;
}

export interface Argon2idExpected {
  kek_hex: string;
}

export interface AESGCMInput {
  kek_hex: string;
  plaintext_hex: string;
}

export interface AESGCMExpected {
  wrapped_hex: string; // nonce + ciphertext + tag
}

export interface Ed25519SignInput {
  private_key_hex: string;
  message_hex: string;
}

export interface Ed25519SignExpected {
  signature_hex: string;
  public_key_hex: string;
}

export interface CanonicalPayloadInput {
  method: string;
  path: string;
  query: string;
  timestamp: string; // RFC3339
  nonce: string; // hex
  body: string; // raw body text
}

export interface CanonicalPayloadExpected {
  canonical_string: string;
  body_hash_hex: string;
}

export interface PIIPatternInput {
  text: string;
}

export interface PIIPatternExpected {
  scrubbed: string;
  entities: Array<{ type: string; value: string; start: number; end: number }>;
}

export interface GatekeeperIntentInput {
  action: string;
  agent_did?: string;
  trust_level?: string;
}

export interface GatekeeperIntentExpected {
  allowed: boolean;
  risk_level: string;
  requires_approval: boolean;
}

export interface StagingTransitionInput {
  initial_status: string;
  action: string;
  persona_open: boolean;
}

export interface StagingTransitionExpected {
  final_status: string;
  error?: string;
}

export interface AuditChainInput {
  entries: Array<{
    actor: string;
    action: string;
    resource: string;
    detail: string;
  }>;
}

export interface AuditChainExpected {
  hashes: string[]; // entry_hash for each entry in order
  chain_valid: boolean;
}
