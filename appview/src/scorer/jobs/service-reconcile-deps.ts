/**
 * Production dependencies for listing reconciliation
 * (`service-reconcile.ts`, docs/REAL_LIFE_FIXES.md §14.4 C).
 *
 * Every outbound read goes through the vetted socket (`@dina/net-socket-node`:
 * one resolution, special-use addresses refused, the connection pinned to the
 * vetted address, TLS checked, no redirects, byte and time caps) after the
 * URL check every Dina fetch makes (`checkOutboundUrl`: https, no
 * credentials, no literal IP). The PDS address comes from the publisher's own
 * DID document, so it is untrusted input to exactly these rules.
 *
 * A record counts only when `@atproto/repo` verifies it: the CAR's commit is
 * the requested DID's, its signature checks against the DID's signing key,
 * and the record is reachable from the signed root (or provably absent).
 */

import { getKey, getPds } from '@atproto/identity'
import { MemoryBlockstore, readCarWithRoot, Repo, verifyCommitSig } from '@atproto/repo'
import { checkOutboundUrl } from '@dina/a2a'
import type { PolicySocket } from '@dina/net-policy'
import { createNodePolicySocket } from '@dina/net-socket-node'

import type { DidResolver } from '@/shared/a2a/did-resolver.js'
import type { ReconcileDeps, VerifiedRead } from './service-reconcile.js'

const LIMITS = { maxResponseBytes: 1024 * 1024, timeoutMs: 10_000 }

async function get(
  socket: PolicySocket,
  url: string,
  accept: 'json' | 'car',
): Promise<{ status: number; bytes: Uint8Array } | null> {
  const check = checkOutboundUrl(url)
  if (!check.ok) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), LIMITS.timeoutMs)
  })
  try {
    const result = await Promise.race([
      socket({
        method: 'GET',
        url: check.url.href,
        headers: { accept: accept === 'car' ? 'application/vnd.ipld.car' : 'application/json' },
        accept,
        minTls: 'TLSv1.2',
        readAuthErrorBodies: false,
        ...LIMITS,
      }).catch(() => null),
      deadline,
    ])
    if (result === 'deadline' || result === null || !result.ok) return null
    return { status: result.status, bytes: result.bodyBytes }
  } finally {
    clearTimeout(timer)
  }
}

export function createReconcileDeps(options: { resolveDid: DidResolver; socket?: PolicySocket }): ReconcileDeps {
  const socket = options.socket ?? createNodePolicySocket()
  return {
    async resolve(did) {
      const r = await options.resolveDid(did)
      if (r.kind !== 'document') return null
      const doc = r.document as Parameters<typeof getKey>[0]
      const signingKey = getKey(doc)
      const pdsRaw = getPds(doc)
      const pds = typeof pdsRaw === 'string' && /^https:\/\//i.test(pdsRaw) ? pdsRaw.replace(/\/+$/, '') : null
      if (signingKey === undefined || pds === null) return null
      return { signingKey, pds }
    },

    async listRkeys(pds, did) {
      const out: { rkey: string; cid: string }[] = []
      let cursor: string | undefined
      for (let page = 0; page < 3; page++) {
        const q = new URLSearchParams({ repo: did, collection: 'com.dinakernel.service.profile', limit: '100' })
        if (cursor !== undefined) q.set('cursor', cursor)
        const res = await get(socket, `${pds}/xrpc/com.atproto.repo.listRecords?${q}`, 'json')
        if (res === null || res.status !== 200) return null
        let body: { records?: { uri?: unknown; cid?: unknown }[]; cursor?: unknown }
        try {
          body = JSON.parse(new TextDecoder().decode(res.bytes)) as typeof body
        } catch {
          return null
        }
        for (const rec of body.records ?? []) {
          if (typeof rec.uri === 'string' && typeof rec.cid === 'string') {
            out.push({ rkey: rec.uri.slice(rec.uri.lastIndexOf('/') + 1), cid: rec.cid })
          }
        }
        if (typeof body.cursor !== 'string' || body.cursor === '' || (body.records ?? []).length === 0) return out
        cursor = body.cursor
      }
      return out
    },

    async readVerified(pds, did, signingKey, collection, rkey): Promise<VerifiedRead> {
      const q = new URLSearchParams({ did, collection, rkey })
      const res = await get(socket, `${pds}/xrpc/com.atproto.sync.getRecord?${q}`, 'car')
      if (res === null) return { kind: 'failed', reason: 'fetch_failed' }
      if (res.status !== 200) return { kind: 'failed', reason: `http_${res.status}` }
      try {
        const { root, blocks } = await readCarWithRoot(res.bytes)
        const repo = await Repo.load(new MemoryBlockstore(blocks), root)
        if (repo.did !== did) return { kind: 'failed', reason: 'wrong_repo' }
        if (!(await verifyCommitSig(repo.commit, signingKey))) return { kind: 'failed', reason: 'bad_signature' }
        const cid = await repo.data.get(`${collection}/${rkey}`)
        if (cid === null) return { kind: 'absent', rev: repo.commit.rev }
        const record = await repo.getRecord(collection, rkey)
        return { kind: 'present', rev: repo.commit.rev, cid: cid.toString(), record }
      } catch (err) {
        return { kind: 'failed', reason: err instanceof Error ? err.message.slice(0, 80) : 'proof_invalid' }
      }
    },
  }
}
