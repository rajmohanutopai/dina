/**
 * Live listings (REAL_LIFE_FIXES §14.4 C): reconciliation applies only what
 * a signed repository proof verifies. Uses the plugin installer's fixed,
 * real proof (a CAR holding one signed commit, its MST path and one record)
 * through a fake socket.
 */

import { describe, expect, it } from 'vitest'

import { createReconcileDeps } from '@/scorer/jobs/service-reconcile-deps.js'

// The same fixture `@dina/home-node` ships for its on-device self-check.
const F = {
  did: 'did:plc:dinaselfcheckfixture0000',
  collection: 'com.dinakernel.plugin.release',
  rkey: 'qqbkkkcizjrmpkdpv5iuavxyc2xwlufq5btbnfltun4z3g7njbra',
  cid: 'bafyreieeakssqsgkmld2q35pkfafn6awv5s5bmhimyljk45dpgozx3kimi',
  signingKey: 'did:key:zQ3shjyJXUaRJC2GC43mX8aPrUhoTdoiongXhZjsdTzPKYZUM',
  carHex:
    '3aa265726f6f747381d82a5825000171122081f9cbc641157a8cee03ac61ce364d1e5f08ecbafa5a09beb5f79a3348192e2e6776657273696f6e01d201017112208402a52848ca62c7a86faf514056f816af65d0b0e866169573a3799d9bed4862a6652474797065781d636f6d2e64696e616b65726e656c2e706c7567696e2e72656c656173656776657273696f6e65312e302e3069657865637574696f6ea1646d6f64656b696e74657270726574656469706c7567696e5f69647818636f6d2e64696e616b65726e656c2e73656c66636865636b6c6361706162696c6974696573806c646973706c61795f6e616d65781d5265706f2d70726f6f662073656c662d636865636b2066697874757265b30101711220caf7f3a09eb936563db221c8fc0c0440741d2bb8b9259bbe1befe683989e27a8a2616581a4616b5852636f6d2e64696e616b65726e656c2e706c7567696e2e72656c656173652f7171626b6b6b63697a6a726d706b64707635697561767879633278776c756671356274626e666c74756e347a3367376e6a6272616170006174f66176d82a582500017112208402a52848ca62c7a86faf514056f816af65d0b0e866169573a3799d9bed4862616cf6e0010171122081f9cbc641157a8cee03ac61ce364d1e5f08ecbafa5a09beb5f79a3348192e2ea66364696478206469643a706c633a64696e6173656c66636865636b6669787475726530303030637265766d336d76656e6b6b77356773326f6373696758402915b30081f342d376d9a9316ffcaea2d6fb328a390ae554c46fa30bacc808e67db115d2b67ac2ec57a1410d14c9fb5d290691c48d41c996b55a618a4abe16a16464617461d82a58250001711220caf7f3a09eb936563db221c8fc0c0440741d2bb8b9259bbe1befe683989e27a86470726576f66776657273696f6e03',
}
const CAR = Uint8Array.from(F.carHex.match(/../g)!.map((h) => parseInt(h, 16)))

function deps(bytes: Uint8Array = CAR, status = 200) {
  const urls: string[] = []
  const d = createReconcileDeps({
    resolveDid: async () => ({ kind: 'unavailable' }),
    socket: (async (req: { url: string }) => {
      urls.push(req.url)
      return { ok: true, status, rawHeaders: [], bodyBytes: bytes }
    }) as never,
  })
  return { d, urls }
}

describe('verified repository reads', () => {
  it('a valid proof yields the record, its CID and the commit revision', async () => {
    const { d, urls } = deps()
    const r = await d.readVerified('https://pds.example', F.did, F.signingKey, F.collection, F.rkey)
    expect(r).toMatchObject({ kind: 'present', cid: F.cid })
    expect((r as { rev: string }).rev).toMatch(/^[a-z2-7]{13}$/)
    expect(urls[0]).toContain('/xrpc/com.atproto.sync.getRecord?')
  })

  it("a proof from another DID's repository is refused", async () => {
    const { d } = deps()
    const r = await d.readVerified('https://pds.example', 'did:plc:someoneelse000000000000', F.signingKey, F.collection, F.rkey)
    expect(r).toEqual({ kind: 'failed', reason: 'wrong_repo' })
  })

  it('a proof that does not verify against the DID key is refused', async () => {
    const { d } = deps()
    const other = 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme'
    const r = await d.readVerified('https://pds.example', F.did, other, F.collection, F.rkey)
    expect(r.kind).toBe('failed')
  })

  it('a corrupt CAR, or an error status, changes nothing', async () => {
    expect((await deps(new Uint8Array([1, 2, 3])).d.readVerified('https://pds.example', F.did, F.signingKey, F.collection, F.rkey)).kind).toBe('failed')
    expect(await deps(CAR, 404).d.readVerified('https://pds.example', F.did, F.signingKey, F.collection, F.rkey)).toEqual({ kind: 'failed', reason: 'http_404' })
  })

  it('a non-https or literal-IP PDS is never contacted', async () => {
    const { d, urls } = deps()
    expect((await d.readVerified('http://pds.example', F.did, F.signingKey, F.collection, F.rkey)).kind).toBe('failed')
    expect((await d.readVerified('https://10.0.0.1', F.did, F.signingKey, F.collection, F.rkey)).kind).toBe('failed')
    expect(urls).toEqual([])
  })
})
