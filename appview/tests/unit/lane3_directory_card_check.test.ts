/**
 * The directory's card check (design §8.3), the rules the first test run
 * proved only with throwaway probes: the 128 KB cap at its edge, canonical
 * member order, U+0000 in member names, which signatures count, the rkey
 * grammar, the envelope's binding to this record, and which DID document
 * keys count. Real ES256 cards and Ed25519 envelopes; nothing is mocked.
 */

import { createHash, sign as nodeSign } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  A2A_CARD_COLLECTION,
  base64Encode,
  canonicalize,
  cardStringHash,
  signAgentCard,
  type JsonValue,
} from '@dina/a2a'

import { A2A_CARD_MAX_BYTES, publisherKeysFromDidDocument, verifyA2ACardRecord } from '@/shared/a2a/card-verify.js'

import { cardRecord, didDocument, newDid, newKeys, type CardOptions, type Keys } from '../a2a-fixture.js'

const sha256 = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest()

async function check(did: string, keys: Keys, record: unknown, doc: unknown = didDocument(did, keys)) {
  return verifyA2ACardRecord({
    repoDid: did,
    collection: A2A_CARD_COLLECTION,
    rkey: 'self',
    record,
    keys: publisherKeysFromDidDocument(doc, did),
  })
}
const reasonOf = (v: Awaited<ReturnType<typeof check>>) => (v.ok ? 'ok' : v.reason)

/** The card a record carries, parsed, with its signatures taken off. */
function unsignedCardOf(record: Record<string, unknown>): Record<string, unknown> {
  const card = JSON.parse(record.card as string) as Record<string, unknown>
  delete card.signatures
  return card
}

/** An ES256 signature over `card` by `signer`'s card key, under the given header. */
async function es256(card: Record<string, unknown>, signer: Keys, header: { kid: string; jku?: string } = { kid: 'card-key' }) {
  return signAgentCard(card, { alg: 'ES256', ...header }, (input) =>
    nodeSign('sha256', input, { key: signer.p256.privateKey, dsaEncoding: 'ieee-p1363' }),
  )
}

/** A record whose card carries exactly these signatures (the envelope signed over the result). */
async function withSignatures(did: string, keys: Keys, sigs: unknown[], o: CardOptions = {}) {
  return cardRecord(did, keys, { ...o, tamper: (c) => (c.signatures = sigs) })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the 128 KB cap, at its edge', () => {
  // Plan F43
  it('a card of exactly 128 KB is indexed; one byte more is refused', async () => {
    const did = newDid()
    const keys = newKeys()
    // ES256 signatures are a fixed 64 bytes, so the card's size depends only on its content.
    const probe = await cardRecord(did, keys, { description: 'd' })
    const room = A2A_CARD_MAX_BYTES - Buffer.byteLength(probe.card as string, 'utf8')
    const atCap = await cardRecord(did, keys, { description: 'd'.repeat(1 + room) })
    expect(Buffer.byteLength(atCap.card as string, 'utf8')).toBe(A2A_CARD_MAX_BYTES)
    expect(reasonOf(await check(did, keys, atCap))).toBe('ok')
    const over = await cardRecord(did, keys, { description: 'd'.repeat(2 + room) })
    expect(Buffer.byteLength(over.card as string, 'utf8')).toBe(A2A_CARD_MAX_BYTES + 1)
    expect(reasonOf(await check(did, keys, over))).toBe('card_too_large')
  })
})

describe('the card string is its own canonical form', () => {
  // Plan F45
  it('a card whose members are in another order is refused, even with no whitespace', async () => {
    const did = newDid()
    const keys = newKeys()
    const record = await cardRecord(did, keys)
    const card = JSON.parse(record.card as string) as Record<string, unknown>
    const reversed: Record<string, unknown> = {}
    for (const key of Object.keys(card).reverse()) reversed[key] = card[key]
    const text = JSON.stringify(reversed)
    expect(text).not.toBe(record.card)
    expect(text).not.toMatch(/\s"|":\s/)
    expect(reasonOf(await check(did, keys, { ...record, card: text }))).toBe('card_not_canonical')
  })

  // Plan F46
  it.each([
    ['a top-level member name', (c: Record<string, unknown>) => (c['x\u0000y'] = 'v')],
    ['a nested member name', (c: Record<string, unknown>) => ((c.capabilities as Record<string, unknown>)['flag\u0000'] = true)],
  ])('U+0000 in %s is refused, as it is in a string', async (_where, tamper) => {
    const did = newDid()
    const keys = newKeys()
    const record = await cardRecord(did, keys, { tamper })
    expect(record.card as string).toContain('\\u0000')
    expect(reasonOf(await check(did, keys, record))).toBe('card_nul_character')
  })
})

describe('the card signature: ES256 against #a2a_card, nothing else', () => {
  // Plan F49
  it('an EdDSA signature by the publisher’s own dina_signing key does not count for the card key', async () => {
    const did = newDid()
    const keys = newKeys()
    const card = unsignedCardOf(await cardRecord(did, keys))
    const eddsa = await signAgentCard(card, { alg: 'EdDSA', kid: 'dina_signing' }, (input) => nodeSign(null, input, keys.ed.privateKey))
    const record = await withSignatures(did, keys, [eddsa])
    expect(reasonOf(await check(did, keys, record))).toBe('card_signature')
  })

  // Plan F49
  it('a URL the card names for its key set is never fetched: a foreign key named by a jku URL is refused', async () => {
    const did = newDid()
    const keys = newKeys()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    const card = unsignedCardOf(await cardRecord(did, keys))
    const foreign = await es256(card, newKeys(), { kid: 'card-key', jku: 'https://evil.example/.well-known/jwks.json' })
    expect(reasonOf(await check(did, keys, await withSignatures(did, keys, [foreign])))).toBe('card_signature')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Plan F50
  it.each([
    ['first', true],
    ['last', false],
  ])('several signatures with one valid (%s) verify the card', async (_where, validFirst) => {
    const did = newDid()
    const keys = newKeys()
    const card = unsignedCardOf(await cardRecord(did, keys))
    const valid = await es256(card, keys)
    const foreign = await es256(card, newKeys(), { kid: 'other-key' })
    const record = await withSignatures(did, keys, validFirst ? [valid, foreign] : [foreign, valid])
    const v = await check(did, keys, record)
    expect(reasonOf(v)).toBe('ok')
    expect(v.ok && v.card.cardText).toBe(record.card)
  })

  // Plan F50
  it('several signatures with none valid are refused', async () => {
    const did = newDid()
    const keys = newKeys()
    const card = unsignedCardOf(await cardRecord(did, keys))
    const record = await withSignatures(did, keys, [await es256(card, newKeys()), await es256(card, newKeys(), { kid: 'k2' })])
    expect(reasonOf(await check(did, keys, record))).toBe('card_signature')
  })
})

describe('skills: capability@rkey with the listing-rkey grammar', () => {
  // Plan F54
  it.each(['eta_query@.', 'eta_query@..', 'eta_query@has space', 'eta_query@a/b', 'eta_query@a#b', 'Eta_query@shop', 'eta_query@@shop'])(
    '%s is malformed and refused',
    async (skill) => {
      const did = newDid()
      const keys = newKeys()
      expect(reasonOf(await check(did, keys, await cardRecord(did, keys, { skills: [skill] })))).toBe('skill_malformed')
    },
  )

  // Plan F54
  it('the rkey grammar’s full charset is a well-formed skill', async () => {
    const did = newDid()
    const keys = newKeys()
    const v = await check(did, keys, await cardRecord(did, keys, { skills: ['eta_query@Route-42_a.b~c'] }))
    expect(v.ok && v.card.skills).toEqual([{ id: 'eta_query@Route-42_a.b~c', canonical: 'eta_query' }])
  })
})

describe('the envelope is bound to this record', () => {
  /** An envelope with these fields, signed by the publisher's dina_signing key over its canonical form. */
  function signedEnvelope(keys: Keys, fields: Record<string, unknown>): Record<string, unknown> {
    const unsigned = { v: 1, domain: 'dina:a2a:directory-envelope:v1', ...fields }
    const sig = nodeSign(null, Buffer.from(canonicalize(unsigned as JsonValue), 'utf8'), keys.ed.privateKey)
    return { ...unsigned, sig: base64Encode(new Uint8Array(sig)) }
  }

  // Plan F62
  it.each([
    ['another collection', { collection: 'com.dinakernel.a2a.fence' }, 'envelope_collection'],
    ['another rkey', { rkey: 'other' }, 'envelope_rkey'],
  ])('an envelope signed by the right key for %s is refused', async (_name, over, reason) => {
    const did = newDid()
    const keys = newKeys()
    const record = await cardRecord(did, keys)
    const env = record.directory_envelope as Record<string, unknown>
    const fields = {
      did,
      collection: A2A_CARD_COLLECTION,
      rkey: 'self',
      card_hash: cardStringHash(record.card as string, sha256),
      freshness_epoch: env.freshness_epoch,
      publisher_epoch: env.publisher_epoch,
      publisher_instance: env.publisher_instance,
    }
    // The same construction for this record verifies: only the binding refuses the other.
    expect(reasonOf(await check(did, keys, { ...record, directory_envelope: signedEnvelope(keys, fields) }))).toBe('ok')
    const forged = signedEnvelope(keys, { ...fields, ...over })
    expect(reasonOf(await check(did, keys, { ...record, directory_envelope: forged }))).toBe(reason)
  })

  // Plan F64
  it('a malleated envelope signature (S + L, the same point) is refused by AppView’s own Ed25519 check; the original verifies', async () => {
    const did = newDid()
    const keys = newKeys()
    const record = await cardRecord(did, keys)
    const env = record.directory_envelope as Record<string, unknown>
    expect(reasonOf(await check(did, keys, record))).toBe('ok')
    const sig = Buffer.from(env.sig as string, 'base64')
    expect(sig).toHaveLength(64)
    // S is bytes 32..63, little-endian. S + L gives the same point, so a check that skips S < L takes it.
    const L = 2n ** 252n + 27742317777372353535851937790883648493n
    let s = 0n
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i] as number)
    let rest = s + L
    const malleated = Buffer.from(sig)
    for (let i = 32; i < 64; i++) {
      malleated[i] = Number(rest & 0xffn)
      rest >>= 8n
    }
    // S + L still fits in 32 bytes, so only the S < L rule refuses it.
    expect(rest).toBe(0n)
    expect(malleated.equals(sig)).toBe(false)
    expect(reasonOf(await check(did, keys, { ...record, directory_envelope: { ...env, sig: malleated.toString('base64') } }))).toBe(
      'envelope_signature',
    )
  })
})

describe('keys come from the publisher’s own DID document', () => {
  // Plan F65
  it('a verification method named under another DID’s fragment gives no key', async () => {
    const did = newDid()
    const keys = newKeys()
    const other = newDid()
    const doc = didDocument(did, keys)
    for (const vm of doc.verificationMethod) vm.id = `${other}#${String(vm.id).split('#')[1]}`
    expect(publisherKeysFromDidDocument(doc, did)).toEqual({ dinaSigning: null, cardKey: null })
    expect(reasonOf(await check(did, keys, await cardRecord(did, keys), doc))).toBe('card_key_missing')
  })
})
