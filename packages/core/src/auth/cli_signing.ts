/**
 * CLI request signing — Ed25519 keypair generation, DID derivation,
 * and canonical request signing as used by dina-cli.
 *
 * This is the contract that the Core RPC Relay must satisfy:
 * dina-cli signs requests with these exact functions, and Core
 * validates them with the corresponding verify functions.
 *
 * DID format: did:key:z6Mk... (Ed25519 multicodec + base58btc)
 * Multibase: z-prefixed base58btc encoding
 *
 * Source: cli/tests/test_signing.py
 */

import { generateKeypair } from '../identity/keypair';
import { deriveDIDKey, publicKeyToMultibase } from '../identity/did';
import { signRequest, verifyRequest } from './canonical';

export interface CLIKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  did: string;
  publicKeyMultibase: string;
}

/**
 * Generate a new Ed25519 keypair for CLI device identity.
 * Includes derived DID and multibase public key.
 */
export function generateCLIKeypair(): CLIKeypair {
  const { publicKey, privateKey } = generateKeypair();
  const did = deriveDIDKey(publicKey);
  const publicKeyMultibase = publicKeyToMultibase(publicKey);

  return { publicKey, privateKey, did, publicKeyMultibase };
}

/**
 * Sign a CLI request — returns (did, timestamp, nonce, signature).
 * Uses the canonical payload format from canonical.ts.
 *
 * @param method - HTTP method
 * @param path - URL path
 * @param body - Raw body bytes (empty for GET)
 * @param privateKey - Ed25519 private key
 * @param did - Signer's DID
 */
export function signCLIRequest(
  method: string,
  path: string,
  body: Uint8Array,
  privateKey: Uint8Array,
  did: string,
): { did: string; timestamp: string; nonce: string; signature: string } {
  const headers = signRequest(method, path, '', body, privateKey, did);

  return {
    did: headers['X-DID'],
    timestamp: headers['X-Timestamp'],
    nonce: headers['X-Nonce'],
    signature: headers['X-Signature'],
  };
}

/**
 * Verify a CLI-signed request.
 * Delegates to canonical verifyRequest.
 */
export function verifyCLIRequest(
  method: string,
  path: string,
  body: Uint8Array,
  timestamp: string,
  nonce: string,
  signatureHex: string,
  publicKey: Uint8Array,
): boolean {
  return verifyRequest(method, path, '', timestamp, nonce, body, signatureHex, publicKey);
}
