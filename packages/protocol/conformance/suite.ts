/**
 * Runnable conformance suite (task 10.14).
 *
 * Reads `conformance/vectors/index.json`, loads every `status: "frozen"`
 * vector, and runs the appropriate verifier against it. Verifiers are
 * registered by vector `name` so new vectors can be added without
 * touching the runner — just add the name → verifier mapping below.
 *
 * Report shape is JSON-serialisable; a CLI wrapper can pipe it through
 * `jq`, a CI step can diff it, a human can read it. Task 10.17 layers
 * a human-readable rendering on top.
 *
 * **What this runs.** Only the pure / zero-private-key cases — verifying
 * frozen signatures against public keys, re-deriving hashes from public
 * inputs, re-assembling canonical strings. L3 vectors that require a
 * fresh signature (e.g. signing a challenge with a private key held by
 * the implementation under test) fall through to an HTTP harness
 * introduced in task 10.16; they're marked `kind: "not-implemented"`
 * here.
 *
 * **How external implementations use this.** This runner is the
 * reference's self-check. External implementations translate this
 * runner's verifier logic into their language, reading the same
 * vectors. When the two agree, they're conformant. See
 * `docs/conformance.md` §3 for conformance levels and §14 for the
 * vector index.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';

import { buildCanonicalPayload } from '../src/canonical_sign';
import { buildMessageJSON, type BuildMessageJSONInput } from '../src/envelope_builder';
import { buildAuthSignedPayload } from '../src/types/auth_frames';

// ─── Report shape ──────────────────────────────────────────────────────────

export interface VectorResult {
  name: string;
  task: string;
  level: 'L1' | 'L2' | 'L3' | 'L4';
  status: 'pass' | 'fail' | 'skipped' | 'not-implemented';
  /** Number of sub-cases that ran (0 when skipped). */
  casesRun: number;
  /** Sub-cases that failed; empty on pass. */
  failures: string[];
  /** Human-readable notes — reason for skip, kind of failure, etc. */
  note?: string;
}

export interface ConformanceReport {
  producedAt: string;
  vectorsDir: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    notImplemented: number;
  };
  results: VectorResult[];
}

// ─── Vector-type helpers ───────────────────────────────────────────────────

interface IndexEntry {
  name: string;
  slot: string;
  level: 'L1' | 'L2' | 'L3' | 'L4';
  task: string;
  status: 'frozen' | 'pending';
}

interface Index {
  version: string;
  updated: string;
  vectors: IndexEntry[];
}

function readJSON<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function importEd25519Pub(hex: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
    format: 'jwk',
  });
}

// ─── Per-vector verifiers ──────────────────────────────────────────────────
//
// Each verifier takes the loaded vector object and returns the sub-case-
// failure list (empty on pass). Throws are caught by the runner and
// rendered as a failure.

type Verifier = (v: unknown) => { cases: number; failures: string[] };

const VERIFIERS: Record<string, Verifier> = {
  canonical_request_string(vector) {
    const v = vector as {
      cases: {
        name: string;
        inputs: {
          method: string; path: string; query: string;
          timestamp: string; nonce: string; body_hash_hex: string;
        };
        expected_canonical_string: string;
      }[];
    };
    const failures: string[] = [];
    for (const c of v.cases) {
      const got = buildCanonicalPayload(
        c.inputs.method, c.inputs.path, c.inputs.query,
        c.inputs.timestamp, c.inputs.nonce, c.inputs.body_hash_hex,
      );
      if (got !== c.expected_canonical_string) failures.push(c.name);
    }
    return { cases: v.cases.length, failures };
  },

  d2d_envelope_round_trip(vector) {
    const v = vector as {
      cases: {
        name: string;
        inputs: BuildMessageJSONInput;
        expected_json_string: string;
      }[];
    };
    const failures: string[] = [];
    for (const c of v.cases) {
      if (buildMessageJSON(c.inputs) !== c.expected_json_string) failures.push(c.name);
    }
    return { cases: v.cases.length, failures };
  },

  sha256_body_hash(vector) {
    const v = vector as {
      cases: { name: string; body_utf8: string; expected_sha256_hex: string }[];
    };
    const failures: string[] = [];
    for (const c of v.cases) {
      const got = createHash('sha256').update(c.body_utf8, 'utf8').digest('hex');
      if (got !== c.expected_sha256_hex) failures.push(c.name);
    }
    return { cases: v.cases.length, failures };
  },

  ed25519_sign_verify(vector) {
    const v = vector as {
      cases: {
        name: string;
        message_utf8: string;
        public_key_hex: string;
        signature_hex: string;
        expected_verify: boolean;
        tamper: { message_utf8: string; expected_verify: boolean };
      }[];
    };
    const failures: string[] = [];
    for (const c of v.cases) {
      const pub = importEd25519Pub(c.public_key_hex);
      const sig = Buffer.from(c.signature_hex, 'hex');
      const okMain = cryptoVerify(null, Buffer.from(c.message_utf8, 'utf8'), pub, sig);
      if (okMain !== c.expected_verify) failures.push(`${c.name}:main`);
      const okTamper = cryptoVerify(null, Buffer.from(c.tamper.message_utf8, 'utf8'), pub, sig);
      if (okTamper !== c.tamper.expected_verify) failures.push(`${c.name}:tamper`);
    }
    return { cases: v.cases.length, failures };
  },

  auth_challenge_response(vector) {
    const v = vector as {
      scenario: { nonce: string; ts: number };
      frames: {
        signed_payload_utf8: string;
        auth_response: { sig: string; pub: string };
      };
      assertions: { signed_payload_byte_count: number };
    };
    const failures: string[] = [];
    // Signed payload shape
    const derived = buildAuthSignedPayload(v.scenario.nonce, v.scenario.ts);
    if (derived !== v.frames.signed_payload_utf8) failures.push('signed-payload-bytes');
    // Byte count
    const byteCount = Buffer.byteLength(derived, 'utf8');
    if (byteCount !== v.assertions.signed_payload_byte_count) failures.push('byte-count');
    // Signature verify
    const pub = importEd25519Pub(v.frames.auth_response.pub);
    const payload = Buffer.from(derived, 'utf8');
    const sig = Buffer.from(v.frames.auth_response.sig, 'hex');
    if (!cryptoVerify(null, payload, pub, sig)) failures.push('signature-verify');
    // Tamper fail: bump ts by one second
    const tampered = buildAuthSignedPayload(v.scenario.nonce, v.scenario.ts + 1);
    if (cryptoVerify(null, Buffer.from(tampered, 'utf8'), pub, sig)) failures.push('tamper-fail');
    return { cases: 1, failures };
  },

  did_key_from_ed25519_pub(vector) {
    const v = vector as {
      cases: {
        name: string;
        public_key_hex: string;
        multicodec_prefix_hex: string;
        expected_did_key: string;
      }[];
    };
    const failures: string[] = [];
    for (const c of v.cases) {
      const pub = hexToBytes(c.public_key_hex);
      const multicodec = hexToBytes(c.multicodec_prefix_hex);
      const payload = new Uint8Array(multicodec.length + pub.length);
      payload.set(multicodec, 0);
      payload.set(pub, multicodec.length);
      const encoded = base58.encode(payload);
      if (`did:key:z${encoded}` !== c.expected_did_key) failures.push(c.name);
    }
    return { cases: v.cases.length, failures };
  },

  blake2b_24_sealed_nonce(vector) {
    const v = vector as {
      cases: {
        name: string;
        ephemeral_pub_hex: string;
        recipient_pub_hex: string;
        expected_nonce_hex: string;
      }[];
    };
    const failures: string[] = [];
    for (const c of v.cases) {
      const input = new Uint8Array(64);
      input.set(hexToBytes(c.ephemeral_pub_hex), 0);
      input.set(hexToBytes(c.recipient_pub_hex), 32);
      const got = bytesToHex(blake2b(input, { dkLen: 24 }));
      if (got !== c.expected_nonce_hex) failures.push(c.name);
    }
    return { cases: v.cases.length, failures };
  },

  plc_document_verification(vector) {
    const v = vector as {
      document: {
        '@context': string[];
        id: string;
        verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
        authentication: string[];
        service: { id: string; type: string; serviceEndpoint: string }[];
      };
      assertions: {
        context_must_include: string[];
        verification_method_fragment: string;
        messaging_service_fragment: string;
        allowed_service_types: string[];
        id_format_regex: string;
      };
    };
    const failures: string[] = [];
    const d = v.document;
    const a = v.assertions;
    for (const ctx of a.context_must_include) {
      if (!d['@context'].includes(ctx)) failures.push(`context-missing:${ctx}`);
    }
    if (!d.id.match(new RegExp(a.id_format_regex))) failures.push('id-format');
    const vm = d.verificationMethod[0];
    if (!vm || !vm.id.endsWith(a.verification_method_fragment)) failures.push('vm-fragment');
    if (vm && vm.type !== 'Multikey') failures.push('vm-type');
    if (vm && vm.controller !== d.id) failures.push('vm-controller');
    if (vm && !vm.publicKeyMultibase.startsWith('z')) failures.push('vm-multibase-prefix');
    const vmIds = new Set(d.verificationMethod.map((m) => m.id));
    for (const ref of d.authentication) {
      if (!vmIds.has(ref)) failures.push(`authentication-ref-missing:${ref}`);
    }
    const svc = d.service[0];
    if (!svc || !svc.id.endsWith(a.messaging_service_fragment)) failures.push('svc-fragment');
    if (svc && !a.allowed_service_types.includes(svc.type)) failures.push('svc-type');
    return { cases: 1, failures };
  },

  nacl_sealed_box(vector) {
    const v = vector as {
      recipient: { public_key_hex: string; private_key_hex: string };
      cases: {
        name: string;
        expected_plaintext_utf8: string;
        ciphertext_hex: string;
        ciphertext_byte_count: number;
      }[];
    };
    // Lazy require — libsodium-wrappers is a devDep; importing it at the
    // top of the module would force every consumer of runConformance to
    // load ~1 MB of wasm even when they're not running this vector.
    //
    // Contract: the caller MUST `await sodium.ready` before invoking
    // runConformance when the nacl_sealed_box vector is live. The Jest
    // harness does this in `beforeAll`. If you're calling the runner
    // from a CLI wrapper, await sodium.ready up front too.
    //
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

    const failures: string[] = [];
    const pub = sodium.from_hex(v.recipient.public_key_hex);
    const priv = sodium.from_hex(v.recipient.private_key_hex);

    for (const c of v.cases) {
      const ct = sodium.from_hex(c.ciphertext_hex);
      if (ct.length !== c.ciphertext_byte_count) {
        failures.push(`${c.name}:length-mismatch`);
        continue;
      }
      try {
        const ptBytes = sodium.crypto_box_seal_open(ct, pub, priv);
        const pt = sodium.to_string(ptBytes);
        if (pt !== c.expected_plaintext_utf8) failures.push(`${c.name}:plaintext-mismatch`);
      } catch {
        failures.push(`${c.name}:decrypt-threw`);
      }

      // Tamper check — flipping one byte must cause decrypt to throw.
      if (ct.length > 0) {
        const tampered = new Uint8Array(ct);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
        try {
          sodium.crypto_box_seal_open(tampered, pub, priv);
          failures.push(`${c.name}:tamper-did-not-fail`);
        } catch {
          // expected
        }
      }
    }
    return { cases: v.cases.length, failures };
  },
};

// ─── Runner ────────────────────────────────────────────────────────────────

export function runConformance(vectorsDir: string): ConformanceReport {
  const index = readJSON<Index>(join(vectorsDir, 'index.json'));
  const results: VectorResult[] = [];

  for (const entry of index.vectors) {
    if (entry.status !== 'frozen') {
      results.push({
        name: entry.name,
        task: entry.task,
        level: entry.level,
        status: 'skipped',
        casesRun: 0,
        failures: [],
        note: `vector status is "${entry.status}" — see index.json`,
      });
      continue;
    }
    const verifier = VERIFIERS[entry.name];
    if (!verifier) {
      results.push({
        name: entry.name,
        task: entry.task,
        level: entry.level,
        status: 'not-implemented',
        casesRun: 0,
        failures: [],
        note: 'no verifier registered — suite needs a crypto primitive that isn\'t wired in yet',
      });
      continue;
    }
    try {
      const vector = readJSON<unknown>(join(vectorsDir, entry.slot));
      const { cases, failures } = verifier(vector);
      if (cases === 0 && failures.length === 0) {
        results.push({
          name: entry.name,
          task: entry.task,
          level: entry.level,
          status: 'not-implemented',
          casesRun: 0,
          failures: [],
          note: 'verifier registered but declined to run (no backend)',
        });
      } else {
        results.push({
          name: entry.name,
          task: entry.task,
          level: entry.level,
          status: failures.length === 0 ? 'pass' : 'fail',
          casesRun: cases,
          failures,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: entry.name,
        task: entry.task,
        level: entry.level,
        status: 'fail',
        casesRun: 0,
        failures: ['threw'],
        note: msg,
      });
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    notImplemented: results.filter((r) => r.status === 'not-implemented').length,
  };

  return {
    producedAt: new Date().toISOString(),
    vectorsDir,
    summary,
    results,
  };
}

/**
 * Render a conformance report as a human-readable string.
 * Used by the CLI wrapper; the machine-readable form is the JSON
 * returned by `runConformance`.
 */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`@dina/protocol conformance report — ${report.producedAt}`);
  lines.push('');
  lines.push(`vectors dir: ${report.vectorsDir}`);
  lines.push(`total:          ${report.summary.total}`);
  lines.push(`passed:         ${report.summary.passed}`);
  lines.push(`failed:         ${report.summary.failed}`);
  lines.push(`skipped:        ${report.summary.skipped}`);
  lines.push(`not-implemented:${report.summary.notImplemented}`);
  lines.push('');
  lines.push('per-vector results:');
  for (const r of report.results) {
    const marker = {
      pass: 'PASS',
      fail: 'FAIL',
      skipped: 'SKIP',
      'not-implemented': 'N/I ',
    }[r.status];
    const cases = r.casesRun > 0 ? ` (${r.casesRun} cases)` : '';
    const note = r.note ? ` — ${r.note}` : '';
    lines.push(`  ${marker}  [${r.level}] ${r.task} ${r.name}${cases}${note}`);
    if (r.failures.length > 0) {
      for (const f of r.failures) lines.push(`        × ${f}`);
    }
  }
  return lines.join('\n');
}
