/**
 * The reference SDK's card form (a2a-sdk 1.2.1). It signs and verifies a
 * card over a form of its own, which drops every empty value and every
 * member its proto does not know; §8.4.1 keeps both. The vectors below were
 * made by the SDK itself (`card_forms.py vectors`, beside the reference
 * agent), so these tests hold Dina to what the SDK does, not to a copy of
 * its code: Dina computes the SDK's payload byte for byte, accepts a card
 * the SDK signed, and signs its own card so the SDK's verifier accepts it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { p256 } from '@noble/curves/nist.js';

import {
  base64urlDecode,
  base64urlEncodeUtf8,
  cardPinText,
  cardSdkSigningPayload,
  cardSigningForms,
  cardSigningPayload,
  signAgentCard,
  utf8Bytes,
  verifyAgentCardSignatures,
  type JwsVerifyFn,
} from '../src';

import { dinaProjectedCard } from './fixtures/dina_card';

interface Vectors {
  cards: { name: string; card: Record<string, unknown>; sdk_payload: string }[];
  signed: {
    jwks: { keys: { kid: string; x: string; y: string }[] };
    cards: Record<'bearer_requirement' | 'dual_version', Record<string, unknown>>;
  };
}

const VECTORS = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'a2a_sdk_card_forms.json'), 'utf8'),
) as Vectors;
const cardNamed = (name: string) => {
  const found = VECTORS.cards.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
};

/** The SDK's JWKS key as an uncompressed P-256 point. */
function publicKeyOf(kid: string): Uint8Array {
  const jwk = VECTORS.signed.jwks.keys.find((k) => k.kid === kid);
  if (jwk === undefined) throw new Error(`no key ${kid}`);
  const x = base64urlDecode(jwk.x);
  const y = base64urlDecode(jwk.y);
  if (x === null || y === null) throw new Error('bad jwk');
  return new Uint8Array([4, ...x, ...y]);
}

/** Verifies against the SDK's key set; JWS never normalizes S, so a high-S signature counts. */
const sdkKeys: JwsVerifyFn = ({ header, signingInputs, signature }) =>
  signingInputs.some((input) => p256.verify(signature, input, publicKeyOf(header.kid), { lowS: false }));

/** Whether one signature verifies over one payload, as any JWS verifier checks it. */
function verifiesOver(sig: { protected: string; signature: string }, payload: string, key: Uint8Array): boolean {
  const signature = base64urlDecode(sig.signature);
  if (signature === null) return false;
  return p256.verify(signature, utf8Bytes(`${sig.protected}.${base64urlEncodeUtf8(payload)}`), key, { lowS: false });
}

describe('Dina computes the SDK’s payload byte for byte', () => {
  // Cold audit C5-1: the vector is the card Dina projects, so a projection that moved must regenerate it.
  it('the dina_projected vector is the card Dina projects today (if not: regenerate, see fixtures/dina_card.ts)', () => {
    expect(cardNamed('dina_projected').card).toEqual(JSON.parse(JSON.stringify(dinaProjectedCard())));
  });

  it.each(VECTORS.cards.map((c) => [c.name, c] as const))('%s', (_name, vector) => {
    expect(cardSdkSigningPayload(vector.card)).toBe(vector.sdk_payload);
  });

  it('the two forms differ exactly where the SDK drops something: empties and unknown members', () => {
    const differs = VECTORS.cards.map((c) => [c.name, cardSigningPayload(c.card) !== c.sdk_payload]);
    expect(differs).toEqual([
      ['dina_projected', true],
      ['bearer_requirement', true],
      ['empties', true],
      ['unknown_members', true],
      ['plain', false],
    ]);
  });
});

describe('a card the SDK signed verifies here', () => {
  it.each(['bearer_requirement', 'dual_version'] as const)('%s', async (name) => {
    const card = VECTORS.signed.cards[name];
    const [sig] = card.signatures as { protected: string; signature: string }[];
    if (sig === undefined) throw new Error('unsigned vector');
    // Control: the signature covers the SDK's form only, so §8.4.1's alone would read it invalid.
    expect(verifiesOver(sig, cardSigningPayload(card), publicKeyOf('sdk-test-key'))).toBe(false);
    expect(verifiesOver(sig, cardSdkSigningPayload(card), publicKeyOf('sdk-test-key'))).toBe(true);
    expect(await verifyAgentCardSignatures(card, sdkKeys)).toEqual({
      state: 'verified',
      verifiedKids: ['sdk-test-key'],
      verifiedSigners: ['https://agent.example/jwks.json#sdk-test-key'],
    });
  });

  it('a change the SDK form does not cover keeps the signature, and still changes the pin', async () => {
    const card = VECTORS.signed.cards.bearer_requirement;
    const changed = { ...card, x_note: 'added after signing' };
    const signers = ['https://agent.example/jwks.json#sdk-test-key'];
    expect((await verifyAgentCardSignatures(changed, sdkKeys)).state).toBe('verified');
    expect(cardPinText(changed, signers)).not.toBe(cardPinText(card, signers));
  });

  it('a change the SDK form covers breaks the signature', async () => {
    const card = VECTORS.signed.cards.bearer_requirement;
    expect((await verifyAgentCardSignatures({ ...card, name: 'Another agent' }, sdkKeys)).state).toBe('invalid');
  });
});

describe('Dina signs its card so the SDK’s verifier accepts it', () => {
  const secret = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(secret, false);
  const header = { alg: 'ES256' as const, kid: 'dina-key', jku: 'https://dina.example/jwks.json' };
  const sign = (input: Uint8Array) => p256.sign(input, secret);

  it('Dina’s projected card gets one signature per form; the second covers the SDK’s own payload', async () => {
    const vector = cardNamed('dina_projected');
    expect(cardSigningForms(vector.card)).toEqual(['spec', 'a2a_sdk']);
    const sigs = await Promise.all(cardSigningForms(vector.card).map((form) => signAgentCard(vector.card, header, sign, form)));
    const [spec, sdk] = sigs;
    if (spec === undefined || sdk === undefined) throw new Error('two signatures expected');
    expect(verifiesOver(spec, cardSigningPayload(vector.card), publicKey)).toBe(true);
    // The bytes the SDK's verifier checks, as the SDK computed them.
    expect(verifiesOver(sdk, vector.sdk_payload, publicKey)).toBe(true);
    expect(verifiesOver(spec, vector.sdk_payload, publicKey)).toBe(false);
  });

  it('a card whose forms coincide gets one signature', () => {
    expect(cardSigningForms(cardNamed('plain').card)).toEqual(['spec']);
  });
});
