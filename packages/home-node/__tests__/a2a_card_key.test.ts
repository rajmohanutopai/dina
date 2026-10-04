/**
 * The card-signing key in the node's DID document (A2A design §8.3): AppView
 * verifies a published card against `#a2a_card`, so the node puts it there.
 * Against a scripted PLC directory: nothing written when the key is already
 * there; a chained update that adds or replaces only `a2a_card` otherwise,
 * signed by the rotation key; failures surfaced.
 */

import { p256Multikey } from '@dina/a2a';
import { cidForOperation, deriveP256SigningKey, deriveRotationKey, secp256k1ToDidKeyMultibase } from '@dina/core';

import { ensureA2ACardKey } from '../src/plc_dina_update';

const DID = 'did:plc:nodeaaaaaaaaaaaaaaaaaaaa';
const PLC = 'https://plc.example';
const SEED = new Uint8Array(64).fill(3);
const CARD_KEY = deriveP256SigningKey(SEED, 0).publicKey;
const ROTATION = `did:key:${secp256k1ToDidKeyMultibase(deriveRotationKey(SEED, 0).publicKey)}`;

function lastOp(extraVMs: Record<string, string> = {}, over: Record<string, unknown> = {}) {
  return {
    type: 'plc_operation',
    rotationKeys: ['did:key:zQ3shPDSmanaged00000000000000000000000000000000', ROTATION],
    verificationMethods: { atproto: 'did:key:zQ3shatproto', dina_signing: 'did:key:z6MkSigning', ...extraVMs },
    services: {
      atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://pds.example' },
      'dina-messaging': { type: 'DinaMsgBox', endpoint: 'wss://msgbox.example' },
    },
    alsoKnownAs: ['at://node.example'],
    prev: 'bafyprevious',
    sig: 'sig',
    ...over,
  };
}

function directory(op: Record<string, unknown> | null, auditStatus = 200) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response('{}', { status: 200 });
    }
    expect(u).toBe(`${PLC}/${DID}/log/audit`);
    return new Response(JSON.stringify(op === null ? [] : [{ operation: op }]), { status: auditStatus });
  }) as typeof fetch;
  return { fetchFn, posts };
}

const ensure = (fetchFn: typeof fetch) =>
  ensureA2ACardKey({ did: DID, cardPublicKey: CARD_KEY, masterSeed: SEED, plcURL: PLC, fetch: fetchFn });

it('writes nothing when the document already names the key', async () => {
  const { fetchFn, posts } = directory(lastOp({ a2a_card: `did:key:${p256Multikey(CARD_KEY)}` }));
  expect(await ensure(fetchFn)).toBe('present');
  expect(posts).toEqual([]);
});

it('adds the key in a chained update that keeps every other field, signed', async () => {
  const op = lastOp();
  const { fetchFn, posts } = directory(op);
  expect(await ensure(fetchFn)).toBe('published');
  expect(posts).toHaveLength(1);
  const update = posts[0]?.body ?? {};
  expect(posts[0]?.url).toBe(`${PLC}/${DID}`);
  expect(update.prev).toBe(cidForOperation(op));
  expect(update.verificationMethods).toEqual({ ...op.verificationMethods, a2a_card: `did:key:${p256Multikey(CARD_KEY)}` });
  expect(update.rotationKeys).toEqual(op.rotationKeys);
  expect(update.services).toEqual(op.services);
  expect(update.alsoKnownAs).toEqual(op.alsoKnownAs);
  expect(typeof update.sig).toBe('string');
});

it('replaces an older card key after a rotation', async () => {
  const { fetchFn, posts } = directory(lastOp({ a2a_card: 'did:key:zDnaeOldKey' }));
  expect(await ensure(fetchFn)).toBe('published');
  expect((posts[0]?.body.verificationMethods as Record<string, string>).a2a_card).toBe(`did:key:${p256Multikey(CARD_KEY)}`);
});

it.each([
  ['an audit log it cannot read', () => directory(lastOp(), 503), /audit log fetch failed/],
  ['an empty audit log', () => directory(null), /no last operation/],
  ['a last operation with no rotation keys', () => directory(lastOp({}, { rotationKeys: [] })), /no rotation keys/],
])('throws on %s, writing nothing', async (_name, make, error) => {
  const { fetchFn, posts } = make();
  await expect(ensure(fetchFn)).rejects.toThrow(error);
  expect(posts).toEqual([]);
});
