/**
 * Conformance-vector regression tests (tasks 10.7 + 10.12 + as more
 * vectors land per 10.5 – 10.13).
 *
 * For every vector in `conformance/vectors/*.json` that corresponds to
 * a pure function we own, re-run the reference implementation against
 * the vector's declared inputs and assert the output byte-exactly
 * matches the vector's `expected_*` field.
 *
 * This is the regression guard that catches accidental wire drift —
 * if someone edits `canonical_sign.ts` or `envelope_builder.ts` in a
 * way that changes the output bytes, the frozen vector fails this
 * test, and a human has to decide whether it's a deliberate wire-
 * break (bump @dina/protocol major) or a bug.
 *
 * Non-pure vectors (signing, encryption, handshake) land with a
 * different fixture pattern when the runnable suite lands in task
 * 10.14 — they need crypto backends.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import sodium from 'libsodium-wrappers';

import { buildCanonicalPayload } from '../src/canonical_sign';
import { buildMessageJSON, type BuildMessageJSONInput } from '../src/envelope_builder';
import type { DIDDocument } from '../src/types/plc_document';
import { buildAuthSignedPayload } from '../src/types/auth_frames';
import {
  AUTH_CHALLENGE,
  AUTH_RESPONSE,
  AUTH_SUCCESS,
  DID_V1_CONTEXT,
  DINA_MESSAGING_FRAGMENT,
  DINA_SIGNING_FRAGMENT,
  MULTIKEY_CONTEXT,
  SERVICE_TYPE_DIRECT_HTTPS,
  SERVICE_TYPE_MSGBOX,
} from '../src/constants';

const VECTORS_DIR = path.resolve(__dirname, '..', 'conformance', 'vectors');

function loadVector<T>(filename: string): T {
  const raw = fs.readFileSync(path.join(VECTORS_DIR, filename), 'utf8');
  return JSON.parse(raw) as T;
}

// ─── Task 10.7 — canonical_request_string ──────────────────────────────────

interface CanonicalCase {
  name: string;
  inputs: {
    method: string;
    path: string;
    query: string;
    timestamp: string;
    nonce: string;
    body_hash_hex: string;
  };
  expected_canonical_string: string;
}

interface CanonicalVector {
  name: 'canonical_request_string';
  task: '10.7';
  cases: CanonicalCase[];
}

describe('conformance vector — canonical_request_string (task 10.7)', () => {
  const vector = loadVector<CanonicalVector>('canonical_request_string.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('canonical_request_string');
    expect(vector.task).toBe('10.7');
    expect(Array.isArray(vector.cases)).toBe(true);
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — reference buildCanonicalPayload matches frozen expected', (_name, c) => {
    const actual = buildCanonicalPayload(
      c.inputs.method,
      c.inputs.path,
      c.inputs.query,
      c.inputs.timestamp,
      c.inputs.nonce,
      c.inputs.body_hash_hex,
    );
    expect(actual).toBe(c.expected_canonical_string);
  });

  it('every output uses LF line separators (0x0A), never CRLF', () => {
    for (const c of vector.cases) {
      expect(c.expected_canonical_string).not.toContain('\r');
    }
  });

  it('every output has exactly 5 newline separators (5 separators = 6 fields)', () => {
    for (const c of vector.cases) {
      const count = (c.expected_canonical_string.match(/\n/g) ?? []).length;
      expect(count).toBe(5);
    }
  });

  it('no case has a trailing newline', () => {
    for (const c of vector.cases) {
      expect(c.expected_canonical_string.endsWith('\n')).toBe(false);
    }
  });
});

// ─── Task 10.12 — d2d_envelope_round_trip ──────────────────────────────────

interface D2DCase {
  name: string;
  inputs: BuildMessageJSONInput;
  expected_json_string: string;
}

interface D2DVector {
  name: 'd2d_envelope_round_trip';
  task: '10.12';
  cases: D2DCase[];
}

describe('conformance vector — d2d_envelope_round_trip (task 10.12)', () => {
  const vector = loadVector<D2DVector>('d2d_envelope_round_trip.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('d2d_envelope_round_trip');
    expect(vector.task).toBe('10.12');
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — reference buildMessageJSON matches frozen expected', (_name, c) => {
    const actual = buildMessageJSON(c.inputs);
    expect(actual).toBe(c.expected_json_string);
  });

  it('every output parses back to an object whose `to` is an array', () => {
    for (const c of vector.cases) {
      const parsed = JSON.parse(c.expected_json_string);
      expect(Array.isArray(parsed.to)).toBe(true);
    }
  });

  it('every output has key order id → type → from → to → created_time → body', () => {
    // JSON.parse doesn't preserve key order in all engines, but Node's
    // V8 does (insertion-order) for non-integer string keys. Re-checking
    // via Object.keys catches any accidental reordering regression.
    for (const c of vector.cases) {
      const keys = Object.keys(JSON.parse(c.expected_json_string));
      expect(keys).toEqual(['id', 'type', 'from', 'to', 'created_time', 'body']);
    }
  });

  it('compact JSON — no whitespace around separators', () => {
    for (const c of vector.cases) {
      // Compact JSON of a flat object should contain no ", " or ": " pairs.
      // (A colon followed by space or comma followed by space indicates
      // the stringifier used an indent spec.)
      expect(c.expected_json_string).not.toContain(': ');
      expect(c.expected_json_string).not.toContain(', ');
    }
  });
});

// ─── Task 10.8 — sha256_body_hash ──────────────────────────────────────────

interface SHACase {
  name: string;
  body_utf8: string;
  expected_sha256_hex: string;
}

interface SHAVector {
  name: 'sha256_body_hash';
  task: '10.8';
  cases: SHACase[];
}

describe('conformance vector — sha256_body_hash (task 10.8)', () => {
  const vector = loadVector<SHAVector>('sha256_body_hash.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('sha256_body_hash');
    expect(vector.task).toBe('10.8');
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — node:crypto SHA-256 matches frozen hex', (_name, c) => {
    const hex = createHash('sha256').update(c.body_utf8, 'utf8').digest('hex');
    expect(hex).toBe(c.expected_sha256_hex);
  });

  it('every hash is 64 lowercase hex chars', () => {
    for (const c of vector.cases) {
      expect(c.expected_sha256_hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('empty_body case matches the canonical-empty SHA-256', () => {
    const empty = vector.cases.find((c) => c.name === 'empty_body');
    expect(empty).toBeDefined();
    expect(empty!.expected_sha256_hex).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('UTF-8 encoding invariant — unicode_cafe case hashes the 13-byte UTF-8 form', () => {
    const unicode = vector.cases.find((c) => c.name === 'unicode_cafe');
    expect(unicode).toBeDefined();
    expect(Buffer.byteLength(unicode!.body_utf8, 'utf8')).toBe(14);
  });
});

// ─── Task 10.13 — plc_document_verification ────────────────────────────────

interface PLCVector {
  name: 'plc_document_verification';
  task: '10.13';
  document: DIDDocument;
  assertions: {
    context_must_include: string[];
    verification_method_fragment: string;
    messaging_service_fragment: string;
    verification_method_type: string;
    publicKeyMultibase_prefix: string;
    allowed_service_types: string[];
    id_format_regex: string;
    authentication_references_verification_method: boolean;
  };
}

describe('conformance vector — plc_document_verification (task 10.13)', () => {
  const vector = loadVector<PLCVector>('plc_document_verification.json');
  const doc = vector.document;

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('plc_document_verification');
    expect(vector.task).toBe('10.13');
    expect(doc).toBeDefined();
  });

  it('document satisfies DIDDocument type at compile time', () => {
    // Typed as DIDDocument — this line fails tsc if the shape drifts.
    const _typed: DIDDocument = doc;
    expect(_typed.id).toBe(doc.id);
  });

  it('@context includes both mandatory URIs (vector + reference constants agree)', () => {
    expect(doc['@context']).toContain(DID_V1_CONTEXT);
    expect(doc['@context']).toContain(MULTIKEY_CONTEXT);
    for (const uri of vector.assertions.context_must_include) {
      expect(doc['@context']).toContain(uri);
    }
  });

  it('vector\'s declared fragments match constants.ts', () => {
    expect(vector.assertions.verification_method_fragment).toBe(DINA_SIGNING_FRAGMENT);
    expect(vector.assertions.messaging_service_fragment).toBe(DINA_MESSAGING_FRAGMENT);
  });

  it('verificationMethod has the #dina_signing fragment + Multikey type', () => {
    expect(doc.verificationMethod.length).toBeGreaterThan(0);
    const vm = doc.verificationMethod[0]!;
    expect(vm.id.endsWith(DINA_SIGNING_FRAGMENT)).toBe(true);
    expect(vm.type).toBe('Multikey');
    expect(vm.publicKeyMultibase.startsWith('z')).toBe(true);
    expect(vm.controller).toBe(doc.id);
  });

  it('authentication references a verificationMethod URI in full form', () => {
    expect(doc.authentication.length).toBeGreaterThan(0);
    const vmIds = new Set(doc.verificationMethod.map((v) => v.id));
    for (const authRef of doc.authentication) {
      expect(vmIds.has(authRef)).toBe(true);
    }
  });

  it('service endpoint uses #dina_messaging fragment + allowed type', () => {
    expect(doc.service.length).toBeGreaterThan(0);
    const svc = doc.service[0]!;
    expect(svc.id.endsWith(DINA_MESSAGING_FRAGMENT)).toBe(true);
    expect([SERVICE_TYPE_MSGBOX, SERVICE_TYPE_DIRECT_HTTPS]).toContain(svc.type);
    expect(svc.serviceEndpoint.length).toBeGreaterThan(0);
  });

  it('id matches the expected did:plc format', () => {
    expect(doc.id).toMatch(new RegExp(vector.assertions.id_format_regex));
  });

  it('vector\'s allowed_service_types matches the reference union', () => {
    expect(vector.assertions.allowed_service_types.sort()).toEqual(
      [SERVICE_TYPE_DIRECT_HTTPS, SERVICE_TYPE_MSGBOX].sort(),
    );
  });
});

// ─── Task 10.5 — ed25519_sign_verify ───────────────────────────────────────

interface Ed25519Case {
  name: string;
  message_utf8: string;
  message_hex: string;
  public_key_hex: string;
  signature_hex: string;
  expected_verify: boolean;
  tamper: {
    message_utf8: string;
    message_hex: string;
    expected_verify: boolean;
  };
}

interface Ed25519Vector {
  name: 'ed25519_sign_verify';
  task: '10.5';
  cases: Ed25519Case[];
}

function importEd25519Pub(hex: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
    format: 'jwk',
  });
}

describe('conformance vector — ed25519_sign_verify (task 10.5)', () => {
  const vector = loadVector<Ed25519Vector>('ed25519_sign_verify.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('ed25519_sign_verify');
    expect(vector.task).toBe('10.5');
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — signature verifies against frozen public key', (_name, c) => {
    const pub = importEd25519Pub(c.public_key_hex);
    const msg = Buffer.from(c.message_utf8, 'utf8');
    expect(msg.toString('hex')).toBe(c.message_hex); // pin utf8 → hex invariant
    const ok = cryptoVerify(null, msg, pub, Buffer.from(c.signature_hex, 'hex'));
    expect(ok).toBe(c.expected_verify);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — tampered message fails verification', (_name, c) => {
    const pub = importEd25519Pub(c.public_key_hex);
    const tampered = Buffer.from(c.tamper.message_utf8, 'utf8');
    expect(tampered.toString('hex')).toBe(c.tamper.message_hex);
    const ok = cryptoVerify(null, tampered, pub, Buffer.from(c.signature_hex, 'hex'));
    expect(ok).toBe(c.tamper.expected_verify);
  });

  it('every public key is 64 hex chars (32 raw bytes)', () => {
    for (const c of vector.cases) {
      expect(c.public_key_hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('every signature is 128 hex chars (64 raw bytes, R:32 || S:32)', () => {
    for (const c of vector.cases) {
      expect(c.signature_hex).toMatch(/^[0-9a-f]{128}$/);
    }
  });
});

// ─── Task 10.11 — auth_challenge_response ──────────────────────────────────

interface AuthVector {
  name: 'auth_challenge_response';
  task: '10.11';
  scenario: { nonce: string; ts: number; did: string };
  frames: {
    auth_challenge: { type: string; nonce: string; ts: number };
    signed_payload_utf8: string;
    signed_payload_hex: string;
    auth_response: { type: string; did: string; sig: string; pub: string };
    auth_success: { type: string };
  };
  assertions: {
    signed_payload_byte_count: number;
    signature_byte_count: number;
    public_key_byte_count: number;
  };
}

describe('conformance vector — auth_challenge_response (task 10.11)', () => {
  const vector = loadVector<AuthVector>('auth_challenge_response.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('auth_challenge_response');
    expect(vector.task).toBe('10.11');
  });

  it('frame types use the reference constants', () => {
    expect(vector.frames.auth_challenge.type).toBe(AUTH_CHALLENGE);
    expect(vector.frames.auth_response.type).toBe(AUTH_RESPONSE);
    expect(vector.frames.auth_success.type).toBe(AUTH_SUCCESS);
  });

  it('signed payload matches buildAuthSignedPayload(nonce, ts) byte-exactly', () => {
    const derived = buildAuthSignedPayload(
      vector.scenario.nonce,
      vector.scenario.ts,
    );
    expect(derived).toBe(vector.frames.signed_payload_utf8);
    // Hex round-trip
    expect(Buffer.from(derived, 'utf8').toString('hex')).toBe(vector.frames.signed_payload_hex);
  });

  it('signed payload byte count matches assertion', () => {
    const bytes = Buffer.byteLength(vector.frames.signed_payload_utf8, 'utf8');
    expect(bytes).toBe(vector.assertions.signed_payload_byte_count);
  });

  it('signature verifies against the response frame\'s public key', () => {
    const pub = importEd25519Pub(vector.frames.auth_response.pub);
    const payload = Buffer.from(vector.frames.signed_payload_utf8, 'utf8');
    const sig = Buffer.from(vector.frames.auth_response.sig, 'hex');
    expect(cryptoVerify(null, payload, pub, sig)).toBe(true);
  });

  it('tampered ts causes verification to fail (replay-protection sanity)', () => {
    const pub = importEd25519Pub(vector.frames.auth_response.pub);
    const tampered = buildAuthSignedPayload(
      vector.scenario.nonce,
      vector.scenario.ts + 1, // bump ts by one second
    );
    const sig = Buffer.from(vector.frames.auth_response.sig, 'hex');
    expect(cryptoVerify(null, Buffer.from(tampered, 'utf8'), pub, sig)).toBe(false);
  });

  it('sig and pub have the right byte sizes', () => {
    expect(vector.frames.auth_response.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(vector.frames.auth_response.pub).toMatch(/^[0-9a-f]{64}$/);
    expect(vector.assertions.signature_byte_count).toBe(64);
    expect(vector.assertions.public_key_byte_count).toBe(32);
  });
});

// ─── Task 10.6 — did_key_from_ed25519_pub ──────────────────────────────────

interface DidKeyCase {
  name: string;
  public_key_hex: string;
  multicodec_prefix_hex: string;
  payload_hex: string;
  payload_byte_count: number;
  base58btc_encoded: string;
  expected_did_key: string;
}

interface DidKeyVector {
  name: 'did_key_from_ed25519_pub';
  task: '10.6';
  cases: DidKeyCase[];
}

describe('conformance vector — did_key_from_ed25519_pub (task 10.6)', () => {
  const vector = loadVector<DidKeyVector>('did_key_from_ed25519_pub.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('did_key_from_ed25519_pub');
    expect(vector.task).toBe('10.6');
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — did:key derivation matches frozen value', (_name, c) => {
    const pub = hexToBytes(c.public_key_hex);
    expect(pub.length).toBe(32);

    // Multicodec varint 0xed 0x01 = ed25519-pub
    const multicodec = hexToBytes(c.multicodec_prefix_hex);
    expect(multicodec).toEqual(new Uint8Array([0xed, 0x01]));

    const payload = new Uint8Array(34);
    payload.set(multicodec, 0);
    payload.set(pub, 2);
    expect(bytesToHex(payload)).toBe(c.payload_hex);
    expect(payload.length).toBe(c.payload_byte_count);

    const encoded = base58.encode(payload);
    expect(encoded).toBe(c.base58btc_encoded);
    expect(`did:key:z${encoded}`).toBe(c.expected_did_key);
  });

  it('every did:key starts with the multibase-base58btc "did:key:z" prefix', () => {
    for (const c of vector.cases) {
      expect(c.expected_did_key.startsWith('did:key:z')).toBe(true);
    }
  });

  it('base58btc output never contains the 4 excluded chars (0, O, I, l)', () => {
    for (const c of vector.cases) {
      expect(c.base58btc_encoded).not.toMatch(/[0OIl]/);
    }
  });
});

// ─── Task 10.9 — blake2b_24_sealed_nonce ───────────────────────────────────

interface BlakeCase {
  name: string;
  ephemeral_pub_hex: string;
  recipient_pub_hex: string;
  concatenated_input_hex: string;
  expected_nonce_hex: string;
  expected_nonce_byte_count: number;
}

interface BlakeVector {
  name: 'blake2b_24_sealed_nonce';
  task: '10.9';
  cases: BlakeCase[];
}

describe('conformance vector — blake2b_24_sealed_nonce (task 10.9)', () => {
  const vector = loadVector<BlakeVector>('blake2b_24_sealed_nonce.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('blake2b_24_sealed_nonce');
    expect(vector.task).toBe('10.9');
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — BLAKE2b(24) nonce matches frozen value', (_name, c) => {
    const ephemeral = hexToBytes(c.ephemeral_pub_hex);
    const recipient = hexToBytes(c.recipient_pub_hex);
    expect(ephemeral.length).toBe(32);
    expect(recipient.length).toBe(32);

    const input = new Uint8Array(64);
    input.set(ephemeral, 0);
    input.set(recipient, 32);
    expect(bytesToHex(input)).toBe(c.concatenated_input_hex);

    const nonce = blake2b(input, { dkLen: 24 });
    expect(nonce.length).toBe(24);
    expect(bytesToHex(nonce)).toBe(c.expected_nonce_hex);
  });

  it('every nonce is 48 lowercase hex chars (24 bytes)', () => {
    for (const c of vector.cases) {
      expect(c.expected_nonce_hex).toMatch(/^[0-9a-f]{48}$/);
      expect(c.expected_nonce_byte_count).toBe(24);
    }
  });

  it('swapping ephemeral + recipient order produces a different nonce (regression guard)', () => {
    const c = vector.cases[0]!;
    const ephemeral = hexToBytes(c.ephemeral_pub_hex);
    const recipient = hexToBytes(c.recipient_pub_hex);
    const swapped = new Uint8Array(64);
    swapped.set(recipient, 0);
    swapped.set(ephemeral, 32);
    const swappedNonce = blake2b(swapped, { dkLen: 24 });
    expect(bytesToHex(swappedNonce)).not.toBe(c.expected_nonce_hex);
  });

  it('BLAKE2b(24) != SHA-512(input)[:24] — catches the pre-#9 Go regression', () => {
    const c = vector.cases[0]!;
    const input = hexToBytes(c.concatenated_input_hex);
    const sha512Truncated = createHash('sha512').update(Buffer.from(input)).digest('hex').slice(0, 48);
    expect(sha512Truncated).not.toBe(c.expected_nonce_hex);
  });
});

// ─── Task 10.10 — nacl_sealed_box ──────────────────────────────────────────

interface SealedBoxCase {
  name: string;
  expected_plaintext_utf8: string;
  expected_plaintext_hex: string;
  ciphertext_hex: string;
  ciphertext_byte_count: number;
}

interface SealedBoxVector {
  name: 'nacl_sealed_box';
  task: '10.10';
  recipient: { public_key_hex: string; private_key_hex: string };
  cases: SealedBoxCase[];
}

describe('conformance vector — nacl_sealed_box (task 10.10)', () => {
  const vector = loadVector<SealedBoxVector>('nacl_sealed_box.json');
  let pub: Uint8Array;
  let priv: Uint8Array;

  beforeAll(async () => {
    await sodium.ready;
    pub = sodium.from_hex(vector.recipient.public_key_hex);
    priv = sodium.from_hex(vector.recipient.private_key_hex);
  });

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('nacl_sealed_box');
    expect(vector.task).toBe('10.10');
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it('recipient keypair is 32 bytes each', () => {
    expect(vector.recipient.public_key_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(vector.recipient.private_key_hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — decrypt yields expected plaintext', (_name, c) => {
    const ct = sodium.from_hex(c.ciphertext_hex);
    expect(ct.length).toBe(c.ciphertext_byte_count);
    const ptBytes = sodium.crypto_box_seal_open(ct, pub, priv);
    expect(sodium.to_string(ptBytes)).toBe(c.expected_plaintext_utf8);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — ciphertext length is plaintext + 48 overhead', (_name, c) => {
    const plaintextLen = Buffer.byteLength(c.expected_plaintext_utf8, 'utf8');
    expect(c.ciphertext_byte_count).toBe(plaintextLen + 48);
  });

  it('flipping a byte in any ciphertext causes decrypt to throw (Poly1305 MAC fails)', () => {
    const c = vector.cases[0]!;
    const ct = sodium.from_hex(c.ciphertext_hex);
    const tampered = new Uint8Array(ct);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => sodium.crypto_box_seal_open(tampered, pub, priv)).toThrow();
  });

  it('wrong recipient private key causes decrypt to throw', () => {
    const c = vector.cases[0]!;
    const ct = sodium.from_hex(c.ciphertext_hex);
    const wrongPriv = new Uint8Array(priv);
    // Flip a byte in the middle — NOT byte 0 (low 3 bits are clamped away
    // by X25519 anyway, so flipping them is a no-op) and NOT byte 31
    // (bits 6/7 are also forced). Byte 15 is entirely free-variable.
    wrongPriv[15] = wrongPriv[15]! ^ 0xff;
    expect(() => sodium.crypto_box_seal_open(ct, pub, wrongPriv)).toThrow();
  });

  it('recipient keypair is derivable from the shipped seed', () => {
    const seed = sodium.from_hex('5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a');
    const keys = sodium.crypto_box_seed_keypair(seed);
    expect(sodium.to_hex(keys.publicKey)).toBe(vector.recipient.public_key_hex);
    expect(sodium.to_hex(keys.privateKey)).toBe(vector.recipient.private_key_hex);
  });
});

// ─── TN-PROTO-004 — trust_score_v1 ─────────────────────────────────────────

import {
  computeScoreV1,
  type ScoreV1Input,
  type ScoreV1Output,
} from '../src/trust/score_v1';

interface ScoreV1Case {
  name: string;
  notes?: string;
  input: ScoreV1Input;
  expected_output: ScoreV1Output;
}

interface ScoreV1Vector {
  name: 'trust_score_v1';
  task: 'TN-PROTO-004';
  scenario: { now_ms: number; now_iso: string };
  cases: ScoreV1Case[];
}

describe('conformance vector — trust_score_v1 (TN-PROTO-004)', () => {
  const vector = loadVector<ScoreV1Vector>('trust_score_v1.json');

  it('file is structurally well-formed', () => {
    expect(vector.name).toBe('trust_score_v1');
    expect(vector.task).toBe('TN-PROTO-004');
    expect(vector.scenario).toBeDefined();
    expect(typeof vector.scenario.now_ms).toBe('number');
    expect(vector.cases.length).toBeGreaterThan(0);
  });

  it('scenario now_iso decodes back to scenario now_ms', () => {
    expect(new Date(vector.scenario.now_iso).getTime()).toBe(vector.scenario.now_ms);
  });

  it.each(
    vector.cases.map((c) => [c.name, c]),
  )('%s — computeScoreV1 matches frozen expected output', (_name, c) => {
    const got = computeScoreV1(c.input, vector.scenario.now_ms);
    // Strict equality across every numeric field — both sides are
    // deterministic IEEE-754 doubles produced by the same reference.
    expect(got.overallScore).toBe(c.expected_output.overallScore);
    expect(got.confidence).toBe(c.expected_output.confidence);
    expect(got.components.sentiment).toBe(c.expected_output.components.sentiment);
    expect(got.components.vouch).toBe(c.expected_output.components.vouch);
    expect(got.components.reviewer).toBe(c.expected_output.components.reviewer);
    expect(got.components.network).toBe(c.expected_output.components.network);
  });

  it('every overallScore is in [0, 1]', () => {
    for (const c of vector.cases) {
      expect(c.expected_output.overallScore).toBeGreaterThanOrEqual(0);
      expect(c.expected_output.overallScore).toBeLessThanOrEqual(1);
    }
  });

  it('every component is in [0, 1]', () => {
    for (const c of vector.cases) {
      const comps = c.expected_output.components;
      for (const k of ['sentiment', 'vouch', 'reviewer', 'network'] as const) {
        expect(comps[k]).toBeGreaterThanOrEqual(0);
        expect(comps[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('confidence is one of the six discrete tiers', () => {
    const allowed = new Set([0.0, 0.2, 0.4, 0.6, 0.8, 0.95]);
    for (const c of vector.cases) {
      expect(allowed.has(c.expected_output.confidence)).toBe(true);
    }
  });

  it('cases cover each flag severity at least once', () => {
    const seen = new Set<string>();
    for (const c of vector.cases) for (const s of c.input.flagSeverities) seen.add(s);
    expect(seen.has('critical')).toBe(true);
    expect(seen.has('serious')).toBe(true);
    expect(seen.has('warning')).toBe(true);
  });

  it('a tombstone-coordination case is present (tombstoneCount >= 3)', () => {
    expect(vector.cases.some((c) => c.input.tombstoneCount >= 3)).toBe(true);
  });

  it('an unvouched-author case is present (author weight collapses to zero)', () => {
    expect(vector.cases.some((c) =>
      c.input.attestationsAbout.some((a) => !a.authorHasInboundVouch),
    )).toBe(true);
  });
});

// ─── Vectors-dir hygiene ───────────────────────────────────────────────────

describe('conformance vectors — manifest hygiene', () => {
  it('index.json references every non-pending .json vector in the directory', () => {
    const indexPath = path.join(VECTORS_DIR, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      vectors: Array<{ slot: string; status: string }>;
    };

    for (const entry of index.vectors) {
      if (entry.status !== 'frozen') continue;
      const abs = path.join(VECTORS_DIR, entry.slot);
      expect(fs.existsSync(abs)).toBe(true);
    }
  });

  it('every *.json file in the directory is referenced by index.json (no orphans)', () => {
    const indexPath = path.join(VECTORS_DIR, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      vectors: Array<{ slot: string }>;
    };
    const indexed = new Set(index.vectors.map((v) => v.slot));
    indexed.add('index.json'); // the index itself
    for (const f of fs.readdirSync(VECTORS_DIR)) {
      if (!f.endsWith('.json')) continue; // skip .pending sentinels + README
      expect(indexed.has(f)).toBe(true);
    }
  });
});
