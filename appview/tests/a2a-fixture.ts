/**
 * A Dina publisher, for the A2A directory's tests: real keys, a card signed
 * ES256 by the P-256 card key, an envelope signed by the Ed25519
 * `dina_signing` key, and the DID document PLC would serve for them.
 * Nothing is mocked except the network.
 */

import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from 'node:crypto'

import {
  A2A_CARD_COLLECTION,
  A2A_SELF_RKEY,
  DINA_A2A_EXTENSION_URI,
  canonicalize,
  cardStringHash,
  ed25519Multikey,
  p256Multikey,
  signAgentCard,
  signDirectoryEnvelope,
  type JsonValue,
} from '@dina/a2a'

const sha256 = (bytes: Uint8Array): Uint8Array => createHash('sha256').update(bytes).digest()
const b64u = (s: string) => Buffer.from(s, 'base64url')

export interface Keys {
  ed: { privateKey: KeyObject; raw: Uint8Array }
  p256: { privateKey: KeyObject; compressed: Uint8Array }
}

export function newKeys(): Keys {
  const ed = generateKeyPairSync('ed25519')
  const edRaw = b64u(ed.publicKey.export({ format: 'jwk' }).x as string)
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = ec.publicKey.export({ format: 'jwk' })
  const x = b64u(jwk.x as string)
  const y = b64u(jwk.y as string)
  const compressed = new Uint8Array(33)
  compressed[0] = (y[31] as number) & 1 ? 0x03 : 0x02
  compressed.set(x, 1)
  return { ed: { privateKey: ed.privateKey, raw: new Uint8Array(edRaw) }, p256: { privateKey: ec.privateKey, compressed } }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
/** A fresh `did:plc` (24 random base32 characters). */
export function newDid(): string {
  return `did:plc:${[...randomBytes(24)].map((b) => BASE32[b % 32]).join('')}`
}

/** The document PLC serves: both keys as Multikey under their fragments. */
export function didDocument(did: string, keys: Keys, over: { dinaSigning?: Uint8Array; cardKey?: Uint8Array | null } = {}) {
  const methods: Record<string, unknown>[] = [
    { id: `${did}#dina_signing`, type: 'Multikey', controller: did, publicKeyMultibase: ed25519Multikey(over.dinaSigning ?? keys.ed.raw) },
  ]
  const cardKey = over.cardKey === undefined ? keys.p256.compressed : over.cardKey
  if (cardKey !== null) {
    methods.push({ id: `${did}#a2a_card`, type: 'Multikey', controller: did, publicKeyMultibase: p256Multikey(cardKey) })
  }
  return { '@context': ['https://www.w3.org/ns/did/v1'], id: did, verificationMethod: methods }
}

export interface CardOptions {
  name?: string
  description?: string
  skills?: string[]
  endpoint?: string
  /** The DID the Dina extension names (default: the publisher's). */
  extensionDid?: string
  freshnessEpoch?: number
  publisherEpoch?: number
  publisherInstance?: string
  /** Publish only the REST interface (no JSON-RPC one). */
  restOnly?: boolean
  /** Sign the card with these keys instead (a stale or foreign key). */
  signWith?: Keys
  /** Edit the card after signing it. */
  tamper?: (card: Record<string, unknown>) => void
  /** Edit the record after building it. */
  tamperRecord?: (record: Record<string, unknown>) => void
}

/** A `com.dinakernel.a2a.card/self` record as the publisher writes it. */
export async function cardRecord(did: string, keys: Keys, o: CardOptions = {}): Promise<Record<string, unknown>> {
  const skills = o.skills ?? ['eta_query']
  const endpoint = o.endpoint ?? 'https://agent.example/a2a/v1'
  const card: Record<string, unknown> = {
    name: o.name ?? 'Bus 42',
    description: o.description ?? 'Arrival times for the 42.',
    version: '1.0.0',
    supportedInterfaces: [
      ...(o.restOnly === true ? [] : [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]),
      { url: `${endpoint.replace(/\/v1$/, '')}/rest`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
    ],
    capabilities: {
      streaming: true,
      extensions: [{ uri: DINA_A2A_EXTENSION_URI, required: false, params: { did: o.extensionDid ?? did } }],
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: skills.map((id) => ({ id, name: id, description: `${id}.`, tags: ['transit'] })),
  }
  const signer = o.signWith ?? keys
  const signature = await signAgentCard(card, { alg: 'ES256', kid: 'card-key' }, (input) =>
    nodeSign('sha256', input, { key: signer.p256.privateKey, dsaEncoding: 'ieee-p1363' }),
  )
  card.signatures = [signature]
  o.tamper?.(card)
  const cardText = canonicalize(card as JsonValue)
  const envelope = await signDirectoryEnvelope(
    {
      did,
      collection: A2A_CARD_COLLECTION,
      rkey: A2A_SELF_RKEY,
      card_hash: cardStringHash(cardText, sha256),
      freshness_epoch: o.freshnessEpoch ?? 0,
      publisher_epoch: o.publisherEpoch ?? 1,
      publisher_instance: o.publisherInstance ?? '00000000-0000-4000-8000-000000000001',
    },
    (message) => nodeSign(null, message, signer.ed.privateKey),
  )
  const record: Record<string, unknown> = {
    $type: A2A_CARD_COLLECTION,
    card: cardText,
    directory_envelope: envelope,
    endpoint,
    protocol_version: '1.0',
    skills,
  }
  o.tamperRecord?.(record)
  return record
}

export const cardHashOf = (record: Record<string, unknown>) => cardStringHash(record.card as string, sha256)

/** Revisions in order: TIDs from a counter, so tests can say "older" and "newer". */
export function revOf(n: number): string {
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz'
  let out = ''
  let v = n
  for (let i = 0; i < 12; i++) {
    out = alphabet[v % 32] + out
    v = Math.floor(v / 32)
  }
  return `3${out}`
}

let cidCounter = 0
/** A CID of the right shape (the ingester checks only that). */
export function newCid(): string {
  cidCounter += 1
  return `bafyrei${createHash('sha256').update(String(cidCounter)).digest('hex').replace(/[^a-z2-7]/g, 'a').slice(0, 52)}`
}
