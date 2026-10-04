/**
 * An owner device for HTTP-level specs: pairs a fresh Ed25519 key through
 * Core's owner routes (as the web app's "Connect this browser" does) and
 * signs requests with Dina's canonical request signature, so a spec can call
 * Brain's API the way the paired browser does. Brain serves signed callers
 * only (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1).
 *
 * Written from the documented wire format with Node's own crypto, not with
 * `@dina/core`, so it also checks that an independent client can talk to
 * Dina: `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}`,
 * signed Ed25519, sent as X-DID, X-Timestamp, X-Nonce and X-Signature.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btc(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The did:key of a raw Ed25519 public key (multicodec 0xed01, base58btc). */
export function didKeyOf(rawPublicKey: Uint8Array): string {
  return `did:key:z${base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey]))}`;
}

export interface OwnerSigner {
  did: string;
  /** The four signature headers for one request to `url` (path and query are taken from it). */
  headers(method: string, url: string, body?: string): Record<string, string>;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Pair a new owner device at `coreUrl` with the node's owner key. */
export async function pairOwnerSigner(coreUrl: string, ownerKey: string, passphrase = ''): Promise<OwnerSigner> {
  const owner = { 'x-dina-owner-capability': ownerKey };
  if (passphrase !== '') {
    const proved = await postJson(`${coreUrl}/v1/commerce/catalog/drafts/presence`, { passphrase }, owner);
    if (proved.status !== 200 && proved.status !== 409) throw new Error(`owner signer: presence ${proved.status}`);
  }
  const minted = await postJson(`${coreUrl}/v1/owner/setup/owner-device`, { device_name: 'E2E owner signer' }, owner);
  const code = typeof minted.body.code === 'string' ? minted.body.code : '';
  if (minted.status !== 201 || code === '') throw new Error(`owner signer: mint ${minted.status}`);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  const did = didKeyOf(raw);
  const paired = await postJson(`${coreUrl}/v1/pair/complete`, { code, public_key_multibase: did.slice('did:key:'.length) });
  if (paired.status !== 200 && paired.status !== 201) throw new Error(`owner signer: pair ${paired.status}`);
  return signerFor(did, privateKey);
}

/** A signer over an existing key (pairing aside), for checking the format. */
export function signerFor(did: string, privateKey: KeyObject): OwnerSigner {
  return {
    did,
    headers(method, url, body = '') {
      const u = new URL(url);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const nonce = randomBytes(16).toString('hex');
      const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
      const canonical = `${method.toUpperCase()}\n${u.pathname}\n${u.search.slice(1)}\n${timestamp}\n${nonce}\n${bodyHash}`;
      const signature = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
      return { 'X-DID': did, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature };
    },
  };
}
