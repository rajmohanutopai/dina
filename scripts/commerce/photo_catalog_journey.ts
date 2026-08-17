/**
 * ChairMaker photographs a price list and publishes a catalog a stranger can find.
 *
 * WHY THIS EXISTS. Eight thousand unit tests say the parts are right. None of
 * them says a seller can use the thing. This drives the lane the way a person
 * would: a photograph, a model that misreads one price, an owner who catches
 * it, and records that leave the machine and land on a real AT Protocol server
 * where somebody who has never heard of ChairMaker can fetch and verify them.
 *
 * WHAT IS REAL HERE, because the point is worthless if the answer is "a mock":
 *
 *   the vault        real SQLCipher file, real migrations, real repositories
 *   the assembler    real `assembleFromRows` → real `importCatalogRows`
 *   the state machine real `CatalogDraftService`
 *   the snapshot     real `buildCatalogSnapshot`, real digests
 *   the transport    real HTTPS to test-pds.dinakernel.com, real `putRecord`
 *   the read-back    a second process holding NOTHING but ChairMaker's DID
 *
 * WHAT IS SIMULATED, and there are exactly two:
 *
 *   the camera + model — a photograph of a price list is not something a
 *     script can take, so the extraction OUTPUT is written out by hand. It is
 *     the shape §5 step 2 defines and it carries a deliberate misreading.
 *   the passphrase    — a person typing one is not something a script can do,
 *     so the VERIFIER is a stub that knows the right answer. Everything after
 *     it is real: the run calls `proveOwnerPresence` with a passphrase, and
 *     the lane reads `ownerPresentNow` exactly as the routes do. An earlier
 *     version of this script passed `userPresent: () => true` and so never
 *     touched the presence path at all — which is how it missed that the
 *     shipped server answered a hard-coded `false` and no seller could
 *     publish anything.
 *
 * Usage:  npx tsx scripts/commerce/photo_catalog_journey.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  validateCatalogPointer,
  validateCatalogSnapshot,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import {
  createCatalogDraft,
  sourceFromDraftRows,
} from '../../packages/core/src/commerce/catalog_draft_ingest';
import { CatalogDraftService } from '../../packages/core/src/commerce/catalog_draft_service';
import {
  SQLiteCatalogDraftRepository,
  type CatalogDraft,
} from '../../packages/core/src/commerce/catalog_draft_store';
import { SQLiteCatalogPointerRepository } from '../../packages/core/src/commerce/catalog_pointer_store';
import {
  installCatalogRecordWriter,
  installCatalogRecordReader,
} from '../../packages/core/src/commerce/catalog_record_writer';
import { publishHeldDraft } from '../../packages/core/src/commerce/catalog_draft_publisher';
import {
  installOwnerPresenceVerifier,
  ownerPresenceCanBeEstablished,
  ownerPresentNow,
  proveOwnerPresence,
} from '../../packages/core/src/commerce/owner_presence';
import {
  catalogPointerRkey,
  CATALOG_POINTER_NSID,
  CATALOG_SNAPSHOT_NSID,
} from '../../packages/core/src/commerce/catalog_record_writer';
import { applyMigrations } from '../../packages/core/src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../packages/core/src/storage/schemas';

// ---------------------------------------------------------------- the actors

const PDS = process.env.PDS_URL ?? 'https://test-pds.dinakernel.com';
if (!/^https:\/\/test-[a-z0-9-]+\.dinakernel\.com$/.test(PDS)) {
  console.error(`REFUSED: ${PDS} is not a test PDS. This script writes records.`);
  process.exit(2);
}

/** Throwaway identity on a throwaway PDS, provisioned for this run. */
const CHAIRMAKER = {
  did: process.env.CM_DID ?? 'did:plc:kitj4cpnasri6vyeg3gz4j3v',
  handle: process.env.CM_HANDLE ?? 'cm-pcl.test-pds.dinakernel.com',
  password: process.env.CM_PASSWORD ?? 'dina-test-chairmaker-pcl-2026',
};

// A FRESH CATALOG EACH RUN. The rkey is the catalog id, so reusing one means
// the second run starts against its own live head — a real state, but not the
// story this script tells. Override to replay against an existing catalog.
const CATALOG_ID = process.env.CM_CATALOG ?? `chairmaker-${randomBytes(4).toString('hex')}`;
const sha256: Sha256Fn = (d) => new Uint8Array(createHash('sha256').update(d).digest());

let step = 0;
const say = (s: string): void => console.log(s);
const head = (s: string): void => {
  step += 1;
  console.log(`\n${'─'.repeat(74)}\n${String(step).padStart(2, ' ')}. ${s}\n${'─'.repeat(74)}`);
};
const ok = (s: string): void => console.log(`   ✓ ${s}`);
const no = (s: string): void => console.log(`   ✗ ${s}`);
const note = (s: string): void => console.log(`     ${s}`);

/**
 * WHAT THE MODEL RETURNED, reading a photograph of a paper price list.
 *
 * The third row is the one that matters. ChairMaker's oak dining chair is
 * ₹18,000 and the model read ₹1,800 — a decimal point lost to a smudge, which
 * is the thousandfold error §2 opens on and the reason the lane exists at all.
 * Nothing downstream can catch it: 1800 is a perfectly valid price.
 */
const EXTRACTION = {
  model: 'gemini-2.5-flash',
  schemaVersion: 'catalog-rows-1',
  rows: [
    { row: 2, cells: { sku: 'CM-STOOL-1', name: 'Oak workshop stool', unit_code: 'each', pack_size: '1', currency: 'INR', list_price_minor_units: '450000' } },
    { row: 3, cells: { sku: 'CM-BENCH-2', name: 'Teak garden bench, 4ft', unit_code: 'each', pack_size: '1', currency: 'INR', list_price_minor_units: '1250000' } },
    { row: 4, cells: { sku: 'CM-CHAIR-1', name: 'Oak dining chair', unit_code: 'each', pack_size: '1', currency: 'INR', list_price_minor_units: '180000' } },
  ],
};

/** The true price of row 4, in minor units. ₹18,000 not ₹1,800. */
const TRUE_CHAIR_PRICE_MINOR = '1800000';

// ------------------------------------------------------------ the PDS client

async function pdsSession(): Promise<string> {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: CHAIRMAKER.handle, password: CHAIRMAKER.password }),
  });
  const body = (await res.json()) as { accessJwt?: string; error?: string; message?: string };
  if (body.accessJwt === undefined) {
    throw new Error(`PDS login failed: ${body.error ?? ''} ${body.message ?? ''}`);
  }
  return body.accessJwt;
}

/** The real writer Core publishes through. One HTTPS call per record. */
function livePdsWriter(jwt: string) {
  return async (args: {
    collection: string;
    rkey: string;
    record: unknown;
    swapRecord?: string | null;
  }): Promise<{ cid: string }> => {
    const payload: Record<string, unknown> = {
      repo: CHAIRMAKER.did,
      collection: args.collection,
      rkey: args.rkey,
      record: args.record,
    };
    // Only send swapRecord when we HOLD one. Sending null means "must not
    // exist", which is a different assertion and fails every rewrite.
    if (args.swapRecord !== undefined && args.swapRecord !== null) {
      payload.swapRecord = args.swapRecord;
    }
    const res = await fetch(`${PDS}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { cid?: string; error?: string; message?: string };
    if (body.cid === undefined) {
      throw new Error(`putRecord ${args.collection} failed: ${body.error ?? ''} ${body.message ?? ''}`);
    }
    return { cid: body.cid };
  };
}

/** Reading this node's OWN repo back, which is how a lost head is classified. */
function livePdsReader() {
  return async (args: { collection: string; rkey: string }) => {
    const url = `${PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(CHAIRMAKER.did)}&collection=${encodeURIComponent(args.collection)}&rkey=${encodeURIComponent(args.rkey)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { value?: unknown; cid?: string };
    if (body.value === undefined || body.cid === undefined) return null;
    return { record: body.value, cid: body.cid };
  };
}

// ------------------------------------------------------------------ the run

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║  ChairMaker photographs a price list and publishes a catalog             ║
║  ${CHAIRMAKER.handle.padEnd(70)}║
║  ${CHAIRMAKER.did.padEnd(70)}║
║  PDS ${PDS.padEnd(67)}║
╚══════════════════════════════════════════════════════════════════════════╝`);

  const dir = mkdtempSync(path.join(tmpdir(), 'chairmaker-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  const drafts = new SQLiteCatalogDraftRepository(adapter);
  const pointers = new SQLiteCatalogPointerRepository(adapter);
  // A SECOND VAULT for the reinstall probe: a new phone is a new database
  // holding the same identity, which is the state under test.
  const adapter2 = new NodeSQLiteAdapter({
    path: path.join(dir, 'new-phone.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter2, IDENTITY_MIGRATIONS);
  const drafts2 = new SQLiteCatalogDraftRepository(adapter2);

  let failures = 0;
  const check = (cond: boolean, msg: string): void => {
    if (cond) ok(msg);
    else {
      no(msg);
      failures += 1;
    }
  };

  try {
    // ---------------------------------------------------------------- step 1
    head("ChairMaker's settings — the values no photograph can supply");
    const settings = {
      categoryIds: ['furniture.seating'],
      fulfilmentRegions: [{ scheme: 'admin_area' as const, value: 'IN-KA' }],
      tradingCurrency: 'INR',
    };
    say(`   trades in            ${settings.tradingCurrency}`);
    say(`   ships to             ${settings.fulfilmentRegions.map((r) => r.value).join(', ')}`);
    say(`   governed category    ${settings.categoryIds.join(', ')}`);
    note('A model reading a photograph cannot know where a workshop ships or');
    note('which governed category an item belongs to. These come from the person.');

    // ---------------------------------------------------------------- step 2
    head('The photograph goes to a model, and the model returns rows');
    for (const r of EXTRACTION.rows) {
      const rupees = (Number(r.cells.list_price_minor_units) / 100).toLocaleString('en-IN');
      say(`   row ${r.row}  ${r.cells.sku.padEnd(12)} ${r.cells.name.padEnd(26)} ₹${rupees}`);
    }
    note(`read by ${EXTRACTION.model} against schema ${EXTRACTION.schemaVersion}`);
    note('Row 4 is wrong. The chair is ₹18,000 and the model read ₹1,800 — a');
    note('decimal point lost to a smudge. Nothing downstream can catch it.');

    // ---------------------------------------------------------------- step 3
    head('Core makes a draft — nothing is published, nothing is signed');
    const created = createCatalogDraft(
      {
        drafts,
        now: () => Date.now(),
        newDraftId: () => `draft-${randomBytes(6).toString('hex')}`,
        stamp: () => ({
          generatedAtIso: new Date().toISOString(),
          itemRevision: `rev-${randomBytes(4).toString('hex')}`,
        }),
      },
      {
        catalogId: CATALOG_ID,
        // The REAL row-source shape, built the way the ingress route builds
        // it — `sourceFromDraftRows` over the extraction's cells.
        source: sourceFromDraftRows(
          EXTRACTION.rows.map((r) => ({ row: r.row, cells: r.cells as Record<string, string> })),
        ),
        defaultScheme: 'sku',
        identity: { supplierDid: CHAIRMAKER.did, catalogId: CATALOG_ID },
        settings,
        provenanceClass: 'model_derived',
        extraction: { model: EXTRACTION.model, schemaVersion: EXTRACTION.schemaVersion },
      },
    );
    const fresh: CatalogDraft = created.draft;
    const draftId = fresh.draftId;
    check(fresh.state === 'created', `draft ${draftId} is 'created'`);
    check(fresh.items.length === 3, `${String(fresh.items.length)} items assembled`);
    check(fresh.publishClaim === null, 'no publication is holding it');
    check(fresh.findings.length === 0, 'the source imported with no findings');
    if (fresh.findings.length > 0) {
      for (const f of fresh.findings) note(`finding: ${JSON.stringify(f)}`);
    }

    // ---------------------------------------------------------------- step 4
    head('What the seller is asked to vouch for');
    const prov = fresh.provenance;
    const proposed: string[] = [];
    const exempt: string[] = [];
    for (const [idx, fields] of Object.entries(prov)) {
      for (const [field, state] of Object.entries(fields)) {
        (state === 'proposed' ? proposed : exempt).push(`${idx}.${field}`);
      }
    }
    say(`   waiting on a person  ${String(proposed.length)} fields`);
    say(`   exempt (not the model's) ${String(exempt.length)} fields`);
    note(`exempt: ${[...new Set(exempt.map((f) => f.split('.')[1]))].join(', ')}`);
    check(
      exempt.every((f) => !f.endsWith('.indicative_price')),
      'no price is exempt — a price is always the model\'s digits',
    );

    const service = new CatalogDraftService({
      drafts,
      pointers,
      sha256,
      now: () => Date.now(),
      newClaimToken: () => `pcl_${randomBytes(16).toString('hex')}`,
      // THE REAL PRESENCE PATH, same call the routes make. Proven below by a
      // passphrase, and it expires: this is not a constant.
      userPresent: () => ownerPresentNow(Date.now()),
      publicationFence: () => null,
      publish: async ({ draft }) =>
        publishHeldDraft(
          {
            fence: () => null,
            // WHAT THE ROUTE DOES, not a stub. This row is where the NEXT
            // publication gets its sequence, its predecessor and its CAS —
            // stubbing it out is how the first run of this script republished
            // at sequence 1 and clobbered its own live head.
            recordPublication: (catalogId, pointer, pointerCid) => {
              pointers.put({
                catalogId,
                pointer,
                pointerCid,
                snapshotDigest: pointer.snapshot_digest ?? '',
                withdrawn: pointer.withdrawn === true,
                publishedAtMs: Date.parse(pointer.published_at),
              });
            },
          },
          draft,
        ),
    });

    // ---------------------------------------------------------------- step 5
    head('ChairMaker unlocks to work on the draft');
    installOwnerPresenceVerifier(async (p) => p === 'correct horse battery staple');
    check(ownerPresenceCanBeEstablished(), 'this node can check the owner\u2019s passphrase');
    check(!ownerPresentNow(Date.now()), 'and nobody is present until somebody proves it');
    check(
      !(await proveOwnerPresence('hunter2', Date.now())),
      'a wrong passphrase proves nothing',
    );
    check(
      await proveOwnerPresence('correct horse battery staple', Date.now()),
      'the right one does',
    );
    check(ownerPresentNow(Date.now()), 'a person is now present, for five minutes');

    // ---------------------------------------------------------------- step 6
    head('The seller tries to skip the review — and cannot');
    const early = service.confirm(draftId);
    check(!early.ok, `confirm refused: ${early.ok ? '' : early.refusal}`);
    if (!early.ok) note(early.error.slice(0, 150));
    note('This is the whole lane in one refusal. A machine-invented price');
    note('cannot become a signed public commitment on its own.');

    // ---------------------------------------------------------------- step 6
    head('ChairMaker spots the chair price and repairs it');
    const before = drafts.get(draftId)?.items.find((i) => i.product.value === 'CM-CHAIR-1');
    say(`   model read           ₹${(Number(before?.indicative_price?.minor_units ?? 0) / 100).toLocaleString('en-IN')}`);
    const chairIndex = (drafts.get(draftId)?.items ?? []).findIndex(
      (i) => i.product.value === 'CM-CHAIR-1',
    );
    const repaired = service.editValue(draftId, `${String(chairIndex)}.indicative_price`, {
      currency: 'INR',
      minor_units: TRUE_CHAIR_PRICE_MINOR,
    });
    check(repaired.ok, 'the seller\'s correction was accepted');
    if (!repaired.ok) note(repaired.error);
    const after = drafts.get(draftId)?.items[chairIndex];
    say(`   seller corrected to  ₹${(Number(after?.indicative_price?.minor_units ?? 0) / 100).toLocaleString('en-IN')}`);
    const chairProv = drafts.get(draftId)?.provenance[String(chairIndex)] ?? {};
    check(
      chairProv.indicative_price === 'edited',
      `the price now reads '${String(chairProv.indicative_price)}', not 'accepted'`,
    );
    note("'edited' means the seller WROTE it. 'accepted' means they vouched for");
    note('what a model produced. The receipt must not confuse the two.');

    // ---------------------------------------------------------------- step 7
    head('ChairMaker reads the other two rows and accepts them');
    const stillProposed: string[] = [];
    for (const [idx, fields] of Object.entries(drafts.get(draftId)?.provenance ?? {})) {
      for (const [field, state] of Object.entries(fields)) {
        if (state === 'proposed') stillProposed.push(`${idx}.${field}`);
      }
    }
    say(`   accepting            ${String(stillProposed.length)} fields`);
    const accepted = service.accept(draftId, stillProposed);
    check(accepted.ok, 'acceptance recorded');
    if (!accepted.ok) note(accepted.error);

    // ---------------------------------------------------------------- step 8
    head('Confirm — Core mints a receipt over what the seller vouched for');
    const confirmed = service.confirm(draftId);
    check(confirmed.ok, 'confirmed');
    if (!confirmed.ok) {
      note(confirmed.error);
      throw new Error('cannot continue');
    }
    say(`   receipt digest       ${confirmed.value.receipt?.digest.slice(0, 32) ?? ''}…`);
    say(`   at content revision  ${String(confirmed.value.receipt?.revision)}`);

    // ---------------------------------------------------------------- step 9
    head('Prepare — the bytes that will be signed are built and held');
    const prepared = await service.prepare(draftId, {
      protocolVersion: '1.0',
      publishedAt: new Date().toISOString(),
    });
    check(prepared.ok, 'snapshot, pages and pointer built');
    if (!prepared.ok) {
      note(prepared.error);
      throw new Error('cannot continue');
    }
    const held = prepared.value.held;
    if (held === null) throw new Error('nothing held');
    say(`   snapshot digest      ${held.snapshot.snapshot_digest.slice(0, 32)}…`);
    say(`   items                ${String(held.snapshot.item_count)}`);
    say(`   pages                ${String(held.pages.length)}`);
    say(`   sequence             ${String(held.pointer.snapshot_sequence)}`);
    say(`   previous             ${held.pointer.previous_snapshot_digest ?? '(first publication)'}`);

    // --------------------------------------------------------------- step 10
    head('Approve — the seller approves THESE bytes, by digest');
    const approved = service.approve(draftId, held.snapshot.snapshot_digest);
    check(approved.ok, 'approval recorded against the exact digest');
    const wrongDigest = service.approve(draftId, 'f'.repeat(64));
    check(!wrongDigest.ok, 'a different digest is refused');

    // --------------------------------------------------------------- step 11
    head('Publish — the records leave the machine');
    const jwt = await pdsSession();
    ok('signed in to the PDS');
    installCatalogRecordWriter(livePdsWriter(jwt));
    installCatalogRecordReader(livePdsReader());

    const published = await service.publish(draftId);
    check(published.ok, 'published');
    if (!published.ok) {
      note(published.error);
      throw new Error('publication failed');
    }
    const pub = published.value.publication;
    say(`   pointer cid          ${pub?.pointerCid ?? ''}`);
    say(`   snapshot cid         ${pub?.snapshotCid ?? ''}`);
    check(published.value.state === 'published', 'the draft is terminal');
    check(drafts.get(draftId)?.publishClaim === null, 'the publication lease was released');

    // --------------------------------------------------------------- step 12
    head('A stranger fetches the catalog holding only ChairMaker\'s DID');
    const stranger = async (collection: string, rkey: string): Promise<unknown> => {
      const url = `${PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(CHAIRMAKER.did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${collection}/${rkey}: HTTP ${String(res.status)}`);
      return ((await res.json()) as { value: unknown }).value;
    };

    // The rkey a stranger DERIVES from the catalog id, not one we tell them.
    const pointerRkey = catalogPointerRkey(CATALOG_ID);
    say(`   pointer rkey         ${pointerRkey}`);
    const livePointer = (await stranger(
      CATALOG_POINTER_NSID,
      pointerRkey,
    )) as Record<string, unknown>;
    check(validateCatalogPointer(livePointer) === null, 'the live pointer is a valid pointer record');
    check(
      livePointer.snapshot_digest === held.snapshot.snapshot_digest,
      'the live head names the digest ChairMaker approved',
    );

    const liveRecord = (await stranger(
      CATALOG_SNAPSHOT_NSID,
      String(livePointer.snapshot_rkey),
    )) as Record<string, unknown>;
    // THE RECORD IS A WRAPPER: `{ $type, snapshot, pages }`. The snapshot's
    // own fields sit one level down, which is what keeps the PDS's `$type` out
    // of the digested bytes — a flat record would have had the server add a
    // key after the digest was taken over it.
    const liveSnapshot = liveRecord.snapshot as Record<string, unknown>;
    check(liveRecord.$type === CATALOG_SNAPSHOT_NSID, 'the PDS stamped the record with its NSID');
    check(
      validateCatalogSnapshot(liveSnapshot) === null,
      `the live snapshot is a valid snapshot: ${String(validateCatalogSnapshot(liveSnapshot))}`,
    );

    // --------------------------------------------------------------- step 13
    head('The stranger re-derives every digest from the bytes on the wire');
    const livePages = liveRecord.pages as Record<string, unknown>[] | undefined;
    check(Array.isArray(livePages) && livePages.length > 0, 'pages travelled with the snapshot');

    const pageDigests = (livePages ?? []).map((p) => catalogPageDigest(p as never, sha256));
    check(
      JSON.stringify(pageDigests) === JSON.stringify(liveSnapshot.page_digests),
      'each page re-digests to the value the snapshot commits to',
    );
    const root = catalogPayloadRoot(pageDigests, sha256);
    check(root === liveSnapshot.payload_root, 'the payload root re-derives from the page digests');
    const snapDigest = catalogSnapshotDigest(liveSnapshot as never, sha256);
    check(snapDigest === liveSnapshot.snapshot_digest, 'the snapshot re-digests to its own digest');
    check(
      snapDigest === held.snapshot.snapshot_digest,
      'and it is byte-for-byte what the seller approved',
    );

    // --------------------------------------------------------------- step 14
    head('What the buyer actually sees');
    const items = (livePages ?? []).flatMap((p) => (p.items as Record<string, unknown>[]) ?? []);
    for (const it of items) {
      const price = it.indicative_price as { minor_units?: string; currency?: string } | undefined;
      const rupees = price === undefined ? '—' : `₹${(Number(price.minor_units) / 100).toLocaleString('en-IN')}`;
      say(`   ${String(it.name).padEnd(28)} ${rupees.padStart(12)}   ${String((it.category_ids as string[])[0])}`);
    }
    const chair = items.find((i) => (i.product as { value: string }).value === 'CM-CHAIR-1');
    const chairPrice = (chair?.indicative_price as { minor_units?: string } | undefined)?.minor_units;
    check(
      chairPrice === TRUE_CHAIR_PRICE_MINOR,
      'the published chair price is the SELLER\'S ₹18,000, not the model\'s ₹1,800',
    );
    check(
      items.every((i) => (i.fulfilment_regions as { value: string }[])[0]?.value === 'IN-KA'),
      'every item ships where ChairMaker said, not where a model guessed',
    );

    // --------------------------------------------------------------- step 15
    head('A repeat publish does not publish twice');
    const again = await service.publish(draftId);
    check(again.ok, 'the retry returns the existing publication');
    if (again.ok) {
      check(
        again.value.publication?.pointerCid === pub?.pointerCid,
        'and it is the same pointer, not a second one',
      );
    }

    // --------------------------------------------------------------- step 16
    head('A month later, ChairMaker raises the bench price');
    // A SECOND PUBLICATION IS WHERE CHAINS BREAK. The pointer carries
    // `previous_snapshot_digest` and a compare-and-swap against the live head,
    // and neither is exercised by a first publication — the case every catalog
    // hits on day two and no first-run test can reach.
    const second = createCatalogDraft(
      {
        drafts,
        now: () => Date.now(),
        newDraftId: () => `draft-${randomBytes(6).toString('hex')}`,
        stamp: () => ({
          generatedAtIso: new Date().toISOString(),
          itemRevision: `rev-${randomBytes(4).toString('hex')}`,
        }),
      },
      {
        catalogId: CATALOG_ID,
        source: sourceFromDraftRows([
          { row: 2, cells: { sku: 'CM-STOOL-1', name: 'Oak workshop stool', unit_code: 'each', pack_size: '1', currency: 'INR', list_price_minor_units: '450000' } },
          { row: 3, cells: { sku: 'CM-BENCH-2', name: 'Teak garden bench, 4ft', unit_code: 'each', pack_size: '1', currency: 'INR', list_price_minor_units: '1390000' } },
          { row: 4, cells: { sku: 'CM-CHAIR-1', name: 'Oak dining chair', unit_code: 'each', pack_size: '1', currency: 'INR', list_price_minor_units: '1800000' } },
        ]),
        defaultScheme: 'sku',
        identity: { supplierDid: CHAIRMAKER.did, catalogId: CATALOG_ID },
        settings,
        provenanceClass: 'model_derived',
        extraction: { model: EXTRACTION.model, schemaVersion: EXTRACTION.schemaVersion },
      },
    );
    const id2 = second.draft.draftId;
    const toAccept: string[] = [];
    for (const [idx, fields] of Object.entries(second.draft.provenance)) {
      for (const [field, state] of Object.entries(fields)) {
        if (state === 'proposed') toAccept.push(`${idx}.${field}`);
      }
    }
    service.accept(id2, toAccept);
    check(service.confirm(id2).ok, 'the new list is confirmed');
    const prep2 = await service.prepare(id2, {
      protocolVersion: '1.0',
      publishedAt: new Date().toISOString(),
    });
    check(prep2.ok, 'prepared against the live head');
    if (!prep2.ok) {
      note(prep2.error);
      throw new Error('cannot continue');
    }
    const held2 = prep2.value.held;
    if (held2 === null) throw new Error('nothing held');
    say(`   sequence             ${String(held2.pointer.snapshot_sequence)}`);
    say(`   previous             ${(held2.pointer.previous_snapshot_digest ?? '').slice(0, 32)}…`);
    check(held2.pointer.snapshot_sequence === 2, 'the sequence advanced to 2');
    check(
      held2.pointer.previous_snapshot_digest === held.snapshot.snapshot_digest,
      'the new head names the FIRST publication as its predecessor',
    );
    check(
      held2.expectedPointerCid === pub?.pointerCid,
      'and it will compare-and-swap against the CID the repo actually holds',
    );

    service.approve(id2, held2.snapshot.snapshot_digest);
    const published2 = await service.publish(id2);
    check(published2.ok, 'the second publication landed');
    if (!published2.ok) note(published2.error);

    // --------------------------------------------------------------- step 17
    head('The stranger comes back and sees the new prices');
    const head2 = (await stranger(CATALOG_POINTER_NSID, pointerRkey)) as Record<string, unknown>;
    check(head2.snapshot_sequence === 2, 'the live head is now sequence 2');
    check(
      head2.previous_snapshot_digest === held.snapshot.snapshot_digest,
      'and the chain back to the first publication is intact on the wire',
    );
    const rec2 = (await stranger(CATALOG_SNAPSHOT_NSID, String(head2.snapshot_rkey))) as Record<string, unknown>;
    const items2 = ((rec2.pages as Record<string, unknown>[]) ?? []).flatMap(
      (p) => (p.items as Record<string, unknown>[]) ?? [],
    );
    const bench = items2.find((i) => (i.product as { value: string }).value === 'CM-BENCH-2');
    const benchPrice = (bench?.indicative_price as { minor_units?: string } | undefined)?.minor_units;
    say(`   bench now            ₹${(Number(benchPrice) / 100).toLocaleString('en-IN')}`);
    check(benchPrice === '1390000', 'the buyer sees the new bench price');
    // The FIRST snapshot is still fetchable — snapshots are immutable records
    // at content-addressed keys, so history is not rewritten by a new head.
    const oldStill = await stranger(CATALOG_SNAPSHOT_NSID, held.snapshot.snapshot_digest);
    check(oldStill !== null, 'and last month\u2019s snapshot is still there, unchanged');

    // --------------------------------------------------------------- step 18
    head('ChairMaker reinstalls on a new phone — same DID, empty local store');
    // NOT A HYPOTHETICAL. `prepare` reads the sequence, the predecessor and
    // the CAS token out of THIS NODE'S pointer store. A node that has the
    // identity but not that row — a new phone, a re-pair, a backup older than
    // the last publication — derives sequence 1 with no predecessor, and the
    // pointer write carries no swap token because there is nothing to swap
    // against. The head write then succeeds unconditionally.
    //
    // The first run of this script did exactly this by accident and clobbered
    // its own live chain, which is why it is now a deliberate probe.
    const newPhone = new SQLiteCatalogPointerRepository(adapter2);
    const newPhoneService = new CatalogDraftService({
      drafts: drafts2,
      pointers: newPhone,
      sha256,
      now: () => Date.now(),
      newClaimToken: () => `pcl_${randomBytes(16).toString('hex')}`,
      userPresent: () => ownerPresentNow(Date.now()),
      publicationFence: () => null,
      publish: async ({ draft }) =>
        publishHeldDraft({ fence: () => null, recordPublication: () => undefined }, draft),
    });
    const reinstall = createCatalogDraft(
      {
        drafts: drafts2,
        now: () => Date.now(),
        newDraftId: () => `draft-${randomBytes(6).toString('hex')}`,
        stamp: () => ({
          generatedAtIso: new Date().toISOString(),
          itemRevision: `rev-${randomBytes(4).toString('hex')}`,
        }),
      },
      {
        catalogId: CATALOG_ID,
        source: sourceFromDraftRows([
          { row: 2, cells: { sku: 'CM-STOOL-1', name: 'Oak workshop stool', unit_code: 'each', pack_size: '1', currency: 'INR', list_price_minor_units: '450000' } },
        ]),
        defaultScheme: 'sku',
        identity: { supplierDid: CHAIRMAKER.did, catalogId: CATALOG_ID },
        settings,
        provenanceClass: 'owner_authored',
        extraction: null,
      },
    );
    const id3 = reinstall.draft.draftId;
    newPhoneService.confirm(id3);
    const prep3 = await newPhoneService.prepare(id3, {
      protocolVersion: '1.0',
      publishedAt: new Date().toISOString(),
    });
    if (!prep3.ok) throw new Error(`prepare on the new phone: ${prep3.error}`);
    const held3 = prep3.value.held;
    if (held3 === null) throw new Error('nothing held');
    say(`   derived sequence     ${String(held3.pointer.snapshot_sequence)}  (the live head is 2)`);
    say(`   derived previous     ${held3.pointer.previous_snapshot_digest ?? '(none)'}`);
    say(`   CAS token            ${held3.expectedPointerCid === '' ? '(none — unconditional write)' : held3.expectedPointerCid}`);
    newPhoneService.approve(id3, held3.snapshot.snapshot_digest);
    const clobber = await newPhoneService.publish(id3);
    const headAfter = (await stranger(CATALOG_POINTER_NSID, pointerRkey)) as Record<string, unknown>;
    say(`   live head is now     sequence ${String(headAfter.snapshot_sequence)}`);
    if (clobber.ok && headAfter.snapshot_sequence === 1) {
      no('THE LIVE CHAIN WAS OVERWRITTEN: sequence went 2 → 1, predecessor lost');
      note('A node holding the identity but not the pointer row republishes from');
      note('scratch. Nothing reconciles the derived sequence against the live');
      note('head, and with no CAS token the write cannot lose. §16.2 fences a');
      note('RESTORE; a new device with the same DID is not a restore.');
      failures += 1;
    } else if (!clobber.ok) {
      ok(`refused: ${clobber.refusal} — the divergence was caught`);
    } else {
      ok('the head did not regress');
    }

    // --------------------------------------------------------------- step 19
    head('Can a buyer DISCOVER this without knowing the DID?');
    // The honest question. Everything above needed ChairMaker's DID. Discovery
    // is the AppView's job, and the deployed one predates the commerce methods.
    const av = await fetch(
      'https://test-appview.dinakernel.com/xrpc/com.dinakernel.commerce.searchCatalog?q=oak%20chair',
    ).catch(() => null);
    if (av === null) {
      no('test-appview did not answer');
    } else {
      const text = (await av.text()).slice(0, 160);
      say(`   HTTP ${String(av.status)}  ${text}`);
      note('Discovery needs an AppView redeploy carrying the commerce xRPC');
      note('methods. Not a defect in the lane; a deployment that has not happened.');
    }

    console.log(`\n${'═'.repeat(74)}`);
    if (failures === 0) {
      console.log(`  JOURNEY COMPLETE — every check passed.`);
    } else {
      console.log(`  ${String(failures)} CHECK(S) FAILED.`);
    }
    console.log(`  Catalog is live at:`);
    console.log(`    ${PDS}/xrpc/com.atproto.repo.getRecord?repo=${CHAIRMAKER.did}`);
    console.log(`      &collection=${CATALOG_POINTER_NSID}&rkey=${catalogPointerRkey(CATALOG_ID)}`);
    console.log(`${'═'.repeat(74)}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    installCatalogRecordWriter(null);
    installCatalogRecordReader(null);
    installOwnerPresenceVerifier(null);
    adapter.close();
    adapter2.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(`\nJOURNEY FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
