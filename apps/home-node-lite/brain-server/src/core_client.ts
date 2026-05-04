import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crypto, HttpClient, createCanonicalRequestSigner } from '@dina/adapters-node';
import {
  HttpCoreTransport,
  deriveDIDKey,
  extractPublicKey,
  getPublicKey,
  type CoreClient,
} from '@dina/core';

import type { BrainServerConfig } from './config';

export type CoreClientStatus =
  | 'configured'
  | 'service_key_missing'
  | 'service_key_invalid'
  | 'service_did_mismatch'
  | 'service_key_load_failed';

export interface CoreClientBuildResult {
  status: CoreClientStatus;
  core?: CoreClient;
  did?: string;
  keyFingerprint?: string;
  detail?: string;
}

export async function buildCoreClient(
  config: BrainServerConfig['core'],
): Promise<CoreClientBuildResult> {
  const key = await loadBrainServiceKey(config.serviceKeyDir, config.serviceKeyFile);
  if ('status' in key) {
    return key;
  }

  const crypto = new Crypto();
  const publicKey = getPublicKey(key.seed);
  const did = config.serviceDid ?? deriveDIDKey(publicKey);
  if (did.startsWith('did:key:') && !didKeyMatchesPublicKey(did, publicKey)) {
    return {
      status: 'service_did_mismatch',
      detail: 'DINA_BRAIN_DID did:key does not match the configured Brain service key',
    };
  }
  const signer = createCanonicalRequestSigner({
    did,
    privateKey: key.seed,
    sign: (privateKey, message) => crypto.ed25519Sign(privateKey, message),
    nonce: (byteLen) => crypto.randomBytes(byteLen),
  });

  return {
    status: 'configured',
    core: new HttpCoreTransport({
      baseUrl: config.baseUrl,
      httpClient: new HttpClient({ timeoutMs: config.httpTimeoutMs }),
      signer,
    }),
    did,
    keyFingerprint: key.fingerprint,
  };
}

interface LoadedServiceKey {
  ok: true;
  seed: Uint8Array;
  fingerprint: string;
}

async function loadBrainServiceKey(
  keyDir: string,
  fileName: string,
): Promise<LoadedServiceKey | CoreClientBuildResult> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(keyDir, fileName));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return {
      status: code === 'ENOENT' || code === 'ENOTDIR'
        ? 'service_key_missing'
        : 'service_key_load_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (bytes.byteLength !== 32) {
    return {
      status: 'service_key_invalid',
      detail: `expected 32-byte Ed25519 seed, got ${bytes.byteLength}`,
    };
  }

  const seed = new Uint8Array(bytes);
  return {
    ok: true,
    seed,
    fingerprint: fingerprintSeed(seed),
  };
}

function fingerprintSeed(seed: Uint8Array): string {
  const publicKey = getPublicKey(seed);
  return Buffer.from(publicKey.subarray(0, 8)).toString('hex');
}

function publicKeysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

function didKeyMatchesPublicKey(did: string, publicKey: Uint8Array): boolean {
  try {
    return publicKeysEqual(extractPublicKey(did), publicKey);
  } catch {
    return false;
  }
}
