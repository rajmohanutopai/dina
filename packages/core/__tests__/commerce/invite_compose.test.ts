/**
 * The invite COMPOSE seams — the wiring the service tests inject past.
 * The live bug this file exists for: `writeContact` once called
 * `addContact` from `d2d/gates` (the in-RAM egress allowlist) instead
 * of the contacts DIRECTORY of the same function name, so a completed
 * ceremony produced a relationship that never reached `/v1/contacts`
 * and vanished on reboot. The compose must write the durable row AND
 * leave the egress gate open for the counterparty.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';

import { applyMigrations, IDENTITY_MIGRATIONS } from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  composeInviteService,
  installInviteService,
  inviteGrantPrefix,
} from '../../src/commerce/invite_compose';
import { InMemoryInviteRepository } from '../../src/commerce/invite_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { addContact, getContact, resetContactDirectory } from '../../src/contacts/directory';
import { setContactRepository, SQLiteContactRepository } from '../../src/contacts/repository';
import { checkContactGate, clearGateContacts } from '../../src/d2d/gates';
import { setPeopleRepository, SQLitePeopleRepository } from '../../src/people/repository';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import {
  setServiceGrantRepository,
  SQLiteServiceGrantRepository,
} from '../../src/service/service_grant_repository';

const INVITER = 'did:plc:invitecomposeinviter000000';
const REDEEMER = 'did:plc:invitecomposeredeemer0000';
const T0 = 1_800_000_000_000;

describe('composeInviteService — the contact seam is the DIRECTORY', () => {
  let adapter: NodeSQLiteAdapter;
  let dbDir = '';

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-invite-compose-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dbDir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
  });

  afterAll(() => {
    try {
      adapter.close();
    } catch {
      /* idempotent */
    }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    setPeopleRepository(new SQLitePeopleRepository(adapter));
    setContactRepository(new SQLiteContactRepository(adapter));
    resetContactDirectory();
    clearGateContacts();
    setServiceGrantRepository(new SQLiteServiceGrantRepository(adapter));
  });

  afterEach(() => {
    installInviteService(null);
    installCommerceRuntime(null);
    setD2DSender(null);
    setServiceGrantRepository(null);
    resetContactDirectory();
    setContactRepository(null);
    setPeopleRepository(null);
  });

  it('a completed redemption writes a DURABLE contact and opens the egress gate', async () => {
    const priv = new Uint8Array(randomBytes(32));
    const pub = ed25519.getPublicKey(priv);
    installCommerceRuntime({
      invites: new InMemoryInviteRepository(),
      nodeDid: () => REDEEMER,
      now: () => T0,
    } as unknown as CommerceRuntime);
    setD2DSender(async () => ({ sent: true, delivered: true }) as never);

    const redeemerService = composeInviteService({
      signOfferDigest: (bytes) => ed25519.sign(bytes, priv),
      resolveSigningKey: async () => pub,
      verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
      relayUrl: () => 'wss://relay.example.dev',
    });

    // Mint on a scratch INVITER service sharing the test key.
    const inviterService = composeInviteService({
      signOfferDigest: (bytes) => ed25519.sign(bytes, priv),
      resolveSigningKey: async () => pub,
      verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
      relayUrl: () => 'wss://relay.example.dev',
    });
    installCommerceRuntime({
      invites: new InMemoryInviteRepository(),
      nodeDid: () => INVITER,
      now: () => T0,
    } as unknown as CommerceRuntime);
    const minted = inviterService.mintOffer({
      direction: 'i_supply_you',
      serviceRkeys: ['self'],
      capabilities: ['com.dinakernel.commerce.request_quote'],
    });
    if (!minted.ok) throw new Error(minted.refusal);

    // Back to the REDEEMER node's runtime; redeem, then receive the
    // confirmation — the step that activates and writes the contact.
    installCommerceRuntime({
      invites: new InMemoryInviteRepository(),
      nodeDid: () => REDEEMER,
      now: () => T0,
    } as unknown as CommerceRuntime);
    installInviteService(redeemerService);
    const redeemed = await redeemerService.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['veg-stall'],
    });
    expect(redeemed.ok).toBe(true);

    const confirmationDraft = {
      protocol_version: '1.0',
      confirmation_id: 'cfm_compose_1',
      nonce: minted.value.offer.nonce,
      offer_digest: minted.value.offer.offer_digest,
      redemption_digest: redeemed.ok ? redeemed.value.redemption.redemption_digest : '',
      confirmed_at: '2027-01-15T08:00:00.000Z',
    };
    const { inviteRecordDigest } =
      jest.requireActual<typeof import('@dina/commerce-protocol')>('@dina/commerce-protocol');
    const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const confirmation = {
      ...confirmationDraft,
      confirmation_digest: inviteRecordDigest(
        'invite_confirmation',
        confirmationDraft,
        (data) => new Uint8Array(createHash('sha256').update(data).digest()),
      ),
    };
    const applied = await redeemerService.applyInboundConfirmation({
      senderDid: INVITER,
      body: confirmation,
    });
    expect(applied.ok).toBe(true);

    // THE claim: the durable directory has the row, egress is open, and
    // the level is one the inbound commerce.trade gate ADMITS — an
    // 'unknown'-trust activation is a relationship no khata document
    // can travel.
    const written = getContact(INVITER);
    expect(written).not.toBeNull();
    expect(written?.trustLevel).toBe('verified');
    expect(checkContactGate(INVITER)).toBe(true);
  });

  it("a revocation takes back only that exchange's grants, and keeps an older contact", async () => {
    const priv = new Uint8Array(randomBytes(32));
    const pub = ed25519.getPublicKey(priv);
    const deps = {
      signOfferDigest: (bytes: Uint8Array) => ed25519.sign(bytes, priv),
      resolveSigningKey: async () => pub,
      verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) =>
        ed25519.verify(signature, message, publicKey),
      relayUrl: () => 'wss://relay.example.dev',
    };
    setD2DSender(async () => ({ sent: true, delivered: true }) as never);

    // The inviter asks to be supplied, so THIS node (the redeemer) writes grants.
    installCommerceRuntime({
      invites: new InMemoryInviteRepository(),
      nodeDid: () => INVITER,
      now: () => T0,
    } as unknown as CommerceRuntime);
    const minted = composeInviteService(deps).mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: ['self'],
      capabilities: ['com.dinakernel.commerce.request_quote'],
    });
    if (!minted.ok) throw new Error(minted.refusal);

    installCommerceRuntime({
      invites: new InMemoryInviteRepository(),
      nodeDid: () => REDEEMER,
      now: () => T0,
    } as unknown as CommerceRuntime);
    const service = composeInviteService(deps);
    installInviteService(service);

    // Before the invite: the inviter is a contact, and holds a grant the owner gave.
    addContact(INVITER, 'Known before', 'trusted');
    const grants = new SQLiteServiceGrantRepository(adapter);
    grants.create({
      grantId: 'manual_grant_1',
      granteeDid: INVITER,
      serviceRkey: 'veg-stall',
      capability: 'com.dinakernel.commerce.request_quote',
      grantType: 'standing',
      createdAt: Math.floor(T0 / 1000),
    });

    const redeemed = await service.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['veg-stall'],
    });
    if (!redeemed.ok) throw new Error(redeemed.refusal);
    const { inviteRecordDigest } =
      jest.requireActual<typeof import('@dina/commerce-protocol')>('@dina/commerce-protocol');
    const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const digest = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());
    const confirmationDraft = {
      protocol_version: '1.0',
      confirmation_id: 'cfm_compose_2',
      nonce: minted.value.offer.nonce,
      offer_digest: minted.value.offer.offer_digest,
      redemption_digest: redeemed.value.redemption.redemption_digest,
      confirmed_at: '2027-01-15T08:00:00.000Z',
    };
    const confirmed = await service.applyInboundConfirmation({
      senderDid: INVITER,
      body: {
        ...confirmationDraft,
        confirmation_digest: inviteRecordDigest('invite_confirmation', confirmationDraft, digest),
      },
    });
    expect(confirmed.ok).toBe(true);
    const prefix = inviteGrantPrefix(minted.value.offer.nonce);
    expect(grants.listByGrantee(INVITER).filter((g) => g.grantId.startsWith(prefix))).toHaveLength(
      1,
    );

    const noticeDraft = {
      protocol_version: '1.0',
      revocation_id: 'rev_compose_1',
      nonce: minted.value.offer.nonce,
      reason: 'expired',
      revoked_at: '2027-01-16T08:00:00.000Z',
    };
    const revoked = service.applyInboundRevocation({
      senderDid: INVITER,
      body: {
        ...noticeDraft,
        revocation_digest: inviteRecordDigest('invite_revocation', noticeDraft, digest),
      },
    });
    expect(revoked.ok).toBe(true);

    const after = grants.listByGrantee(INVITER);
    expect(after.find((g) => g.grantId === 'manual_grant_1')?.revokedAt).toBeUndefined();
    expect(
      after.filter((g) => g.grantId.startsWith(prefix)).every((g) => g.revokedAt !== undefined),
    ).toBe(true);
    expect(getContact(INVITER)).not.toBeNull();
  });
});
