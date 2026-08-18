/**
 * §8 invite messages: digest chaining, the offer's embedded signature
 * seam, tamper detection, and the paste-string codec. The state machine
 * lives in core; here the SHAPES are the contract.
 */

import { createHash, randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';

import {
  decodeInviteCode,
  encodeInviteCode,
  INVITE_CODE_PREFIX,
  inviteOfferSigningBytes,
  inviteRecordDigest,
  validateInviteActivationAck,
  validateInviteConfirmation,
  validateInviteOffer,
  validateInviteRedemption,
  validateInviteRevocationNotice,
  type InviteOffer,
  type Sha256Fn,
} from '../src/index';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

const INVITER_PRIV = new Uint8Array(randomBytes(32));
const INVITER_PUB = ed25519.getPublicKey(INVITER_PRIV);

export function makeOffer(overrides: Partial<InviteOffer> = {}): InviteOffer {
  const draft = {
    protocol_version: '1.0',
    offer_id: 'inv-1',
    inviter_did: 'did:plc:distributor00000000000000',
    relay_url: 'wss://msgbox.example.dev',
    direction: 'you_supply_me' as const,
    service_rkeys: ['self'],
    capabilities: ['com.dinakernel.commerce.request_quote', 'com.dinakernel.commerce.submit_order'],
    nonce: 'a'.repeat(64),
    expires_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
  const offer_digest = inviteRecordDigest('invite_offer', draft, hash);
  const inviter_signature = Buffer.from(
    ed25519.sign(inviteOfferSigningBytes(offer_digest), INVITER_PRIV),
  ).toString('hex');
  return { ...draft, offer_digest, inviter_signature } as InviteOffer;
}

describe('the offer', () => {
  it('validates, and its embedded signature verifies over the digest preimage', () => {
    const offer = makeOffer();
    expect(validateInviteOffer(offer, hash)).toBeNull();
    expect(
      ed25519.verify(
        Buffer.from(offer.inviter_signature, 'hex'),
        inviteOfferSigningBytes(offer.offer_digest),
        INVITER_PUB,
      ),
    ).toBe(true);
  });

  it('a tampered field breaks the digest; a swapped digest breaks the signature', () => {
    const offer = makeOffer();
    expect(
      validateInviteOffer({ ...offer, direction: 'i_supply_you' }, hash),
    ).toContain('does not match');
    // Re-digested but not re-signed: the shape passes, the signature fails.
    const redirected = makeOffer({ direction: 'i_supply_you' });
    const franken = { ...redirected, inviter_signature: offer.inviter_signature };
    expect(validateInviteOffer(franken, hash)).toBeNull();
    expect(
      ed25519.verify(
        Buffer.from(franken.inviter_signature, 'hex'),
        inviteOfferSigningBytes(franken.offer_digest),
        INVITER_PUB,
      ),
    ).toBe(false);
  });

  it('refuses malformed shapes by name', () => {
    expect(validateInviteOffer({ ...makeOffer(), relay_url: 'https://x' }, hash)).toContain(
      'relay_url',
    );
    expect(validateInviteOffer({ ...makeOffer(), service_rkeys: [] }, hash)).toContain('rkey');
    expect(validateInviteOffer({ ...makeOffer(), capabilities: [] }, hash)).toContain(
      'capabilities',
    );
    expect(validateInviteOffer({ ...makeOffer(), nonce: 'short' }, hash)).toContain('nonce');
  });
});

describe('the chain', () => {
  it('each message pins its predecessor and the nonce; digests recompute', () => {
    const offer = makeOffer();
    const redemptionDraft = {
      protocol_version: '1.0',
      redemption_id: 'red-1',
      offer_digest: offer.offer_digest,
      nonce: offer.nonce,
      redeemer_did: 'did:plc:vendor0000000000000000000',
      service_rkeys: ['self'],
      redeemed_at: '2026-08-18T10:00:00.000Z',
    };
    const redemption = {
      ...redemptionDraft,
      redemption_digest: inviteRecordDigest('invite_redemption', redemptionDraft, hash),
    };
    expect(validateInviteRedemption(redemption, hash)).toBeNull();

    const confirmationDraft = {
      protocol_version: '1.0',
      confirmation_id: 'conf-1',
      redemption_digest: redemption.redemption_digest,
      nonce: offer.nonce,
      confirmed_at: '2026-08-18T10:01:00.000Z',
    };
    const confirmation = {
      ...confirmationDraft,
      confirmation_digest: inviteRecordDigest('invite_confirmation', confirmationDraft, hash),
    };
    expect(validateInviteConfirmation(confirmation, hash)).toBeNull();

    const ackDraft = {
      protocol_version: '1.0',
      ack_id: 'ack-1',
      confirmation_digest: confirmation.confirmation_digest,
      nonce: offer.nonce,
      activated_at: '2026-08-18T10:02:00.000Z',
    };
    const ack = { ...ackDraft, ack_digest: inviteRecordDigest('invite_activation_ack', ackDraft, hash) };
    expect(validateInviteActivationAck(ack, hash)).toBeNull();

    // Tampering with any link is caught by the digest on that message.
    expect(
      validateInviteRedemption({ ...redemption, nonce: 'b'.repeat(64) }, hash),
    ).toContain('does not match');
  });

  it('a revocation notice validates with its pinned reasons', () => {
    const draft = {
      protocol_version: '1.0',
      revocation_id: 'rev-1',
      nonce: 'a'.repeat(64),
      reason: 'no_activation_proof' as const,
      revoked_at: '2026-08-20T10:00:00.000Z',
    };
    const notice = {
      ...draft,
      revocation_digest: inviteRecordDigest('invite_revocation', draft, hash),
    };
    expect(validateInviteRevocationNotice(notice, hash)).toBeNull();
    expect(
      validateInviteRevocationNotice({ ...notice, reason: 'bored' }, hash),
    ).toContain('reason');
  });
});

describe('the paste string', () => {
  it('round-trips, validates on decode, and never collides with the pairing prefix', () => {
    const offer = makeOffer();
    const code = encodeInviteCode(offer);
    expect(code.startsWith(INVITE_CODE_PREFIX)).toBe(true);
    expect(code.startsWith('dina1:')).toBe(false);
    const decoded = decodeInviteCode(code, hash);
    if ('error' in decoded) throw new Error(decoded.error);
    expect(decoded.offer).toEqual(offer);
  });

  it('refuses garbage, wrong prefixes, and tampered payloads', () => {
    expect('error' in decodeInviteCode('dina1:AAAA', hash)).toBe(true);
    expect('error' in decodeInviteCode(`${INVITE_CODE_PREFIX}!!!!`, hash)).toBe(true);
    const offer = makeOffer();
    const tampered = encodeInviteCode({ ...offer, direction: 'i_supply_you' });
    const decoded = decodeInviteCode(tampered, hash);
    expect('error' in decoded && decoded.error).toContain('does not match');
  });
});
