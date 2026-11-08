/**
 * Tearing down an invite exchange leaves nothing half done
 * (docs/STATE_MACHINES.md COM-7, COM-14).
 */

import { createHash, randomBytes } from 'node:crypto';

import { inviteRecordDigest } from '@dina/commerce-protocol';
import { ed25519 } from '@noble/curves/ed25519.js';

import {
  DEFAULT_INVITE_TTL_MS,
  InviteService,
  type InviteServiceDeps,
} from '../../src/commerce/invite_service';
import { InMemoryInviteRepository } from '../../src/commerce/invite_store';

const sha = (d: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(d).digest());
const INVITER = 'did:plc:inviter';
const REDEEMER = 'did:plc:redeemer';

interface TestNode {
  service: InviteService;
  repo: InMemoryInviteRepository;
  contacts: Set<string>;
  grants: unknown[];
  revoked: string[];
  pub: Uint8Array;
}

function makeNode(
  did: string,
  clock: { now: number },
  send: (to: string, body: { kind: string }) => Promise<boolean>,
  signerPub?: () => Uint8Array,
): TestNode {
  const repo = new InMemoryInviteRepository();
  const contacts = new Set<string>();
  const grants: unknown[] = [];
  const revoked: string[] = [];
  const priv = new Uint8Array(randomBytes(32));
  const pub = ed25519.getPublicKey(priv);
  const service = new InviteService({
    invites: repo,
    nodeDid: () => did,
    now: () => clock.now,
    relayUrl: () => 'wss://r',
    signOfferDigest: (b: Uint8Array) => ed25519.sign(b, priv),
    resolveSigningKey: async () => signerPub?.() ?? pub,
    verify: (m: Uint8Array, s: Uint8Array, k: Uint8Array) => ed25519.verify(s, m, k),
    writeContact: (d: string) => {
      const created = !contacts.has(d);
      contacts.add(d);
      return created;
    },
    removeContact: (d: string) => {
      contacts.delete(d);
    },
    writeGrants: (a: unknown) => {
      grants.push(a);
    },
    revokeGrants: (a: { inviteNonce: string }) => {
      revoked.push(a.inviteNonce);
    },
    send,
    hasPublishedCatalog: () => true,
    acceptColdInvites: () => true,
    notifyColdOffer: () => undefined,
  } as unknown as InviteServiceDeps);
  return { service, repo, contacts, grants, revoked, pub };
}

/** Run one exchange up to the point the inviter holds the redeemer's ack. */
async function toAck(inviter: TestNode, redeemer: TestNode): Promise<{ nonce: string; ack: unknown }> {
  const minted = inviter.service.mintOffer({
    direction: 'i_supply_you',
    serviceRkeys: ['self'],
    capabilities: ['c'],
  } as never) as { value: { code: string; offer: { nonce: string } } };
  const redeemed = (await redeemer.service.redeemCode({
    code: minted.value.code,
    serviceRkeys: ['self'],
  } as never)) as { ok: boolean; refusal?: string; value: { redemption: unknown } };
  if (!redeemed.ok) throw new Error(`redeem: ${String(redeemed.refusal)}`);
  const confirmed = (await inviter.service.applyInboundRedemption({
    senderDid: REDEEMER,
    body: redeemed.value.redemption,
  } as never)) as { value: { confirmation: unknown } };
  const acked = (await redeemer.service.applyInboundConfirmation({
    senderDid: INVITER,
    body: confirmed.value.confirmation,
  } as never)) as { value: { ack: unknown } };
  return { nonce: minted.value.offer.nonce, ack: acked.value.ack };
}

function revocationOf(nonce: string, now: number): Record<string, unknown> {
  const draft = {
    protocol_version: '1.0',
    revocation_id: `rev_${nonce.slice(0, 8)}`,
    nonce,
    reason: 'expired',
    revoked_at: new Date(now).toISOString(),
  };
  return { ...draft, revocation_digest: inviteRecordDigest('invite_revocation', draft as never, sha) };
}

describe('COM-7: the sweep and a late ack', () => {
  it('an activation during the sweep send is undone with the exchange, never half kept', async () => {
    const clock = { now: 1_800_000_000_000 };
    let release: (() => void) | null = null;
    let holding = false;
    let inviter!: TestNode;
    inviter = makeNode(INVITER, clock, async (_to, body) => {
      if (holding && body.kind === 'revocation') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return true;
    });
    const redeemer = makeNode(REDEEMER, clock, async () => true, () => inviter.pub);
    const { nonce, ack } = await toAck(inviter, redeemer);

    clock.now += DEFAULT_INVITE_TTL_MS + 1;
    holding = true;
    const sweep = inviter.service.sweep();
    await new Promise((resolve) => setImmediate(resolve));

    holding = false;
    const applied = (await inviter.service.applyInboundActivationAck({
      senderDid: REDEEMER,
      body: ack,
    } as never)) as { ok: boolean };
    expect(applied.ok).toBe(true);
    expect(inviter.repo.get(nonce)?.state).toBe('active');
    expect(inviter.grants).toHaveLength(1);

    (release as unknown as () => void)();
    await sweep;
    expect(inviter.repo.get(nonce)?.state).toBe('revoked');
    expect(inviter.revoked).toEqual([nonce]);
    expect(inviter.contacts.has(REDEEMER)).toBe(false);
  });

  it('a row already revoked while the send was out stays as it is', async () => {
    const clock = { now: 1_800_000_000_000 };
    let release: (() => void) | null = null;
    let holding = false;
    let inviter!: TestNode;
    inviter = makeNode(INVITER, clock, async (_to, body) => {
      if (holding && body.kind === 'revocation') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return true;
    });
    const redeemer = makeNode(REDEEMER, clock, async () => true, () => inviter.pub);
    const { nonce } = await toAck(inviter, redeemer);
    clock.now += DEFAULT_INVITE_TTL_MS + 1;
    holding = true;
    const sweep = inviter.service.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    holding = false;
    const row = inviter.repo.get(nonce);
    if (row === null) throw new Error('no row');
    inviter.repo.put({ ...row, state: 'revoked', updatedAt: 42 });
    (release as unknown as () => void)();
    const result = await sweep;
    expect(result.revoked).toBe(0);
    expect(inviter.repo.get(nonce)?.updatedAt).toBe(42);
  });
});

describe('COM-14: a second exchange with the same counterparty', () => {
  async function twoActive(): Promise<{ inviter: TestNode; first: string; second: string; clock: { now: number } }> {
    const clock = { now: 1_800_000_000_000 };
    let inviter!: TestNode;
    inviter = makeNode(INVITER, clock, async () => true);
    const redeemer = makeNode(REDEEMER, clock, async () => true, () => inviter.pub);
    const run = async (): Promise<string> => {
      const { nonce, ack } = await toAck(inviter, redeemer);
      await inviter.service.applyInboundActivationAck({ senderDid: REDEEMER, body: ack } as never);
      return nonce;
    };
    return { inviter, first: await run(), second: await run(), clock };
  }
  const revoke = (inviter: TestNode, nonce: string, now: number): void => {
    const out = inviter.service.applyInboundRevocation({
      senderDid: REDEEMER,
      body: revocationOf(nonce, now),
    } as never) as { ok: boolean };
    expect(out.ok).toBe(true);
  };

  it('ending the one that made the contact keeps it while the other stands', async () => {
    const { inviter, first, second, clock } = await twoActive();
    revoke(inviter, first, clock.now);
    expect(inviter.repo.get(second)?.state).toBe('active');
    expect(inviter.contacts.has(REDEEMER)).toBe(true);
    expect(inviter.revoked).toEqual([first]);
  });

  it('ending the last one removes the contact the first one made', async () => {
    const { inviter, first, second, clock } = await twoActive();
    revoke(inviter, first, clock.now);
    revoke(inviter, second, clock.now);
    expect(inviter.contacts.has(REDEEMER)).toBe(false);
  });

  it('a contact there before any exchange stays when they all end', async () => {
    const { inviter, first, second, clock } = await twoActive();
    // As if the contact predated both: neither exchange made it.
    const a = inviter.repo.get(first);
    if (a === null) throw new Error('no row');
    inviter.repo.put({ ...a, createdContact: false });
    revoke(inviter, first, clock.now);
    revoke(inviter, second, clock.now);
    expect(inviter.contacts.has(REDEEMER)).toBe(true);
  });
});
