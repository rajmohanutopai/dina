/**
 * The node's UCP identity (UCP plan §3.1, §3.5; S11): the request-signing key
 * and the profile label, both derived from the master seed, held in memory
 * only, never written to the DID document.
 *
 *  - The key: P-256 (ES256) at `m/9999'/6'/{generation}'`, a SLIP-0010
 *    purpose of its own, so rotating it never moves the A2A card key. Its JWK
 *    carries the RFC 7638 thumbprint as `kid`, `alg: ES256`, `use: sig`.
 *  - The label: HKDF-SHA256 over the raw seed, empty salt, info
 *    `dina:ucp:label:v1`, 16 bytes, as 26 lower-case base32 characters. The
 *    salt is empty on purpose: the label must depend on the seed alone, so a
 *    restore from the recovery phrase on a new device keeps the same buyer
 *    identity at every merchant (the per-persona DEK salt is device state).
 *
 * Key rotation (U7): any generation is derived on demand (`keyAt`); requests
 * are signed with the one the publisher made active (`useGeneration`), which
 * it learns from its own record or, on a fresh or restored node, from the
 * host. Until it knows, the identity has no signing key and no request is
 * signed (§3.5: a restored node signs only with the key the host lists as
 * active, and never with a retired one); `forgetGeneration` returns it to
 * that state while a compromised key is replaced.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { es256PublicJwk, LABEL_HKDF_INFO, labelFromBytes, type Es256Jwk } from '@dina/ucp';

import { deriveRootSigningKey, deriveUcpSigningKey } from '../../crypto/slip0010';

export interface UcpSigningKey {
  generation: number;
  /** The public key as the profile lists it. */
  jwk: Es256Jwk;
  /** Raw r||s ES256 over `base` (RFC 9421 §3.3.4); the private key never leaves this closure. */
  sign(base: Uint8Array): Uint8Array;
}

export interface UcpIdentity {
  label: string;
  /** The key requests are signed with now; null while no generation is known (nothing is signed). */
  signingKey(): UcpSigningKey | null;
  /** The signing key; throws while none is known (for callers that checked `signingKey`). */
  readonly key: UcpSigningKey;
  /** The key at `generation` (derived once, then kept). */
  keyAt(generation: number): UcpSigningKey;
  /** Sign with `generation` from now on: the publisher, once the host lists it as active. */
  useGeneration(generation: number): void;
  /** Sign with nothing until a generation is named again. */
  forgetGeneration(): void;
  /**
   * Signs profile publication envelopes with the node's root Ed25519 key
   * (`dina_signing` in its DID document, generation 0), which the host checks
   * against the DID document (§3.5). The private key stays in this closure.
   */
  signEnvelope(message: Uint8Array): Uint8Array;
}

/** The node's profile label: depends on the seed alone. */
export function deriveUcpLabel(seed: Uint8Array): string {
  if (seed.length < 16) throw new Error('ucp: master seed too short');
  return labelFromBytes(
    hkdf(sha256, seed, new Uint8Array(0), new TextEncoder().encode(LABEL_HKDF_INFO), 16),
  );
}

/**
 * The identity from the seed. `generation`: the key to sign with, when the
 * caller knows it; omitted (boot), nothing is signed until the publisher
 * names the active generation.
 */
export function deriveUcpIdentity(seed: Uint8Array, generation?: number): UcpIdentity {
  // Our own copy: the caller may wipe its seed buffer, and a later generation is derived from
  // this one. It stays in this closure, as the private keys do: only public keys come out.
  const own = seed.slice();
  const root = deriveRootSigningKey(own, 0).privateKey;
  const keys = new Map<number, UcpSigningKey>();
  const keyAt = (g: number): UcpSigningKey => {
    const known = keys.get(g);
    if (known !== undefined) return known;
    const { privateKey } = deriveUcpSigningKey(own, g);
    const key: UcpSigningKey = {
      generation: g,
      jwk: es256PublicJwk(p256.getPublicKey(privateKey, false), sha256),
      sign: (base) => p256.sign(base, privateKey),
    };
    keys.set(g, key);
    return key;
  };
  let active: number | null = generation ?? null;
  const signingKey = (): UcpSigningKey | null => (active === null ? null : keyAt(active));
  return {
    label: deriveUcpLabel(own),
    signEnvelope: (message) => ed25519.sign(message, root),
    signingKey,
    get key() {
      const key = signingKey();
      if (key === null) throw new Error('ucp: no active signing key yet');
      return key;
    },
    keyAt,
    useGeneration(g) {
      keyAt(g);
      active = g;
    },
    forgetGeneration() {
      active = null;
    },
  };
}

let installed: UcpIdentity | null = null;
/** The generation the publisher's ring makes active; null until it has read one. */
let signingGeneration: number | null = null;

/**
 * Boot installs the identity on every UCP-enabled node, whatever its A2A
 * configuration. An identity installed again (a phone unlocked after a seal)
 * signs with the generation the publisher last made active.
 */
export function installUcpIdentity(identity: UcpIdentity | null): void {
  if (identity !== null && signingGeneration !== null) identity.useGeneration(signingGeneration);
  installed = identity;
}

/**
 * The publisher names the active generation (from its record, or once the
 * host accepts a new ring); null forgets it (a wiped node). Applies at once to
 * the installed identity and to any installed later.
 */
export function setUcpSigningGeneration(generation: number | null): void {
  signingGeneration = generation;
  if (generation !== null) installed?.useGeneration(generation);
  else installed?.forgetGeneration();
}

export function getUcpIdentity(): UcpIdentity | null {
  return installed;
}
