/**
 * M0's frozen directory-envelope vectors (design §8.2: "M0 ships
 * cross-runtime golden vectors ... that feed the M5 ingest tests"), run
 * against `@dina/a2a`'s envelope check as AppView imports it, with the
 * publisher's key read out of a DID document by AppView's own reader. The
 * Ed25519 check here is this file's own node:crypto call: AppView's own
 * check of a malleated signature is in lane3_directory_card_check.test.ts.
 */

import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  A2A_CARD_COLLECTION,
  A2A_SELF_RKEY,
  cardStringHash,
  ed25519Multikey,
  p256Multikey,
  verifyDirectoryEnvelope,
  type EnvelopeContext,
} from '@dina/a2a'

import { publisherKeysFromDidDocument } from '@/shared/a2a/card-verify.js'

interface Vectors {
  public_key_hex: string
  card_text: string
  card_hash: string
  envelope: { value: Record<string, unknown> }
  envelope_refusals: { name: string; value: unknown; context?: Partial<EnvelopeContext>; expect: string }[]
}

const V = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'packages', 'a2a', 'conformance', 'vectors', 'directory_envelope.json'), 'utf8'),
) as Vectors

const sha256 = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest()
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return nodeVerify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, publicKey]), format: 'der', type: 'spki' }), signature)
  } catch {
    return false
  }
}

const DID = V.envelope.value.did as string
/** The vector's key as PLC would render it, read back by AppView's reader. */
function signingKey(): Uint8Array {
  const doc = {
    id: DID,
    verificationMethod: [
      { id: `${DID}#dina_signing`, type: 'Multikey', controller: DID, publicKeyMultibase: ed25519Multikey(Buffer.from(V.public_key_hex, 'hex')) },
      // Any P-256 point: the envelope check reads only dina_signing.
      { id: `${DID}#a2a_card`, type: 'Multikey', controller: DID, publicKeyMultibase: p256Multikey(new Uint8Array([2, ...new Uint8Array(32).fill(7)])) },
    ],
  }
  const key = publisherKeysFromDidDocument(doc, DID).dinaSigning
  if (key === null) throw new Error('the vector key did not come back out of the DID document')
  return key
}
const context = (over: Partial<EnvelopeContext> = {}): EnvelopeContext => ({
  repoDid: DID,
  collection: A2A_CARD_COLLECTION,
  rkey: A2A_SELF_RKEY,
  cardText: V.card_text,
  ...over,
})
const verify = (value: unknown, over: Partial<EnvelopeContext> = {}) =>
  verifyDirectoryEnvelope(value, context(over), sha256, (message, signature) => ed25519Verify(signingKey(), message, signature))

describe('the frozen directory-envelope vectors, against @dina/a2a with the key AppView reads from the DID document', () => {
  // Plan F64
  it('the frozen envelope verifies against the key read from the DID document, and the card text hashes to the frozen card hash', () => {
    expect(Buffer.from(signingKey()).toString('hex')).toBe(V.public_key_hex)
    expect(cardStringHash(V.card_text, sha256)).toBe(V.card_hash)
    expect(verify(V.envelope.value)).toEqual({ ok: true })
  })

  // Plan F64
  it('every frozen refusal is refused, with the frozen reason', () => {
    expect(V.envelope_refusals.length).toBeGreaterThanOrEqual(15)
    for (const r of V.envelope_refusals) {
      expect({ name: r.name, verdict: verify(r.value, r.context ?? {}) }).toEqual({ name: r.name, verdict: { ok: false, reason: r.expect } })
    }
  })
})
