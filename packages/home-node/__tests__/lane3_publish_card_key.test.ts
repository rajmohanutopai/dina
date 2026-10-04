/**
 * The card key in the DID document (A2A design §8.3; plan §3.22; notes
 * "The card key in the DID document"): what `ensureA2ACardKey` posts is the
 * very key the card is signed with, and every case where it cannot post a
 * sound update throws, so the publisher keeps the card back. Against a PLC
 * directory faked at the fetch edge.
 */

import { p256 } from '@noble/curves/nist.js';

import { p256FromMultikey } from '@dina/a2a';
import { deriveP256SigningKey, deriveRotationKey, secp256k1ToDidKeyMultibase } from '@dina/core';

import { ensureA2ACardKey } from '../src/plc_dina_update';

const DID = 'did:plc:nodeaaaaaaaaaaaaaaaaaaaa';
const PLC = 'https://plc.example';
const SEED = new Uint8Array(64).fill(9);
const ROTATION = `did:key:${secp256k1ToDidKeyMultibase(deriveRotationKey(SEED, 0).publicKey)}`;

const liveOp = () => ({
  type: 'plc_operation',
  rotationKeys: [ROTATION],
  verificationMethods: { atproto: 'did:key:zQ3shatproto', dina_signing: 'did:key:z6MkSigning' },
  services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://pds.example' } },
  alsoKnownAs: ['at://node.example'],
  prev: 'bafyprevious',
  sig: 'sig',
});

function directory(last: Record<string, unknown>, postStatus = 200) {
  const posts: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: postStatus === 200 ? 'ok' : 'invalid operation' }), { status: postStatus });
    }
    return new Response(JSON.stringify([{ operation: last }]), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, posts };
}

const ensure = (fetchFn: typeof fetch, generation = 0) =>
  ensureA2ACardKey({ did: DID, cardPublicKey: deriveP256SigningKey(SEED, generation).publicKey, masterSeed: SEED, plcURL: PLC, fetch: fetchFn });

// Plan E150
it('the key it posts decodes to the 33-byte compressed P-256 key the card is signed with', async () => {
  const { fetchFn, posts } = directory(liveOp());
  expect(await ensure(fetchFn)).toBe('published');
  const named = (posts[0]?.verificationMethods as Record<string, string>).a2a_card ?? '';
  expect(named.startsWith('did:key:zDn')).toBe(true);
  const key = p256FromMultikey(named.slice('did:key:'.length));
  expect(key?.length).toBe(33);
  const cardKey = deriveP256SigningKey(SEED, 0);
  expect(Buffer.from(key ?? new Uint8Array())).toEqual(Buffer.from(cardKey.publicKey));
  // A signature by the card's private key verifies under the posted key.
  const message = new TextEncoder().encode('card signing input');
  expect(p256.verify(p256.sign(message, cardKey.privateKey), message, key ?? new Uint8Array())).toBe(true);
});

// Plan E151
it('a PLC directory that refuses the update makes it throw, so no caller takes the key as there', async () => {
  const { fetchFn, posts } = directory(liveOp(), 400);
  await expect(ensure(fetchFn)).rejects.toThrow(/rejected update/);
  expect(posts).toHaveLength(1);
});

// Plan E152
it.each([
  ['a tombstone', { type: 'plc_tombstone', prev: 'bafyprevious', sig: 'sig' }],
  [
    'a legacy create operation',
    { type: 'create', signingKey: 'did:key:zQ3shsigning', recoveryKey: ROTATION, handle: 'node.example', service: 'https://pds.example', prev: null, sig: 'sig' },
  ],
])('a last operation that is %s carries no rotation keys, so it is not chained onto: it throws and posts nothing', async (_name, last) => {
  const { fetchFn, posts } = directory(last);
  await expect(ensure(fetchFn)).rejects.toThrow(/no rotation keys/);
  expect(posts).toEqual([]);
});
