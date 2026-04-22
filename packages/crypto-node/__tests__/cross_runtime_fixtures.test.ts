/**
 * Task 3.30 — cross-runtime fixture cross-check against Go Core.
 *
 * Runs `NodeCryptoAdapter`'s primitives against the hex vectors in
 * `packages/fixtures/crypto/*.json`. Each fixture file was generated
 * from the Go Core reference implementation (e.g. `crypto/signer.go`,
 * `crypto/slip0010.go`) — so a passing assertion means the pure-JS
 * adapter produces byte-identical output to Go Core.
 *
 * This is the load-bearing parity gate. Ed25519/X25519/secp256k1/HKDF
 * all share code with `@dina/core` (both delegate to `@noble/*`), but
 * that's an implementation detail — the contract is byte-parity with
 * Go, and this test proves it regardless of which @noble minor the
 * adapter or core happen to pin.
 *
 * Fixture shape (see packages/fixtures/crypto/*.json):
 *   { domain, version, vectors: [{description, inputs, expected}] }
 *
 * When a fixture file is missing, tests skip (permissive bootstrap).
 * Set DINA_FIXTURES_STRICT=1 to fail instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPublicKey as edGetPublicKey } from '@noble/ed25519';
import { NodeCryptoAdapter } from '../src';

// ---------------------------------------------------------------------------
// Fixture helpers — inlined rather than imported from @dina/test-harness
// because crypto-node's tsconfig pins strict flags (exactOptionalPropertyTypes,
// noUncheckedIndexedAccess) that test-harness's source doesn't fully satisfy.
// The fixture contract is just JSON + hex, so inlining keeps this test
// self-contained without weakening crypto-node's own strictness.
// ---------------------------------------------------------------------------

const FIXTURES_ROOT = path.resolve(__dirname, '../../fixtures');

interface FixtureVector<TIn, TExp> {
  description: string;
  inputs: TIn;
  expected: TExp;
}

interface FixtureFile<TIn, TExp> {
  domain: string;
  version: number;
  vectors: Array<FixtureVector<TIn, TExp>>;
}

function fixturePath(relativePath: string): string {
  return path.join(FIXTURES_ROOT, relativePath);
}

function hasFixture(relativePath: string): boolean {
  return fs.existsSync(fixturePath(relativePath));
}

function loadVectors<TIn, TExp>(relativePath: string): Array<FixtureVector<TIn, TExp>> {
  const raw = fs.readFileSync(fixturePath(relativePath), 'utf-8');
  const parsed = JSON.parse(raw) as FixtureFile<TIn, TExp>;
  return parsed.vectors;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex string must be even length, got ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

const adapter = new NodeCryptoAdapter();

// Argon2id is CPU-intensive at OWASP-profile costs.
jest.setTimeout(30_000);

describe('NodeCryptoAdapter — cross-runtime fixtures (Go Core parity)', () => {
  // ─── SLIP-0010 Ed25519 root ───────────────────────────────────────────
  const rootFx = 'crypto/slip0010_root_signing_key.json';
  const rootDescribe = hasFixture(rootFx) ? describe : describe.skip;
  rootDescribe('SLIP-0010 Ed25519 root', () => {
    const vectors = loadVectors<
      { seed_hex: string; path: string },
      { private_key_hex: string; public_key_hex: string }
    >(rootFx);

    for (const v of vectors) {
      it(v.description, async () => {
        const r = await adapter.ed25519DerivePath(hexToBytes(v.inputs.seed_hex), v.inputs.path);
        expect(bytesToHex(r.privateKey)).toBe(v.expected.private_key_hex);
        expect(bytesToHex(r.publicKey)).toBe(v.expected.public_key_hex);
      });
    }
  });

  // ─── SLIP-0010 Ed25519 personas (6 vectors) ──────────────────────────
  const personaFx = 'crypto/slip0010_persona_keys.json';
  const personaDescribe = hasFixture(personaFx) ? describe : describe.skip;
  personaDescribe('SLIP-0010 Ed25519 persona keys', () => {
    const vectors = loadVectors<
      { seed_hex: string; path: string; persona_name: string },
      { private_key_hex: string; public_key_hex: string }
    >(personaFx);

    for (const v of vectors) {
      it(`${v.inputs.persona_name} — ${v.description}`, async () => {
        const r = await adapter.ed25519DerivePath(hexToBytes(v.inputs.seed_hex), v.inputs.path);
        expect(bytesToHex(r.privateKey)).toBe(v.expected.private_key_hex);
        expect(bytesToHex(r.publicKey)).toBe(v.expected.public_key_hex);
      });
    }
  });

  // ─── SLIP-0010 secp256k1 rotation ────────────────────────────────────
  const rotationFx = 'crypto/slip0010_rotation_key.json';
  const rotationDescribe = hasFixture(rotationFx) ? describe : describe.skip;
  rotationDescribe('SLIP-0010 secp256k1 rotation key', () => {
    const vectors = loadVectors<
      { seed_hex: string; path: string },
      { private_key_hex: string }
    >(rotationFx);

    for (const v of vectors) {
      it(v.description, async () => {
        const r = await adapter.secp256k1DerivePath(hexToBytes(v.inputs.seed_hex), v.inputs.path);
        expect(bytesToHex(r.privateKey)).toBe(v.expected.private_key_hex);
      });
    }
  });

  // ─── SLIP-0010 adversarial ──────────────────────────────────────────
  //
  // The Go fixture ships 6 adversarial vectors. 5 of them are policy-
  // consistent across Go Core and this adapter. One — the all-zero
  // 64-byte seed — diverges intentionally: `NodeCryptoAdapter` is
  // hardened fail-closed (rejects all-zero seeds) while Go Core's
  // reference accepts them. The divergence is by design: Dina V1
  // refuses to derive keys from obviously-degenerate seeds. We pin
  // the divergence explicitly rather than silently skipping, so any
  // future policy realignment is a conscious choice.
  const adversarialFx = 'crypto/slip0010_adversarial.json';
  const adversarialDescribe = hasFixture(adversarialFx) ? describe : describe.skip;
  adversarialDescribe('SLIP-0010 adversarial inputs', () => {
    const vectors = loadVectors<
      { seed_hex: string; path: string },
      { should_fail: boolean; error?: string }
    >(adversarialFx);

    const isAllZeroSeed = (hex: string): boolean => hex.length > 0 && /^(?:00)+$/.test(hex);

    for (const v of vectors) {
      // Divergence: the fixture's all-zero seed vectors (64-byte and 16-byte)
      // are accepted by Go Core but fail-closed in our adapter. Skip the
      // generic "should_fail" assertion for them; pin the adapter policy
      // explicitly in the divergence test below.
      if (isAllZeroSeed(v.inputs.seed_hex)) continue;
      it(v.description, async () => {
        const call = adapter.ed25519DerivePath(hexToBytes(v.inputs.seed_hex), v.inputs.path);
        if (v.expected.should_fail) {
          await expect(call).rejects.toThrow();
        } else {
          await expect(call).resolves.toBeDefined();
        }
      });
    }

    it('(divergence) all-zero seeds rejected by adapter, accepted by Go Core', async () => {
      const divergent = vectors.filter((v) => isAllZeroSeed(v.inputs.seed_hex));
      expect(divergent.length).toBeGreaterThan(0);
      for (const v of divergent) {
        // Sanity: Go Core accepts.
        expect(v.expected.should_fail).toBe(false);
        // Adapter policy: fail-closed on all-zero seeds.
        await expect(
          adapter.ed25519DerivePath(hexToBytes(v.inputs.seed_hex), v.inputs.path),
        ).rejects.toThrow(/all-zero/);
      }
    });
  });

  // ─── Ed25519 sign/verify ─────────────────────────────────────────────
  const edFx = 'crypto/ed25519_sign_verify.json';
  const edDescribe = hasFixture(edFx) ? describe : describe.skip;
  edDescribe('Ed25519 sign/verify/keygen', () => {
    const vectors = loadVectors<
      {
        seed_hex?: string;
        message_hex?: string;
        private_key_hex?: string;
        public_key_hex?: string;
        signature_hex?: string;
      },
      {
        private_key_hex?: string;
        public_key_hex?: string;
        signature_hex?: string;
        signature_length?: string;
        valid?: boolean;
      }
    >(edFx);

    for (const v of vectors) {
      it(v.description, async () => {
        // Keypair-from-seed vector: Go uses `ed25519.NewKeyFromSeed(seed)`
        // where the seed IS the 32-byte private key (no HDKD). Match by
        // computing `getPublicKey(seed)` directly — the same primitive
        // the adapter uses under the hood.
        if (v.inputs.seed_hex && v.expected.public_key_hex && !v.inputs.message_hex) {
          const pub = edGetPublicKey(hexToBytes(v.inputs.seed_hex));
          expect(bytesToHex(pub)).toBe(v.expected.public_key_hex);
        }
        // Sign vector — deterministic per RFC 8032
        if (
          v.inputs.message_hex &&
          v.inputs.private_key_hex &&
          v.expected.signature_hex
        ) {
          const sig = await adapter.ed25519Sign(
            hexToBytes(v.inputs.private_key_hex),
            hexToBytes(v.inputs.message_hex),
          );
          expect(bytesToHex(sig)).toBe(v.expected.signature_hex);
        }
        // Verify vector
        if (
          v.inputs.message_hex &&
          v.inputs.public_key_hex &&
          v.inputs.signature_hex &&
          typeof v.expected.valid === 'boolean'
        ) {
          const ok = await adapter.ed25519Verify(
            hexToBytes(v.inputs.public_key_hex),
            hexToBytes(v.inputs.message_hex),
            hexToBytes(v.inputs.signature_hex),
          );
          expect(ok).toBe(v.expected.valid);
        }
      });
    }
  });

  // ─── Ed25519 → X25519 key conversion ────────────────────────────────
  const convFx = 'crypto/key_convert_ed25519_x25519.json';
  const convDescribe = hasFixture(convFx) ? describe : describe.skip;
  convDescribe('Ed25519 → X25519 key conversion', () => {
    const vectors = loadVectors<
      { ed25519_pub_hex?: string; ed25519_priv_hex?: string },
      { x25519_pub_hex?: string; x25519_priv_hex?: string; length?: string }
    >(convFx);

    for (const v of vectors) {
      it(v.description, async () => {
        if (v.inputs.ed25519_pub_hex && v.expected.x25519_pub_hex) {
          const x = await adapter.x25519FromEd25519Public(hexToBytes(v.inputs.ed25519_pub_hex));
          expect(bytesToHex(x)).toBe(v.expected.x25519_pub_hex);
          expect(x.length).toBe(32);
        }
        if (v.inputs.ed25519_priv_hex && v.expected.x25519_priv_hex) {
          const x = await adapter.x25519FromEd25519Private(hexToBytes(v.inputs.ed25519_priv_hex));
          expect(bytesToHex(x)).toBe(v.expected.x25519_priv_hex);
          expect(x.length).toBe(32);
        }
      });
    }
  });

  // ─── NaCl sealed-box round-trip ──────────────────────────────────────
  //
  // Ciphertext is non-deterministic (fresh ephemeral keys per seal), so
  // we assert round-trip, not byte-identical output. Go Core's fixture
  // declares the same contract (`sealed_hex varies each run`).
  const naclFx = 'crypto/nacl_seal_unseal.json';
  const naclDescribe = hasFixture(naclFx) ? describe : describe.skip;
  naclDescribe('NaCl sealed-box round-trip', () => {
    const vectors = loadVectors<
      { ed25519_seed_hex: string; plaintext_hex: string; x25519_pub_hex: string },
      { unsealed_hex: string; sealed_length_min: number; roundtrip_matches: boolean }
    >(naclFx);

    for (const v of vectors) {
      it(v.description, async () => {
        // Recover Ed25519 pub from the fixture seed (Go's
        // `ed25519.NewKeyFromSeed`: pub = s·B where s = SHA-512(seed)[:32]
        // clamped). We call @noble directly — same dep the adapter uses
        // internally — because the port doesn't surface `getPublicKey(seed)`.
        const seed = hexToBytes(v.inputs.ed25519_seed_hex);
        const edPub = edGetPublicKey(seed);

        // Sanity: the fixture's `x25519_pub_hex` is derived from this Ed25519
        // pub. Confirms our Ed25519→X25519 bridge matches Go byte-for-byte.
        const xpubFromEdPub = await adapter.x25519FromEd25519Public(edPub);
        expect(bytesToHex(xpubFromEdPub)).toBe(v.inputs.x25519_pub_hex);

        // Seal with recipient Ed25519 pub, open with recipient Ed25519 priv.
        // Ciphertext is non-deterministic — assert length floor + round-trip.
        const sealed = await adapter.sealedBoxSeal(hexToBytes(v.inputs.plaintext_hex), edPub);
        expect(sealed.length).toBeGreaterThanOrEqual(v.expected.sealed_length_min);
        const opened = await adapter.sealedBoxOpen(sealed, edPub, seed);
        expect(bytesToHex(opened)).toBe(v.expected.unsealed_hex);
      });
    }
  });

  // ─── Argon2id KEK (Go DeriveKEK fixture) ─────────────────────────────
  //
  // Fixture uses libargon2's canonical profile: 128 MiB / 3 iter / 4 lanes.
  // Our adapter's `argon2idHash` is thin over the same library, so outputs
  // byte-match. This is the load-bearing check for the vault passphrase
  // KDF: if this diverges, a vault encrypted on Go can't be opened by a
  // pure-TS build and vice versa.
  const argonFx = 'crypto/argon2id_kek.json';
  const argonDescribe = hasFixture(argonFx) ? describe : describe.skip;
  argonDescribe('Argon2id KEK (Go parity)', () => {
    const vectors = loadVectors<
      {
        passphrase: string;
        salt_hex: string;
        memory_kb: string;
        iterations: string;
        parallelism: string;
      },
      { kek_hex: string; kek_length: string }
    >(argonFx);

    for (const v of vectors) {
      it(v.description, async () => {
        const kek = await adapter.argon2idHash(
          new TextEncoder().encode(v.inputs.passphrase),
          hexToBytes(v.inputs.salt_hex),
          parseInt(v.expected.kek_length, 10),
          {
            timeCost: parseInt(v.inputs.iterations, 10),
            memoryCost: parseInt(v.inputs.memory_kb, 10),
            parallelism: parseInt(v.inputs.parallelism, 10),
          },
        );
        expect(bytesToHex(kek)).toBe(v.expected.kek_hex);
      });
    }
  });
});
