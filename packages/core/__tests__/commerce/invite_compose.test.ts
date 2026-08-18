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

import { composeInviteService, installInviteService } from '../../src/commerce/invite_compose';
import { InMemoryInviteRepository } from '../../src/commerce/invite_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { getContact, resetContactDirectory } from '../../src/contacts/directory';
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
    const { inviteRecordDigest } = jest.requireActual<typeof import('@dina/commerce-protocol')>(
      '@dina/commerce-protocol',
    );
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
});
