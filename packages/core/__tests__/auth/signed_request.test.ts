/**
 * The shared signature check (Core's middleware and Brain's caller check):
 * malformed material is a refusal, never a throw.
 */

import { NonceCache, checkRequestSignature, deriveDIDKey, getPublicKey, signRequest } from '../../src';

const privateKey = new Uint8Array(32).fill(5);
const did = deriveDIDKey(getPublicKey(privateKey));

function signed(over: Record<string, string> = {}) {
  const h = signRequest('GET', '/x', '', new Uint8Array(), privateKey, did);
  return {
    method: 'GET',
    path: '/x',
    query: '',
    body: new Uint8Array(),
    did: h['X-DID'],
    timestamp: h['X-Timestamp'],
    nonce: h['X-Nonce'],
    signature: h['X-Signature'],
    ...over,
  };
}

it('accepts a good signature', () => {
  expect(checkRequestSignature(signed(), { nonces: new NonceCache() })).toEqual({ ok: true, did });
});

it.each([
  ['a timestamp that is not RFC 3339', { timestamp: 'yesterday' }, 'timestamp'],
  ['a signature that is not hex', { signature: 'zz-not-hex' }, 'signature'],
  ['a signature of the wrong length', { signature: 'abcd' }, 'signature'],
  ['a DID with no key in it', { did: 'did:plc:nobody' }, 'signature'],
])('refuses %s without throwing', (_name, over, rejectedAt) => {
  expect(checkRequestSignature(signed(over), { nonces: new NonceCache() })).toEqual(
    expect.objectContaining({ ok: false, rejectedAt }),
  );
});
