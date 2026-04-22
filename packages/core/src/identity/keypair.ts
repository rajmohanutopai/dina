/**
 * Ed25519 keypair management — generation, PEM persistence, reload.
 *
 * PEM format: PKCS#8 for private key, SPKI for public key.
 * Ed25519 keys have fixed DER prefixes (32-byte keys, no variable-length fields).
 *
 * Source: tests/test_identity.py, core/internal/adapter/crypto/pem.go
 */

import { sign, verify, getPublicKey } from '../crypto/ed25519';
import { randomBytes } from '@noble/ciphers/utils.js';
import * as fs from 'fs';
import * as path from 'path';

export interface IdentityKeypair {
  publicKey: Uint8Array; // 32-byte Ed25519 public key
  privateKey: Uint8Array; // 32-byte Ed25519 private seed
}

/*
 * Ed25519 PKCS#8 DER prefix (16 bytes):
 *   30 2e        SEQUENCE (46 bytes total)
 *   02 01 00     INTEGER 0 (version)
 *   30 05        SEQUENCE (algorithm identifier)
 *   06 03 2b6570 OID 1.3.101.112 (id-EdDSA / Ed25519)
 *   04 22        OCTET STRING (34 bytes)
 *   04 20        OCTET STRING (32 bytes = key)
 */
const PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/*
 * Ed25519 SPKI DER prefix (12 bytes):
 *   30 2a        SEQUENCE (42 bytes total)
 *   30 05        SEQUENCE (algorithm identifier)
 *   06 03 2b6570 OID 1.3.101.112
 *   03 21        BIT STRING (33 bytes: 1 unused-bits byte + 32 key bytes)
 *   00           0 unused bits
 */
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Generate a new random Ed25519 keypair (NOT seed-derived). */
export function generateKeypair(): IdentityKeypair {
  const privateKey = randomBytes(32);
  const publicKey = getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Serialize keypair to PEM format (PKCS#8 private, SPKI public). */
export function keypairToPEM(keypair: IdentityKeypair): { privatePEM: string; publicPEM: string } {
  // Private key: PKCS#8
  const privDer = new Uint8Array(PKCS8_PREFIX.length + 32);
  privDer.set(PKCS8_PREFIX, 0);
  privDer.set(keypair.privateKey, PKCS8_PREFIX.length);
  const privatePEM =
    '-----BEGIN PRIVATE KEY-----\n' +
    wrapBase64(Buffer.from(privDer).toString('base64')) +
    '\n-----END PRIVATE KEY-----\n';

  // Public key: SPKI
  const pubDer = new Uint8Array(SPKI_PREFIX.length + 32);
  pubDer.set(SPKI_PREFIX, 0);
  pubDer.set(keypair.publicKey, SPKI_PREFIX.length);
  const publicPEM =
    '-----BEGIN PUBLIC KEY-----\n' +
    wrapBase64(Buffer.from(pubDer).toString('base64')) +
    '\n-----END PUBLIC KEY-----\n';

  return { privatePEM, publicPEM };
}

/** Deserialize keypair from PEM strings. */
export function keypairFromPEM(privatePEM: string, publicPEM: string): IdentityKeypair {
  // Parse private key
  const privDer = pemToDer(privatePEM, 'PRIVATE KEY');
  if (privDer.length !== PKCS8_PREFIX.length + 32) {
    throw new Error('keypair: invalid PKCS#8 private key length');
  }
  for (let i = 0; i < PKCS8_PREFIX.length; i++) {
    if (privDer[i] !== PKCS8_PREFIX[i]) {
      throw new Error('keypair: invalid PKCS#8 prefix — not an Ed25519 key');
    }
  }
  const privateKey = privDer.slice(PKCS8_PREFIX.length);

  // Parse public key
  const pubDer = pemToDer(publicPEM, 'PUBLIC KEY');
  if (pubDer.length !== SPKI_PREFIX.length + 32) {
    throw new Error('keypair: invalid SPKI public key length');
  }
  for (let i = 0; i < SPKI_PREFIX.length; i++) {
    if (pubDer[i] !== SPKI_PREFIX[i]) {
      throw new Error('keypair: invalid SPKI prefix — not an Ed25519 key');
    }
  }
  const publicKey = pubDer.slice(SPKI_PREFIX.length);

  // Verify consistency: derive public from private and compare
  const derivedPub = getPublicKey(privateKey);
  let mismatch = false;
  for (let i = 0; i < 32; i++) {
    if (derivedPub[i] !== publicKey[i]) {
      mismatch = true;
      break;
    }
  }
  if (mismatch) {
    throw new Error('keypair: public key does not match private key');
  }

  return { publicKey, privateKey };
}

/** Sign data with the identity keypair. Returns 64-byte signature. */
export function signWithIdentity(data: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return sign(privateKey, data);
}

/** Verify a signature against the identity's public key. */
export function verifyWithIdentity(
  data: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return verify(publicKey, data, signature);
}

// ---------------------------------------------------------------
// Service key file I/O
// ---------------------------------------------------------------

/**
 * Write service keypair PEM files to a directory.
 * Creates: `{dir}/{name}.key` (private) and `{dir}/{name}.pub` (public).
 */
export function writeServiceKey(dir: string, name: string, keypair: IdentityKeypair): void {
  fs.mkdirSync(dir, { recursive: true });
  const { privatePEM, publicPEM } = keypairToPEM(keypair);
  fs.writeFileSync(path.join(dir, `${name}.key`), privatePEM, 'utf-8');
  fs.writeFileSync(path.join(dir, `${name}.pub`), publicPEM, 'utf-8');
}

/**
 * Load service keypair from PEM files.
 * Reads `{dir}/{name}.key` and `{dir}/{name}.pub`.
 */
export function loadServiceKey(dir: string, name: string): IdentityKeypair {
  const privPath = path.join(dir, `${name}.key`);
  const pubPath = path.join(dir, `${name}.pub`);
  if (!fs.existsSync(privPath)) {
    throw new Error(`keypair: private key file not found — ${privPath}`);
  }
  if (!fs.existsSync(pubPath)) {
    throw new Error(`keypair: public key file not found — ${pubPath}`);
  }
  const privatePEM = fs.readFileSync(privPath, 'utf-8');
  const publicPEM = fs.readFileSync(pubPath, 'utf-8');
  return keypairFromPEM(privatePEM, publicPEM);
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/** Wrap a base64 string at 64 characters per line (PEM convention). */
function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return lines.join('\n');
}

/** Decode PEM to DER bytes. */
function pemToDer(pem: string, expectedLabel: string): Uint8Array {
  const lines = pem.trim().split('\n');
  if (lines.length < 3) {
    throw new Error(`keypair: invalid PEM — too few lines`);
  }
  const header = `-----BEGIN ${expectedLabel}-----`;
  const footer = `-----END ${expectedLabel}-----`;
  if (lines[0].trim() !== header) {
    throw new Error(`keypair: expected PEM header "${header}"`);
  }
  if (lines[lines.length - 1].trim() !== footer) {
    throw new Error(`keypair: expected PEM footer "${footer}"`);
  }
  const b64 = lines.slice(1, -1).join('');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
