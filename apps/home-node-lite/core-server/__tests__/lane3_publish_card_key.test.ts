/**
 * The card key and the directory (design §8.2 trigger c, §8.3; notes "The
 * card key in the DID document"): AppView checks a card's JWS against
 * `#a2a_card` in the publisher's DID document, so no card may go out signed
 * by a key the document does not name. The publisher is wired as boot wires
 * it, `cardKeyCheck` over `ensureA2ACardKey`, against a PLC directory faked
 * at the fetch edge. Every card put is checked, at the moment it lands,
 * against the key the directory's latest operation names.
 */

import { p256 } from '@noble/curves/nist.js';

import { p256FromMultikey, signAgentCard, verifyAgentCardSignatures, type AgentCard } from '@dina/a2a';
import { deriveP256SigningKey, deriveRotationKey, secp256k1ToDidKeyMultibase } from '@dina/core';
import { ensureA2ACardKey } from '@dina/home-node';

import { PUBLISH_RETRY_DELAYS_MS, cardKeyCheck } from '../src/appview/a2a_card_publisher';

import { CARD, KEY_A, NODE, PublishWorld } from './lane3_publish_fixture';

const SEED = new Uint8Array(64).fill(5);
const PLC = 'https://plc.example';
const ROTATION = `did:key:${secp256k1ToDidKeyMultibase(deriveRotationKey(SEED, 0).publicKey)}`;

/** A PLC directory: an audit log whose last operation is the document, and chained updates appended to it. */
class FakePlc {
  readonly log: { operation: Record<string, unknown> }[] = [
    {
      operation: {
        type: 'plc_operation',
        rotationKeys: [ROTATION],
        verificationMethods: { atproto: 'did:key:zQ3shatproto', dina_signing: 'did:key:z6MkSigning' },
        services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://pds.example' } },
        alsoKnownAs: ['at://node.example'],
        prev: null,
        sig: 'sig',
      },
    },
  ];
  refuse = false;
  /** Reads of the audit log: how often a key check looked the document up. */
  gets = 0;
  constructor(private readonly events: string[]) {}

  readonly fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (this.refuse) return new Response(JSON.stringify({ message: 'refused' }), { status: 400 });
      this.log.push({ operation: JSON.parse(String(init.body)) as Record<string, unknown> });
      this.events.push('plc update');
      return new Response('{}', { status: 200 });
    }
    expect(String(url)).toBe(`${PLC}/${NODE}/log/audit`);
    this.gets += 1;
    return new Response(JSON.stringify(this.log), { status: 200 });
  }) as typeof fetch;

  /** The card key the document names now, or null. */
  cardKey(): Uint8Array | null {
    const last = this.log[this.log.length - 1]?.operation ?? {};
    const named = (last.verificationMethods as Record<string, string> | undefined)?.a2a_card;
    return named === undefined ? null : p256FromMultikey(named.replace(/^did:key:/, ''));
  }
}

async function signedWith(generation: number, name = 'Bus 42'): Promise<AgentCard> {
  const key = deriveP256SigningKey(SEED, generation);
  const card = CARD(name) as unknown as Record<string, unknown>;
  const sig = await signAgentCard(card, { alg: 'ES256', kid: `card-${generation}`, jku: 'https://dina.example/a2a/jwks.json' }, (input) =>
    p256.sign(input, key.privateKey),
  );
  return { ...card, signatures: [sig] } as unknown as AgentCard;
}

/** Whether a card string verifies under a P-256 key. */
async function verifiesUnder(cardText: string, key: Uint8Array | null): Promise<boolean> {
  if (key === null) return false;
  const card = JSON.parse(cardText) as Record<string, unknown>;
  const report = await verifyAgentCardSignatures(card, ({ signingInputs, signature }) =>
    signingInputs.some((input) => p256.verify(signature, input, key)),
  );
  return report.state === 'verified';
}

let w: PublishWorld;
let events: string[];
let plc: FakePlc;
let pending: Promise<void>[];

beforeEach(() => {
  w = new PublishWorld();
  events = [];
  pending = [];
  plc = new FakePlc(events);
  // Each card put is judged against the document as it stands when the put lands.
  w.repo.onCardPut = (record) => {
    const key = plc.cardKey();
    const at = events.length;
    events.push('card put');
    pending.push(
      verifiesUnder(record.card as string, key).then((ok) => {
        events[at] = ok ? 'card put, named key' : 'card put, key not in the document';
      }),
    );
  };
});
afterEach(() => {
  w.close();
});

/** Let every pending signature check settle. */
const settle = async () => {
  await Promise.all(pending);
};

/** The check a node at card-key `generation` runs: it follows the key that signs the card. */
const keyCheckFor = (generation: number) =>
  cardKeyCheck(
    (cardPublicKey) => ensureA2ACardKey({ did: NODE, cardPublicKey, masterSeed: SEED, plcURL: PLC, fetch: plc.fetch }),
    () => deriveP256SigningKey(SEED, generation).publicKey,
    () => w.clock,
  );

// Plan X-1 (card-key rotation end to end, across a restart) and E111
it('once a restarted process takes up a new card key, the key reaches the DID document before the card it signs, and the new card republishes on its own', async () => {
  const n = w.node(KEY_A, { cardKeyReady: keyCheckFor(0) });
  n.card = await signedWith(0);
  w.listOn(n);
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  await settle();
  expect(events).toEqual(['plc update', 'card put, named key']);
  const first = w.repo.card()?.card;

  // The card key moves to generation 1, as a new process would take it up.
  // No listing changed: only the card's bytes did.
  n.card = await signedWith(1);
  n.over = { cardKeyReady: keyCheckFor(1) };
  w.restart(n);
  await n.publisher.flush();
  await settle();
  expect(events).toEqual(['plc update', 'card put, named key', 'plc update', 'card put, named key']);
  expect(w.repo.card()?.card).not.toBe(first);
  expect(await verifiesUnder(w.repo.card()?.card as string, deriveP256SigningKey(SEED, 1).publicKey)).toBe(true);
  expect(await verifiesUnder(w.repo.card()?.card as string, plc.cardKey())).toBe(true);
  expect(w.rowOf(n).state).toBe('published');
});

// Plan X-1 (card-key rotation end to end, inside one process)
it('within one running process, a new card key reaches the DID document before its card goes out', async () => {
  let generation = 0;
  const check = cardKeyCheck(
    (cardPublicKey) => ensureA2ACardKey({ did: NODE, cardPublicKey, masterSeed: SEED, plcURL: PLC, fetch: plc.fetch }),
    // As boot wires it: the key that signs the card now.
    () => deriveP256SigningKey(SEED, generation).publicKey,
    () => w.clock,
  );
  const n = w.node(KEY_A, { cardKeyReady: check });
  n.card = await signedWith(0);
  w.listOn(n);
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  await settle();
  expect(events).toEqual(['plc update', 'card put, named key']);
  // The card key moves to generation 1 in the same process: the same check, asked again.
  generation = 1;
  n.card = await signedWith(1);
  await w.step(n);
  await settle();
  expect(events).toEqual(['plc update', 'card put, named key', 'plc update', 'card put, named key']);
  expect(await verifiesUnder(w.repo.card()?.card as string, deriveP256SigningKey(SEED, 1).publicKey)).toBe(true);
  expect(await verifiesUnder(w.repo.card()?.card as string, plc.cardKey())).toBe(true);
  // A key the check has confirmed is not looked up again, and nothing more is posted.
  const reads = plc.gets;
  expect(await check()).toBe(true);
  expect(plc.gets).toBe(reads);
  expect(events.filter((e) => e === 'plc update')).toHaveLength(2);
});

// Control for the two tests above: the watch on each card put does see a card signed by a key the document does not name.
it('a key check that does not follow the card key lets the new card out under a key the document does not name', async () => {
  const n = w.node(KEY_A, { cardKeyReady: keyCheckFor(0) });
  n.card = await signedWith(0);
  w.listOn(n);
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  n.card = await signedWith(1);
  await w.step(n);
  await settle();
  expect(events).toEqual(['plc update', 'card put, named key', 'card put, key not in the document']);
});

// Plan E151
it('a PLC directory that refuses the update keeps the card back; once it accepts, after the retry delay, the card goes out', async () => {
  plc.refuse = true;
  const n = w.node(KEY_A, { cardKeyReady: keyCheckFor(0) });
  n.card = await signedWith(0);
  w.listOn(n);
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  expect(w.repo.card()).toBeNull();
  expect(w.repo.fence()).not.toBeNull();
  plc.refuse = false;
  await w.step(n);
  expect(w.repo.card()).toBeNull(); // the retry delay has not passed
  w.clock += PUBLISH_RETRY_DELAYS_MS[0];
  await w.step(n);
  await settle();
  expect(events).toEqual(['plc update', 'card put, named key']);
});
