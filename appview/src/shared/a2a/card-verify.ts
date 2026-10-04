/**
 * Verify a published A2A card record (design §8.3): every check, fail-
 * closed, before a card may be indexed.
 *
 * The verified card and the verified envelope are the only sources. What a
 * row stores is derived from them, never taken from the record's
 * convenience fields, which must agree with the card or the record is
 * refused:
 *   - the record is `com.dinakernel.a2a.card/self`, its members exactly
 *     the published shape, its card string at most 128 KB;
 *   - the card string is the card's canonical JSON (RFC 8785): the bytes
 *     its hash covers are the bytes the live card is served as;
 *   - no U+0000 anywhere in it;
 *   - the card is a v1.0 card, and its JWS verifies against the
 *     publisher's card-signing key (`#a2a_card` in its DID document; a
 *     URL the card names is never fetched);
 *   - the Dina extension names the repository's own DID;
 *   - `endpoint`, `protocol_version` and `skills` equal what the card
 *     says;
 *   - every skill is `capability` or `capability@rkey`, its capability
 *     in the shared registry and allowed in public;
 *   - the directory envelope verifies against `#dina_signing`: bound to
 *     this repository, collection and rkey, its card hash the hash of
 *     these exact bytes.
 */

import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto'

import {
  A2A_CARD_COLLECTION,
  A2A_CARD_KEY_FRAGMENT,
  A2A_LIMITS,
  A2A_SELF_RKEY,
  DINA_SIGNING_FRAGMENT,
  cardStringHash,
  ed25519FromMultikey,
  isPlainObject,
  p256FromMultikey,
  parseQualifiedSkill,
  readCardRecordFacts,
  readCardRecordText,
  verifyAgentCardSignatures,
  verifyDirectoryEnvelope,
} from '@dina/a2a'

import {
  getCapabilityEntry,
  isPublicExposureAllowed,
  resolveCanonicalCapability,
} from '../capability-registry.js'

/** The largest card string indexed (design §8.3): the one cap the gateway and the publisher hold to. */
export const A2A_CARD_MAX_BYTES = A2A_LIMITS.maxCardBytes


/** The two keys a publisher's DID document names for A2A. */
export interface PublisherKeys {
  /** Ed25519, 32 bytes: signs the directory envelope. */
  dinaSigning: Uint8Array | null
  /** P-256, the 33-byte compressed point: signs the card. */
  cardKey: Uint8Array | null
}

/**
 * The keys a DID document names under `#dina_signing` and `#a2a_card`
 * (as `Multikey`, the form PLC renders), for a document whose `id` is the
 * DID. A key in another form, or a document for another DID, yields none.
 */
export function publisherKeysFromDidDocument(document: unknown, did: string): PublisherKeys {
  const none: PublisherKeys = { dinaSigning: null, cardKey: null }
  if (!isPlainObject(document) || document.id !== did || !Array.isArray(document.verificationMethod)) return none
  const keys: PublisherKeys = { dinaSigning: null, cardKey: null }
  for (const vm of document.verificationMethod) {
    if (!isPlainObject(vm) || typeof vm.id !== 'string' || typeof vm.publicKeyMultibase !== 'string') continue
    const fragment = vm.id.startsWith('#') ? vm.id.slice(1) : vm.id.startsWith(`${did}#`) ? vm.id.slice(did.length + 1) : null
    if (fragment === DINA_SIGNING_FRAGMENT) keys.dinaSigning = ed25519FromMultikey(vm.publicKeyMultibase)
    if (fragment === A2A_CARD_KEY_FRAGMENT) keys.cardKey = p256FromMultikey(vm.publicKeyMultibase)
  }
  return keys
}

/** A skill as indexed: the exact identifier, and its canonical search key. */
export interface IndexedSkill {
  id: string
  canonical: string
}

export interface VerifiedA2ACard {
  /** The card string exactly as published. */
  cardText: string
  cardHash: string
  endpoint: string
  protocolVersion: string
  skills: IndexedSkill[]
  displayName: string
  description: string
  freshnessEpoch: number
  publisherEpoch: number
  publisherInstance: string
}

export type A2ACardVerdict = { ok: true; card: VerifiedA2ACard } | { ok: false; reason: string }

const sha256 = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest()

// DER SubjectPublicKeyInfo prefixes, so node:crypto takes the raw keys as they are.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const P256_COMPRESSED_SPKI = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex')

function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, publicKey]), format: 'der', type: 'spki' })
    return nodeVerify(null, message, key, signature)
  } catch {
    return false
  }
}

function p256Verify(compressedPoint: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([P256_COMPRESSED_SPKI, compressedPoint]), format: 'der', type: 'spki' })
    return nodeVerify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature)
  } catch {
    return false
  }
}

const fail = (reason: string): A2ACardVerdict => ({ ok: false, reason })


/** Every check of §8.3, in order; the first that fails names the refusal. */
export async function verifyA2ACardRecord(args: {
  repoDid: string
  collection: string
  rkey: string
  record: unknown
  keys: PublisherKeys
}): Promise<A2ACardVerdict> {
  const { repoDid, record, keys } = args
  if (args.collection !== A2A_CARD_COLLECTION) return fail('collection')
  if (args.rkey !== A2A_SELF_RKEY) return fail('rkey_not_self')
  // The record's rules a publisher holds too (@dina/a2a), around the checks only the directory can make.
  const text = readCardRecordText(record)
  if (!text.ok) return fail(text.reason)
  const { card, cardText, record: published } = text

  if (keys.cardKey === null) return fail('card_key_missing')
  const cardKey = keys.cardKey
  const report = await verifyAgentCardSignatures(card, ({ header, signingInputs, signature }) =>
    header.alg === 'ES256' && signingInputs.some((input) => p256Verify(cardKey, input, signature)),
  )
  if (report.state !== 'verified') return fail('card_signature')

  const facts = readCardRecordFacts(card, published, repoDid)
  if (!facts.ok) return fail(facts.reason)
  const { endpoint, protocolVersion, skillIds } = facts
  const skills: IndexedSkill[] = []
  for (const id of skillIds) {
    const qualified = parseQualifiedSkill(id)
    if (qualified === null) return fail('skill_malformed')
    const canonicalCapability = resolveCanonicalCapability(qualified.capability)
    const entry = canonicalCapability === null ? null : getCapabilityEntry(canonicalCapability)
    if (canonicalCapability === null || entry === null) return fail('skill_unknown')
    if (!isPublicExposureAllowed(entry)) return fail('skill_not_public')
    skills.push({ id, canonical: canonicalCapability })
  }

  if (keys.dinaSigning === null) return fail('signing_key_missing')
  const dinaSigning = keys.dinaSigning
  const envelope = published.directory_envelope
  const checked = verifyDirectoryEnvelope(
    envelope,
    { repoDid, collection: A2A_CARD_COLLECTION, rkey: A2A_SELF_RKEY, cardText },
    sha256,
    (message, signature) => ed25519Verify(dinaSigning, message, signature),
  )
  if (!checked.ok) return fail(checked.reason)
  const env = envelope as { freshness_epoch: number; publisher_epoch: number; publisher_instance: string }

  return {
    ok: true,
    card: {
      cardText,
      cardHash: cardStringHash(cardText, sha256),
      endpoint,
      protocolVersion,
      skills,
      displayName: card.name as string,
      description: card.description as string,
      freshnessEpoch: env.freshness_epoch,
      publisherEpoch: env.publisher_epoch,
      publisherInstance: env.publisher_instance,
    },
  }
}
