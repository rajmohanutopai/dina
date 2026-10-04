/**
 * The A2A directory's check of a published card record (design §8.3),
 * against real signatures: one refusal per rule, and what an accepted
 * record yields (derived from the verified card and envelope, never from
 * the record's convenience fields).
 */

import { describe, expect, it } from 'vitest'

import { A2A_CARD_COLLECTION, canonicalize, type JsonValue } from '@dina/a2a'

import {
  A2A_CARD_MAX_BYTES,
  publisherKeysFromDidDocument,
  verifyA2ACardRecord,
} from '@/shared/a2a/card-verify.js'

import { cardHashOf, cardRecord, didDocument, newDid, newKeys, type Keys } from '../a2a-fixture.js'

async function check(did: string, keys: Keys, record: unknown, over: { collection?: string; rkey?: string; doc?: unknown } = {}) {
  const doc = over.doc ?? didDocument(did, keys)
  return verifyA2ACardRecord({
    repoDid: did,
    collection: over.collection ?? A2A_CARD_COLLECTION,
    rkey: over.rkey ?? 'self',
    record,
    keys: publisherKeysFromDidDocument(doc, did),
  })
}

const reasonOf = (v: Awaited<ReturnType<typeof check>>) => (v.ok ? 'ok' : v.reason)

describe('an accepted record', () => {
  it('yields what the verified card and envelope say, and the hash of the exact bytes', async () => {
    const did = newDid()
    const keys = newKeys()
    const record = await cardRecord(did, keys, { skills: ['eta_query', 'price_check@shop'], freshnessEpoch: 3, publisherEpoch: 2 })
    const v = await check(did, keys, record)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.card).toEqual({
      cardText: record.card,
      cardHash: cardHashOf(record),
      endpoint: 'https://agent.example/a2a/v1',
      protocolVersion: '1.0',
      skills: [
        { id: 'eta_query', canonical: 'eta_query' },
        { id: 'price_check@shop', canonical: 'price_check' },
      ],
      displayName: 'Bus 42',
      description: 'Arrival times for the 42.',
      freshnessEpoch: 3,
      publisherEpoch: 2,
      publisherInstance: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('a skill named by an alias is indexed under its canonical name, its id kept exactly', async () => {
    const did = newDid()
    const keys = newKeys()
    const v = await check(did, keys, await cardRecord(did, keys, { skills: ['bus_eta'] }))
    expect(v.ok && v.card.skills).toEqual([{ id: 'bus_eta', canonical: 'eta_query' }])
  })

  it('reads the keys under either fragment form a DID document uses', async () => {
    const did = newDid()
    const keys = newKeys()
    const doc = didDocument(did, keys)
    for (const vm of doc.verificationMethod) vm.id = `#${String(vm.id).split('#')[1]}`
    expect((await check(did, keys, await cardRecord(did, keys), { doc })).ok).toBe(true)
  })
})

describe('refused, with the reason', () => {
  it.each<[string, (did: string, keys: Keys) => Promise<{ record: unknown; over?: Parameters<typeof check>[3] }>]>([
    ['collection', async (d, k) => ({ record: await cardRecord(d, k), over: { collection: 'com.dinakernel.a2a.other' } })],
    ['rkey_not_self', async (d, k) => ({ record: await cardRecord(d, k), over: { rkey: 'other' } })],
    ['record_not_object', async () => ({ record: 'card' })],
    ['record_members', async (d, k) => ({ record: await cardRecord(d, k, { tamperRecord: (r) => (r.extra = 1) }) })],
    ['card_not_string', async (d, k) => ({ record: await cardRecord(d, k, { tamperRecord: (r) => (r.card = { name: 'x' }) }) })],
    [
      'card_too_large',
      async (d, k) => ({ record: await cardRecord(d, k, { description: 'x'.repeat(A2A_CARD_MAX_BYTES) }) }),
    ],
    ['card_not_json', async (d, k) => ({ record: await cardRecord(d, k, { tamperRecord: (r) => (r.card = '{"a":1,"a":2}') }) })],
    [
      'card_not_canonical',
      async (d, k) => ({
        record: await cardRecord(d, k, { tamperRecord: (r) => (r.card = JSON.stringify(JSON.parse(r.card as string), null, 1)) }),
      }),
    ],
    ['card_nul_character', async (d, k) => ({ record: await cardRecord(d, k, { name: 'Bus\u000042' }) })],
    ['card_skills_required', async (d, k) => ({ record: await cardRecord(d, k, { skills: [] }) })],
    ['card_key_missing', async (d, k) => ({ record: await cardRecord(d, k), over: { doc: didDocument(d, k, { cardKey: null }) } })],
    ['card_signature', async (d, k) => ({ record: await cardRecord(d, k, { signWith: newKeys() }) })],
    ['card_signature', async (d, k) => ({ record: await cardRecord(d, k, { tamper: (c) => (c.name = 'Bus 43') }) })],
    // Unsigned, the envelope signed over the unsigned text: an `unsigned` report is refused like an `invalid` one.
    ['card_signature', async (d, k) => ({ record: await cardRecord(d, k, { tamper: (c) => (c.signatures = []) }) })],
    ['card_signature', async (d, k) => ({ record: await cardRecord(d, k, { tamper: (c) => delete c.signatures }) })],
    ['extension_did', async (d, k) => ({ record: await cardRecord(d, k, { extensionDid: newDid() }) })],
    ['sibling_endpoint', async (d, k) => ({ record: await cardRecord(d, k, { tamperRecord: (r) => (r.endpoint = 'https://elsewhere.example/a2a') }) })],
    ['sibling_protocol_version', async (d, k) => ({ record: await cardRecord(d, k, { tamperRecord: (r) => (r.protocol_version = '0.3') }) })],
    ['sibling_skills', async (d, k) => ({ record: await cardRecord(d, k, { tamperRecord: (r) => (r.skills = ['price_check']) }) })],
    ['skill_malformed', async (d, k) => ({ record: await cardRecord(d, k, { skills: ['eta_query@'] }) })],
    ['skill_unknown', async (d, k) => ({ record: await cardRecord(d, k, { skills: ['teleport'] }) })],
    ['skill_not_public', async (d, k) => ({ record: await cardRecord(d, k, { skills: ['appointment_status'] }) })],
    [
      'signing_key_missing',
      async (d, k) => {
        const doc = didDocument(d, k)
        doc.verificationMethod = doc.verificationMethod.filter((vm) => !String(vm.id).endsWith('#dina_signing'))
        return { record: await cardRecord(d, k), over: { doc } }
      },
    ],
    [
      'envelope_signature',
      async (d, k) => {
        // The card verifies under the card key; the envelope was signed by another dina_signing key.
        const other = newKeys()
        return { record: await cardRecord(d, k), over: { doc: didDocument(d, k, { dinaSigning: other.ed.raw }) } }
      },
    ],
    [
      'envelope_card_hash_mismatch',
      async (d, k) => {
        const other = await cardRecord(d, k, { name: 'Other' })
        return { record: await cardRecord(d, k, { tamperRecord: (r) => (r.directory_envelope = other.directory_envelope) }) }
      },
    ],
    [
      'envelope_did_mismatch',
      async (d, k) => {
        const foreign = newDid()
        const theirs = await cardRecord(foreign, k)
        return { record: await cardRecord(d, k, { tamperRecord: (r) => (r.directory_envelope = theirs.directory_envelope) }) }
      },
    ],
    ['envelope_members', async (d, k) => ({ record: await cardRecord(d, k, { tamperRecord: (r) => ((r.directory_envelope as Record<string, unknown>).x = 1) }) })],
  ])('%s', async (reason, make) => {
    const did = newDid()
    const keys = newKeys()
    const { record, over } = await make(did, keys)
    expect(reasonOf(await check(did, keys, record, over))).toBe(reason)
  })

  // Cold audit C5-8
  it('the same card unsigned is refused, signed it verifies: the signature is what decides', async () => {
    const did = newDid()
    const keys = newKeys()
    expect((await check(did, keys, await cardRecord(did, keys))).ok).toBe(true)
    for (const strip of [(c: Record<string, unknown>) => (c.signatures = []), (c: Record<string, unknown>) => delete c.signatures]) {
      const unsigned = await cardRecord(did, keys, { tamper: strip })
      expect(JSON.parse(unsigned.card as string).signatures ?? []).toEqual([])
      expect(reasonOf(await check(did, keys, unsigned))).toBe('card_signature')
    }
  })

  it('a signed card with no JSON-RPC interface: the REST one never stands in for it', async () => {
    const did = newDid()
    const keys = newKeys()
    expect(reasonOf(await check(did, keys, await cardRecord(did, keys, { restOnly: true })))).toBe('no_jsonrpc_interface')
  })
})

describe('publisherKeysFromDidDocument', () => {
  it('nothing from a document for another DID, or keys in another form', () => {
    const did = newDid()
    const keys = newKeys()
    expect(publisherKeysFromDidDocument(didDocument(did, keys), newDid())).toEqual({ dinaSigning: null, cardKey: null })
    const doc = didDocument(did, keys)
    for (const vm of doc.verificationMethod) vm.publicKeyMultibase = 'zNotAKey'
    expect(publisherKeysFromDidDocument(doc, did)).toEqual({ dinaSigning: null, cardKey: null })
    // The card key's slot holding an Ed25519 key yields no card key.
    const swapped = didDocument(did, keys)
    swapped.verificationMethod[1]!.publicKeyMultibase = swapped.verificationMethod[0]!.publicKeyMultibase
    expect(publisherKeysFromDidDocument(swapped, did).cardKey).toBeNull()
  })

  it('the canonical card bytes are what the record carries, byte for byte', async () => {
    const did = newDid()
    const keys = newKeys()
    const record = await cardRecord(did, keys)
    expect(canonicalize(JSON.parse(record.card as string) as JsonValue)).toBe(record.card)
  })
})
