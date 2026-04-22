/**
 * Exercises the programmatic conformance runner (task 10.14).
 *
 * Separate from `conformance_vectors.test.ts` — that file runs each
 * vector's verifier directly as a Jest case. This file runs them all
 * through `runConformance` + asserts the report shape + pass/fail
 * counts.
 *
 * The Jest path is the regression gate that fails CI; the runner path
 * is what external implementations will invoke programmatically.
 */

import * as path from 'node:path';

import sodium from 'libsodium-wrappers';

import {
  formatReport,
  runConformance,
  type ConformanceReport,
} from '../conformance/suite';

const VECTORS_DIR = path.resolve(__dirname, '..', 'conformance', 'vectors');

describe('runConformance — end-to-end runner (task 10.14)', () => {
  let report: ConformanceReport;
  beforeAll(async () => {
    await sodium.ready; // contract: nacl_sealed_box verifier needs this
    report = runConformance(VECTORS_DIR);
  });

  it('produces a JSON-serialisable report', () => {
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('report includes the vectors dir + timestamp', () => {
    expect(report.vectorsDir).toBe(VECTORS_DIR);
    expect(report.producedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('summary counts add up to total', () => {
    const { summary } = report;
    expect(
      summary.passed + summary.failed + summary.skipped + summary.notImplemented,
    ).toBe(summary.total);
  });

  it('every frozen L1/L2/L3 vector with a verifier ends up pass or fail (not skip)', () => {
    const frozenNames = [
      'canonical_request_string',
      'd2d_envelope_round_trip',
      'sha256_body_hash',
      'ed25519_sign_verify',
      'auth_challenge_response',
      'did_key_from_ed25519_pub',
      'blake2b_24_sealed_nonce',
      'plc_document_verification',
      'nacl_sealed_box',
    ];
    for (const name of frozenNames) {
      const r = report.results.find((x) => x.name === name);
      expect(r).toBeDefined();
      expect(['pass', 'fail']).toContain(r!.status);
    }
  });

  it('all 9 frozen vectors pass cleanly', () => {
    const failures = report.results.filter((r) => r.status === 'fail');
    expect(failures).toEqual([]);
    expect(report.summary.failed).toBe(0);
  });

  it('nacl_sealed_box decrypts the frozen ciphertexts', () => {
    const r = report.results.find((x) => x.name === 'nacl_sealed_box');
    expect(r).toBeDefined();
    expect(r!.status).toBe('pass');
    expect(r!.casesRun).toBeGreaterThan(0);
  });

  it('pass count equals the number of frozen-verifiable vectors', () => {
    // All 9 vectors are wired to verifiers — nacl_sealed_box landed in task 10.10.
    expect(report.summary.passed).toBe(9);
  });

  it('every result has a task id in N.NN form', () => {
    for (const r of report.results) {
      expect(r.task).toMatch(/^\d+\.\d+$/);
    }
  });

  it('every L3 vector that ran succeeded (signatures verified)', () => {
    const l3Ran = report.results.filter(
      (r) => r.level === 'L3' && (r.status === 'pass' || r.status === 'fail'),
    );
    expect(l3Ran.length).toBeGreaterThan(0);
    for (const r of l3Ran) {
      expect(r.status).toBe('pass');
    }
  });

  it('formatReport emits a readable string with every vector line', () => {
    const text = formatReport(report);
    expect(text).toContain('@dina/protocol conformance report');
    expect(text).toContain(`total:          ${report.summary.total}`);
    for (const r of report.results) {
      expect(text).toContain(r.name);
    }
  });

  it('formatReport shows PASS markers for every vector', () => {
    const text = formatReport(report);
    expect(text).toContain('PASS ');
    // With all 9 frozen + passing, no SKIP expected in steady state.
    // The marker invariant: every result line starts with one of the 4
    // known markers.
    const resultLines = text.split('\n').filter((l) => l.startsWith('  '));
    for (const l of resultLines) {
      expect(/^(?:  PASS|  FAIL|  SKIP|  N\/I) /.test(l)).toBe(true);
    }
  });
});

describe('runConformance — robustness', () => {
  it('throws a clear error when vectorsDir does not exist', () => {
    expect(() => runConformance('/definitely/does/not/exist')).toThrow();
  });
});
