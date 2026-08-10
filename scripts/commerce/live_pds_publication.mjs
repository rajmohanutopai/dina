#!/usr/bin/env node
/**
 * §24 / WBS 11.3 — ChairMaker's catalog over a LIVE PDS.
 *
 * WHAT THIS CLOSES. Every commerce journey so far hands records between two
 * halves in one process, or reads them out of a fixture. WBS 11.3's remaining
 * gap was "a live PDS": the transport that actually carries a supplier's
 * catalog from their node to an index that has never heard of them. Until
 * these bytes survive a real HTTP round trip through a real AT Protocol
 * server, "a retailer finds a manufacturer" is a claim about our own test
 * harness.
 *
 * WHAT IT PROVES, and it is deliberately narrow: the catalog records Core
 * PUBLISHES can be written to a real PDS, read back by a stranger who holds
 * nothing but the supplier's DID, and STILL VERIFY. The digests are computed
 * over the bytes; a transport that reordered a key, coerced a number or
 * dropped an optional field would break them, and that is exactly the class of
 * damage a round trip is worth testing for.
 *
 * WHAT IT DOES NOT PROVE. Discovery over a live AppView — the deployed
 * `test-appview.dinakernel.com` predates the commerce methods and answers
 * `Unknown method` for `com.dinakernel.commerce.searchCatalog`, so that step
 * needs a redeploy and is NOT claimed here.
 *
 * CREDENTIALS. The test actors are fixtures the repository already commits, in
 * `scripts/register_test_actors.py`, alongside their `03…` seeds. They are
 * throwaway identities on a throwaway PDS, provisioned once for exactly this.
 * Nothing here reads a real user's secret, and the script refuses to run
 * against any host but the test PDS.
 *
 * Usage:
 *   node scripts/commerce/live_pds_publication.mjs
 *   PDS_URL=… node scripts/commerce/live_pds_publication.mjs   (test hosts only)
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')

const PDS_URL = process.env.PDS_URL ?? 'https://test-pds.dinakernel.com'

// A GUARD, not a formality. This script writes records into whatever host it
// is pointed at, using a password committed in the repo. Pointing it at a real
// PDS would publish a fictional manufacturer's catalog under someone's real
// identity, so the host is checked rather than trusted.
if (!/^https:\/\/test-[a-z0-9-]+\.dinakernel\.com$/.test(PDS_URL)) {
  console.error(`REFUSED: ${PDS_URL} is not a test PDS. This script publishes with fixture credentials.`)
  process.exit(2)
}

const CHAIRMAKER = {
  did: 'did:plc:h4en7flpfoqpnzlh7np6erwm',
  email: 'chairmaker-test@dina.local',
  // Fixture credential, committed in `scripts/register_test_actors.py`.
  password: 'dina-test-chairmaker-2026',
}

/** Core's real publication — the same bytes AppView's discovery suite reads. */
const PUBLICATION = JSON.parse(
  readFileSync(
    path.join(REPO, 'packages', 'commerce-protocol', 'conformance', 'interop', 'catalog_publication.json'),
    'utf8',
  ),
)

const SNAPSHOT_COLLECTION = 'com.dinakernel.commerce.catalogSnapshot'
const POINTER_COLLECTION = 'com.dinakernel.commerce.catalog'

/**
 * Canonical JSON — the same rule `@dina/commerce-protocol` uses.
 *
 * Reimplemented rather than imported because this script runs as plain ESM
 * against a live server and the package is TypeScript. That is a real risk of
 * drift, so the script does not TRUST this function: it recomputes the digest
 * of what came back and compares it to the digest the supplier PUBLISHED, so a
 * bug here shows up as a mismatch rather than as a false pass.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * §9.12 domain separation. THE FIRST VERSION OF THIS SCRIPT OMITTED IT.
 *
 * `catalog_publication.ts` commits every catalog digest as
 * `sha256(`${CATALOG_PREFIX}${kind}\n${canonicalJson(value)}`)`, and I hashed
 * the canonical JSON alone. The consequence was worse than a missing check: the
 * comparison would have failed on PERFECTLY GOOD bytes, so the script's one
 * reason to exist — telling a transport bug from a healthy round trip — would
 * have reported corruption that never happened, on every run, for ever.
 *
 * It survived because the run stops at sign-in before reaching this line, which
 * is exactly how a check nobody can execute stays wrong. Hence `selfCheck()`
 * below: the digest step now runs against the committed fixture with no
 * network at all, so this can never again be untested code.
 */
const CATALOG_PREFIX = 'dina:commerce:catalog:v1:'
const catalogDigest = (kind, value) => sha256Hex(`${CATALOG_PREFIX}${kind}\n${canonicalJson(value)}`)

const pageDigestOf = (page) => {
  const { page_digest: _ignored, ...rest } = page
  return catalogDigest('page', rest)
}

const snapshotDigestOf = (snapshot) => {
  const { snapshot_digest: _ignored, ...rest } = snapshot
  return catalogDigest('snapshot', rest)
}

/** §10.2 — the root that commits to an ORDERED list of page digests. */
const payloadRootOf = (pageDigests) => catalogDigest('root', pageDigests)

/**
 * Prove the digest arithmetic offline, BEFORE touching the network.
 *
 * Without this the script cannot tell "the transport corrupted the bytes" from
 * "my hash function is wrong", and it would blame the transport either way.
 * Running it against the frozen fixture means a failure here is unambiguously
 * mine.
 */
function selfCheck() {
  for (const page of PUBLICATION.pages) {
    if (pageDigestOf(page) !== page.page_digest) {
      throw new Error(
        `SELF-CHECK FAILED: page ${String(page.page_index)} digest arithmetic disagrees with the frozen fixture. ` +
          `This is a bug in THIS SCRIPT, not in the PDS.`,
      )
    }
  }
  // THE WHOLE CHAIN, offline. Each link the live probe walks is proved here
  // first, so a live failure can only mean the transport — which is the one
  // question this script exists to answer.
  const localPageDigests = PUBLICATION.pages.map((page) => pageDigestOf(page))
  const listMatches =
    PUBLICATION.snapshot.page_digests.length === localPageDigests.length &&
    localPageDigests.every((d, i) => d === PUBLICATION.snapshot.page_digests[i])
  if (!listMatches) {
    throw new Error(
      "SELF-CHECK FAILED: the fixture's page digests do not match the snapshot's ordered list.",
    )
  }
  if (payloadRootOf(PUBLICATION.snapshot.page_digests) !== PUBLICATION.snapshot.payload_root) {
    throw new Error('SELF-CHECK FAILED: payload-root arithmetic disagrees with the frozen fixture.')
  }
  if (snapshotDigestOf(PUBLICATION.snapshot) !== PUBLICATION.snapshot.snapshot_digest) {
    throw new Error('SELF-CHECK FAILED: snapshot digest arithmetic disagrees with the frozen fixture.')
  }
  if (PUBLICATION.pointer.snapshot_digest !== PUBLICATION.snapshot.snapshot_digest) {
    throw new Error('SELF-CHECK FAILED: the fixture pointer does not name the fixture snapshot.')
  }
  // The pointer comparison must be able to FAIL. A canonicalizer that ignored a
  // field would make the live check vacuous, so prove it notices one changing
  // before trusting it to notice the network.
  const nudged = { ...PUBLICATION.pointer, service_rkey: 'not-the-published-rkey' }
  if (canonicalJson(nudged) === canonicalJson(PUBLICATION.pointer)) {
    throw new Error(
      'SELF-CHECK FAILED: the pointer comparison cannot detect a changed field, so the live check would be vacuous.',
    )
  }
}

async function xrpc(method, { body, token, query } = {}) {
  const url = new URL(`${PDS_URL}/xrpc/${method}`)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { _raw: text }
  }
  if (!res.ok) throw new Error(`${method} -> ${String(res.status)} ${JSON.stringify(json)}`)
  return json
}

const steps = []
const record = (name, ok, detail) => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function main() {
  console.log(`Live PDS publication against ${PDS_URL}\n`)

  // OFFLINE FIRST. A digest bug must never be reportable as a transport bug.
  selfCheck()
  record('digest arithmetic agrees with the frozen fixture (offline)', true)

  // 1. The identity is real and resolvable by a stranger.
  const described = await xrpc('com.atproto.repo.describeRepo', { query: { repo: CHAIRMAKER.did } })
  record(
    'supplier identity resolves on the live PDS',
    described.did === CHAIRMAKER.did,
    `${described.handle} / ${described.did}`,
  )

  // 2. Authenticate as the supplier.
  const session = await xrpc('com.atproto.server.createSession', {
    body: { identifier: CHAIRMAKER.email, password: CHAIRMAKER.password },
  })
  record('supplier can sign in to publish', session.did === CHAIRMAKER.did)
  const token = session.accessJwt

  // 3. Publish the snapshot and the pointer — Core's bytes, untouched.
  const snapshotRkey = PUBLICATION.snapshot.snapshot_digest
  await xrpc('com.atproto.repo.putRecord', {
    token,
    body: {
      repo: CHAIRMAKER.did,
      collection: SNAPSHOT_COLLECTION,
      rkey: snapshotRkey,
      record: { snapshot: PUBLICATION.snapshot, pages: PUBLICATION.pages },
    },
  })
  await xrpc('com.atproto.repo.putRecord', {
    token,
    body: {
      repo: CHAIRMAKER.did,
      collection: POINTER_COLLECTION,
      rkey: PUBLICATION.pointer.catalog_id,
      record: PUBLICATION.pointer,
    },
  })
  record('catalog snapshot + pointer written to the live repo', true)

  // 4. Read them back the way a STRANGER does — no token, DID only.
  const backSnapshot = await xrpc('com.atproto.repo.getRecord', {
    query: { repo: CHAIRMAKER.did, collection: SNAPSHOT_COLLECTION, rkey: snapshotRkey },
  })
  const backPointer = await xrpc('com.atproto.repo.getRecord', {
    query: { repo: CHAIRMAKER.did, collection: POINTER_COLLECTION, rkey: PUBLICATION.pointer.catalog_id },
  })
  record('a stranger holding only the DID can read the catalog', true)

  // 5. THE POINT: do the digests still hold over what came back?
  //
  // Compared against the digest the supplier PUBLISHED, not against a digest
  // recomputed from the same object twice — the second would agree with itself
  // no matter what the transport did.
  //
  // THE CHAIN, LINK BY LINK — not each record against its own returned field.
  //
  // Every check here used to compare a record with a value the SAME RESPONSE
  // carried: a page against its own `page_digest`, a snapshot against its own
  // `snapshot_digest`. A store that altered a page and recomputed that page's
  // digest passed both, because nothing crossed from one record to the next.
  // The commitment chain is what makes the publication verifiable, so the probe
  // has to walk it: page bytes → page digest → the snapshot's ORDERED list →
  // payload root → snapshot digest → the pointer that names it.
  const returnedSnapshot = backSnapshot.value.snapshot
  const pages = backSnapshot.value.pages

  const recomputedPageDigests = pages.map((page) => pageDigestOf(page))

  // LINK 1 — each page hashes to what the SNAPSHOT commits to, at that index.
  // Comparing against `page.page_digest` asks the page to vouch for itself.
  const pagesMatchSnapshotList =
    Array.isArray(returnedSnapshot.page_digests) &&
    returnedSnapshot.page_digests.length === recomputedPageDigests.length &&
    recomputedPageDigests.every((digest, i) => digest === returnedSnapshot.page_digests[i])
  record(
    'every returned page hashes to the digest the snapshot commits to, in order',
    pagesMatchSnapshotList,
    `${String(pages.length)} page(s)`,
  )

  // LINK 2 — the payload root commits to that ordered list. Never recomputed
  // before, so a reordered or substituted list went unnoticed.
  const rootOk = payloadRootOf(returnedSnapshot.page_digests) === returnedSnapshot.payload_root
  record('the payload root still commits to those page digests', rootOk)

  // LINK 3 — the snapshot digest covers the snapshot, root included.
  const snapshotOk = snapshotDigestOf(returnedSnapshot) === returnedSnapshot.snapshot_digest
  record('the returned snapshot still hashes to its own digest', snapshotOk)

  // LINK 4 — the POINTER names the snapshot that CAME BACK, not the one on
  // this machine. Comparing with the local fixture asks whether our own copy
  // is unchanged, which it always is: it never left.
  const pointerNamesSnapshot =
    backPointer.value.snapshot_digest === returnedSnapshot.snapshot_digest
  record('the returned pointer names the returned snapshot', pointerNamesSnapshot)

  // AND the whole chain still ends where the supplier published it. Without
  // this a store could return an internally consistent DIFFERENT catalog.
  const chainMatchesPublished =
    returnedSnapshot.snapshot_digest === PUBLICATION.snapshot.snapshot_digest
  record('the returned chain is the one that was published', chainMatchesPublished)

  // THE WHOLE POINTER, not one field of it.
  //
  // Every earlier assertion compared `snapshot_digest` and stopped. The other
  // pointer fields — `service_rkey`, `snapshot_rkey`, `snapshot_sequence`,
  // `protocol_version`, `published_at`, `supplier_did`, `catalog_id` — sit
  // OUTSIDE the snapshot digest, so a store could drop or rewrite any of them
  // and pass every check here. `service_rkey` is the one with teeth: it is the
  // listing a buyer resolves, so losing it silently detaches the catalog from
  // the service that serves it.
  //
  // Canonical bytes rather than a field list, because a field list is another
  // thing to keep in step with the record.
  const pointerIntact =
    canonicalJson(backPointer.value) === canonicalJson(PUBLICATION.pointer)
  record(
    'the returned pointer is byte-identical to the one published',
    pointerIntact,
    pointerIntact ? '' : 'a pointer field changed in transit',
  )

  const itemsSurvived =
    JSON.stringify(pages.flatMap((p) => p.items)) ===
    JSON.stringify(PUBLICATION.pages.flatMap((p) => p.items))
  record('every catalog item came back byte-identical', itemsSurvived)

  // 6. The collections now exist — the repo was empty before this ran.
  const after = await xrpc('com.atproto.repo.describeRepo', { query: { repo: CHAIRMAKER.did } })
  record(
    'the live repo now advertises both commerce collections',
    [SNAPSHOT_COLLECTION, POINTER_COLLECTION].every((c) => (after.collections ?? []).includes(c)),
    (after.collections ?? []).join(', '),
  )

  const failed = steps.filter((s) => !s.ok)
  console.log(`\n${String(steps.length - failed.length)}/${String(steps.length)} passed`)
  if (failed.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
