/**
 * The directory's DID fetch takes `did:plc` only (a recorded departure:
 * `did:web` is refused), and a malformed or path-bending DID is never
 * turned into a URL. Against a scripted fetch at the network edge.
 */

import { expect, it } from 'vitest'

import { createPlcDidResolver } from '@/shared/a2a/did-resolver.js'

const DID = 'did:plc:abcdefghijklmnopqrstuvwx'

// Plan F73
it('a DID that is not exactly did:plc plus 24 base32 characters is never fetched, whatever it smuggles', async () => {
  const urls: string[] = []
  const resolve = createPlcDidResolver({
    plcUrl: 'https://plc.example',
    fetch: (async (url: string | URL) => {
      urls.push(String(url))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  })
  const smuggled = [
    `${DID}\n`,
    ` ${DID}`,
    `${DID}?x=1`,
    `${DID}#a2a_card`,
    `${DID}%2F..%2Fadmin`,
    `did:plc:${'a'.repeat(23)}/`,
    `did:plc:${'a'.repeat(25)}`,
    'did:plc:abcdefghijklmnopqrstuvw1',
    `did:PLC:${DID.slice(8)}`,
    `did:web:plc.example`,
    `https://plc.example/${DID}`,
    '',
  ]
  for (const did of smuggled) expect({ did, answer: await resolve(did) }).toEqual({ did, answer: { kind: 'unsupported' } })
  expect(urls).toEqual([])
  // The one well-formed DID is fetched from exactly {plc}/{did}.
  expect((await resolve(DID)).kind).toBe('document')
  expect(urls).toEqual([`https://plc.example/${DID}`])
})
