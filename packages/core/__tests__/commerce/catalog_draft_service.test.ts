/**
 * The four operations and the state machine (§6).
 *
 * These are the lane's safety properties, so the tests are adversarial rather
 * than demonstrative: for every rule there is a case that BREAKS it and a
 * mirror case proving the rule is not simply "always refuse". A suite that
 * only walked the happy path would pass against an implementation that
 * published whatever it was handed.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  catalogContentReceiptDigest,
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  type CatalogItem,
  type CatalogPointer,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { InMemoryAttributionBoundaryRepository } from '../../src/commerce/attribution_boundary';
import { CatalogDraftService } from '../../src/commerce/catalog_draft_service';
import {
  InMemoryCatalogDraftRepository,
  type CatalogDraft,
  type ProvenanceClass,
} from '../../src/commerce/catalog_draft_store';
import { InMemoryCatalogPointerRepository } from '../../src/commerce/catalog_pointer_store';
import {
  installCatalogRecordReader,
  installCatalogRecordWriter,
} from '../../src/commerce/catalog_record_writer';

const SUPPLIER = 'did:plc:chairmaker99';
const OWNER_DID = SUPPLIER;
const CATALOG = 'chairmaker-main';
const hash: Sha256Fn = (d) => sha256(d);

function item(): CatalogItem {
  return {
    product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    item_revision: 'rev-1',
    name: 'Oak dining chair',
    category_ids: ['furniture.seating'],
    pack: { sell_unit: { value: '1', unit_code: 'each' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-13T09:00:00.000Z' },
  };
}

/** Every field accepted, which is what `confirm` requires. */
function acceptedProvenance(it: CatalogItem): CatalogDraft['provenance'] {
  const fields: Record<string, 'accepted'> = {};
  for (const key of Object.keys(it)) fields[key] = 'accepted';
  return { '0': fields };
}

function makeDraft(overrides: Partial<CatalogDraft> = {}): CatalogDraft {
  const it = item();
  return {
    draftId: 'draft-1',
    catalogId: CATALOG,
    state: 'created',
    provenanceClass: 'model_derived',
    defaultScheme: 'sku',
    publishClaim: null,
    extraction: { model: 'test-extractor', schemaVersion: '1' },
    photoExtraction: null,
    contentRevision: 0,
    rows: [],
    findings: [],
    provenance: acceptedProvenance(it),
    items: [it],
    generatedAtIso: '2026-08-13T09:00:00.000Z',
    itemRevision: 'rev-1',
    receipt: null,
    held: null,
    approval: null,
    publication: null,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

type PublishOutcome =
  | { ok: true; pointerCid: string; snapshotCid: string; pointer?: CatalogPointer }
  | { ok: false; error: string; lostSwap: boolean };

interface Harness {
  service: CatalogDraftService;
  drafts: InMemoryCatalogDraftRepository;
  setPresent: (v: boolean) => void;
  setFenced: (v: boolean) => void;
  setPublishResult: (r: PublishOutcome) => void;
  /** Runs INSIDE the publish await — the window a racing edit would land in. */
  setPublishHook: (fn: () => void | Promise<void>) => void;
  /** Makes the next publish REJECT rather than resolve. */
  setPublishThrows: (v: boolean) => void;
  /** Moves the shared clock, so TTL behaviour is driven rather than waited for. */
  advanceClock: (ms: number) => void;
  /**
   * A SECOND service over the same store — a second process, or this one after
   * a restart. The only way to test a lease is to have two claimants.
   */
  other: CatalogDraftService;
  publishCalls: () => number;
  /** §6.4 — the harness boundary; cross it to test v2-exclusive minting. */
  boundary: InMemoryAttributionBoundaryRepository;
  setVoucher: (v: string | null) => void;
}

function harness(
  seed: CatalogDraft = makeDraft(),
  pointers: InMemoryCatalogPointerRepository = new InMemoryCatalogPointerRepository(),
): Harness {
  const drafts = new InMemoryCatalogDraftRepository();
  drafts.put(seed);
  let present = true;
  let fenced = false;
  // §6.4 — the default harness sits BEFORE the attribution boundary
  // (v1 minting, the shipped behaviour); tests cross it explicitly.
  const boundary = new InMemoryAttributionBoundaryRepository();
  let voucher: string | null = OWNER_DID;
  let calls = 0;
  let hook: () => void | Promise<void> = () => undefined;
  let throws = false;
  let clock = 1_800_000_500_000;
  let result: PublishOutcome = {
    ok: true,
    pointerCid: 'cid-pointer',
    snapshotCid: 'cid-snapshot',
  };
  // Two services over ONE store, because that is what the lease is for. Their
  // token streams are prefixed so a test can say WHICH claimant holds the
  // draft rather than only that someone does.
  const mkService = (label: string): CatalogDraftService => {
    let tokens = 0;
    return new CatalogDraftService({
      drafts,
      pointers,
      sha256: hash,
      now: () => clock,
      newClaimToken: () => `${label}-${String((tokens += 1))}`,
      userPresent: () => present,
      publicationFence: () => (fenced ? 'superseded' : null),
      attributionBoundary: boundary,
      vouchedBy: () => voucher,
      publish: async () => {
        calls += 1;
        await hook();
        if (throws) throw new Error('the pointer store is unavailable');
        return result;
      },
    });
  };
  return {
    service: mkService('a'),
    other: mkService('b'),
    drafts,
    setPresent: (v) => (present = v),
    setFenced: (v) => (fenced = v),
    setPublishResult: (r) => (result = r),
    setPublishHook: (fn) => (hook = fn),
    setPublishThrows: (v) => (throws = v),
    advanceClock: (ms) => (clock += ms),
    publishCalls: () => calls,
    boundary,
    setVoucher: (v) => (voucher = v),
  };
}

/** Walk a draft to `approved` so publish cases start from a real state. */
async function toApproved(h: Harness): Promise<CatalogDraft> {
  const confirmed = h.service.confirm('draft-1');
  if (!confirmed.ok) throw new Error(`confirm: ${confirmed.error}`);
  const prepared = await h.service.prepare('draft-1', {
    protocolVersion: '1.0',
    publishedAt: '2026-08-13T09:00:00.000Z',
  });
  if (!prepared.ok) throw new Error(`prepare: ${prepared.error}`);
  const digest = prepared.value.held?.snapshot.snapshot_digest ?? '';
  const approved = h.service.approve('draft-1', digest);
  if (!approved.ok) throw new Error(`approve: ${approved.error}`);
  return approved.value;
}

describe('the order is enforced, not assumed', () => {
  it('refuses every operation on a draft in the wrong state', async () => {
    const h = harness();
    // prepare and approve both run before confirm has happened.
    expect(await h.service.prepare('draft-1', { protocolVersion: '1.0', publishedAt: 'x' })).toMatchObject({
      ok: false,
      refusal: 'wrong_state',
    });
    expect(h.service.approve('draft-1', 'anything')).toMatchObject({
      ok: false,
      refusal: 'wrong_state',
    });
  });

  it('walks created → confirmed → prepared → approved → published', async () => {
    const h = harness();
    await toApproved(h);
    const published = await h.service.publish('draft-1');
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value.state).toBe('published');
    expect(published.value.publication).not.toBeNull();
  });

  it('a repeat publish returns the existing publication, writing nothing new', async () => {
    const h = harness();
    await toApproved(h);
    await h.service.publish('draft-1');
    const again = await h.service.publish('draft-1');
    expect(again.ok).toBe(true);
    // Asserted on the WRITE COUNT, not on the returned status: a second
    // publication of a catalog already on the wire is the harm, and an
    // implementation that returned ok while writing again would pass a
    // status-only check.
    expect(h.publishCalls()).toBe(1);
  });
});

describe('the content receipt', () => {
  it('is minted by Core at confirm, and is not something a caller supplies', () => {
    const h = harness();
    const confirmed = h.service.confirm('draft-1');
    if (!confirmed.ok) throw new Error(confirmed.error);
    expect(confirmed.value.receipt).not.toBeNull();
    // It commits to the items, the provenance AND the revision.
    const expected = catalogContentReceiptDigest(
      {
        items: confirmed.value.items,
        provenance: confirmed.value.provenance,
        extraction: confirmed.value.extraction,
        contentRevision: confirmed.value.contentRevision,
      },
      hash,
    );
    expect(confirmed.value.receipt?.digest).toBe(expected);
  });

  it('refuses to confirm while any model-derived field is still proposed', () => {
    const it = item();
    const h = harness(makeDraft({ provenance: { '0': { ...acceptedProvenance(it)['0'], name: 'proposed' } } }));
    expect(h.service.confirm('draft-1')).toMatchObject({
      ok: false,
      refusal: 'unconfirmed_field',
    });
  });

  it('treats a field with NO recorded provenance as proposed', () => {
    // The missing case must block. Core writes provenance, so a field it has
    // no record for is one it cannot vouch for.
    const h = harness(makeDraft({ provenance: {} }));
    expect(h.service.confirm('draft-1')).toMatchObject({
      ok: false,
      refusal: 'unconfirmed_field',
    });
  });

  it('refuses publication when the stored receipt does not match the stored items', async () => {
    // The receipt is re-derived, not trusted. A row edited after writing —
    // items changed, receipt left behind — must not publish.
    const h = harness();
    await toApproved(h);
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('missing');
    h.drafts.put({
      ...draft,
      items: [{ ...item(), name: 'Something else entirely' }],
    });
    const published = await h.service.publish('draft-1');
    expect(published).toMatchObject({ ok: false, refusal: 'digest_mismatch' });
    expect(h.publishCalls()).toBe(0);
  });
});

describe('the class-conditional rule, in both directions', () => {
  it.each(['owner_authored', 'source_parsed'] as ProvenanceClass[])(
    'a %s draft confirms with no presence and no receipt',
    (provenanceClass) => {
      // Nothing was inferred, so there is nothing for a person to attest to.
      // Without this the exemption would be dead and every connector
      // republication would need a human at a screen.
      const h = harness(makeDraft({ provenanceClass, provenance: {} }));
      h.setPresent(false);
      const confirmed = h.service.confirm('draft-1');
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.receipt).toBeNull();
    },
  );

  it('a model_derived draft REFUSES to confirm without presence', () => {
    const h = harness();
    h.setPresent(false);
    expect(h.service.confirm('draft-1')).toMatchObject({
      ok: false,
      refusal: 'no_user_presence',
    });
  });

  it('approve requires presence on EVERY class, including the exempt ones', async () => {
    // §12.1 step 11 binds the published bytes and does not care where the
    // values came from, so the confirm exemption must not reach here. This is
    // the test that stops "same presence requirement as confirm" being read as
    // "also class-conditional".
    const h = harness(makeDraft({ provenanceClass: 'source_parsed', provenance: {} }));
    h.service.confirm('draft-1');
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    h.setPresent(false);
    expect(h.service.approve('draft-1', prepared.value.held?.snapshot.snapshot_digest ?? '')).toMatchObject({
      ok: false,
      refusal: 'no_user_presence',
    });
  });
});

describe('approve compares against the snapshot Core is holding', () => {
  it('refuses a digest that is not the held snapshot', async () => {
    // The client holds the owner capability, so a caller that could NAME the
    // approved digest would be approving its own snapshot — the software
    // asking itself.
    const h = harness();
    h.service.confirm('draft-1');
    await h.service.prepare('draft-1', { protocolVersion: '1.0', publishedAt: '2026-08-13T09:00:00.000Z' });
    expect(h.service.approve('draft-1', 'f'.repeat(64))).toMatchObject({
      ok: false,
      refusal: 'digest_mismatch',
    });
  });
});

describe('an edit during the pause', () => {
  it('voids the receipt, the held bytes and the approval together', async () => {
    const h = harness();
    await toApproved(h);
    // Through the OWNER'S operation, not the private write it shares with
    // `accept`: this is the seller correcting a name on a draft that already
    // holds an approved snapshot.
    const edited = h.service.editValue('draft-1', '0.name', 'Edited');
    if (!edited.ok) throw new Error(edited.error);
    expect(edited.value.state).toBe('created');
    expect(edited.value.receipt).toBeNull();
    expect(edited.value.held).toBeNull();
    expect(edited.value.approval).toBeNull();
    expect(edited.value.contentRevision).toBe(1);
  });

  it('publishes NOTHING when the draft moved after approval', async () => {
    // THE CASE THE WHOLE REVISION RULE EXISTS FOR. A seller edits during the
    // review pause and re-confirms: the new receipt is current, while the held
    // bytes and the approval still carry the pre-edit content. Only the
    // revision comparison catches it, and without this the lane publishes
    // exactly what the seller removed.
    const h = harness();
    await toApproved(h);
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('missing');
    // Simulate the dangerous shape directly: content moved on, receipt
    // refreshed at the new revision, held bytes and approval left behind.
    const movedItems = [{ ...item(), name: 'Edited after approval' }];
    h.drafts.put({
      ...draft,
      contentRevision: draft.contentRevision + 1,
      items: movedItems,
      receipt: {
        digest: catalogContentReceiptDigest(
          {
            items: movedItems,
            provenance: draft.provenance,
            contentRevision: draft.contentRevision + 1,
            // THE SAME ARGUMENTS CORE USES. A fixture that computes a digest
            // its own way stops testing the rule it is named for the moment
            // the preimage gains a field — this one would have started
            // reporting `digest_mismatch` for a revision defect.
            extraction: draft.extraction,
          },
          hash,
        ),
        revision: draft.contentRevision + 1,
        vouchedBy: null,
      },
    });
    const published = await h.service.publish('draft-1');
    expect(published).toMatchObject({ ok: false, refusal: 'stale_revision' });
    expect(h.publishCalls()).toBe(0);
  });
});

describe('publish', () => {
  it('re-checks the §16.2 fence BEFORE the first write', async () => {
    // The shipped route checks at request start and again before the pointer,
    // which was sound when build and write were milliseconds apart. An owner
    // decision now sits between them.
    const h = harness();
    await toApproved(h);
    h.setFenced(true);
    expect(await h.service.publish('draft-1')).toMatchObject({ ok: false, refusal: 'fenced' });
    expect(h.publishCalls()).toBe(0);
  });

  it('refuses when no approval was recorded through the approve operation', async () => {
    const h = harness();
    h.service.confirm('draft-1');
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    // Move to `approved` WITHOUT going through approve — the shape a caller
    // would produce by supplying a digest in the publish call.
    h.drafts.put({ ...prepared.value, state: 'approved' });
    const published = await h.service.publish('draft-1');
    expect(published).toMatchObject({ ok: false, refusal: 'missing_approval' });
    expect(h.publishCalls()).toBe(0);
  });

  it('resets to CONFIRMED on a lost swap, keeping the items and the receipt', async () => {
    // The head moved, so the held bytes are stale — a rebuild changes the
    // sequence, which `paginate` stamps into every page. Core performs the
    // reset itself so `prepare`'s precondition stays intact rather than being
    // widened. The receipt survives: a lost race did not touch the items.
    const h = harness();
    await toApproved(h);
    h.setPublishResult({ ok: false, error: 'InvalidSwap', lostSwap: true });
    expect(await h.service.publish('draft-1')).toMatchObject({ ok: false, refusal: 'publish_failed' });

    const after = h.drafts.get('draft-1');
    expect(after?.state).toBe('confirmed');
    expect(after?.held).toBeNull();
    expect(after?.approval).toBeNull();
    expect(after?.receipt).not.toBeNull();
    expect(after?.items).toHaveLength(1);
  });

  it('does NOT reset on a transient write failure — the head did not move', async () => {
    // The mirror. Rebuilding here would re-mint `published_at`, orphan a second
    // snapshot at the same chain position, and spend an owner review on a
    // network blip. The draft stays approved so the retry publishes the
    // already-approved bytes.
    const h = harness();
    await toApproved(h);
    h.setPublishResult({ ok: false, error: 'connection reset', lostSwap: false });
    await h.service.publish('draft-1');
    expect(h.drafts.get('draft-1')?.state).toBe('approved');
    expect(h.drafts.get('draft-1')?.approval).not.toBeNull();
  });

  it('publishes the HELD bytes rather than rebuilding them', async () => {
    // Survives a restart between approval and publish: the digest published is
    // the digest approved. A rebuild would re-mint `published_at` and change it.
    const h = harness();
    const approved = await toApproved(h);
    const approvedDigest = approved.held?.snapshot.snapshot_digest;
    const published = await h.service.publish('draft-1');
    if (!published.ok) throw new Error(published.error);
    expect(published.value.publication?.pointer.snapshot_digest).toBe(approvedDigest);
  });
});

describe('a published draft is terminal', () => {
  it('refuses an edit rather than reopening it', async () => {
    const h = harness();
    await toApproved(h);
    await h.service.publish('draft-1');
    expect(h.service.editValue('draft-1', '0.name', 'Too late')).toMatchObject({
      ok: false,
      refusal: 'wrong_state',
    });
  });
});

/**
 * Republishing over a catalog that is already live.
 *
 * EVERY OTHER PUBLISH CASE IN THIS FILE STARTS FROM AN EMPTY POINTER REPO, so
 * every one of them builds a GENESIS pointer — one with no predecessor to link
 * to. That is why a publish path that rebuilt the pointer from the snapshot's
 * fields passed the whole suite: the two fields it dropped are the two a
 * genesis pointer does not have.
 */
describe('the second publication, which is the one with a chain to break', () => {
  const HEAD_DIGEST = 'e'.repeat(64);

  function withLiveCatalog(): Harness {
    const pointers = new InMemoryCatalogPointerRepository();
    pointers.put({
      catalogId: CATALOG,
      pointer: {
        supplier_did: SUPPLIER,
        catalog_id: CATALOG,
        snapshot_sequence: 1,
        protocol_version: '1.0',
        published_at: '2026-08-01T09:00:00.000Z',
        snapshot_digest: HEAD_DIGEST,
        snapshot_rkey: HEAD_DIGEST,
      },
      pointerCid: 'cid-head',
      snapshotDigest: HEAD_DIGEST,
      withdrawn: false,
      publishedAtMs: 1_700_000_000_000,
    });
    return harness(makeDraft(), pointers);
  }

  it('holds the pointer the builder made, chain link and all', async () => {
    const h = withLiveCatalog();
    const confirmed = h.service.confirm('draft-1');
    if (!confirmed.ok) throw new Error(confirmed.error);
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
      serviceRkey: 'listing-2',
    });
    if (!prepared.ok) throw new Error(prepared.error);

    // THE TWO FIELDS THAT LIVE ONLY ON THE POINTER. Without them the repo
    // still accepts the write and AppView refuses the pointer for a broken
    // chain, so Core reports a publication buyers never see.
    expect(prepared.value.held?.pointer.previous_snapshot_digest).toBe(HEAD_DIGEST);
    expect(prepared.value.held?.pointer.service_rkey).toBe('listing-2');
    expect(prepared.value.held?.pointer.snapshot_sequence).toBe(2);
  });

  it('publishes the held pointer and records exactly what it published', async () => {
    const h = withLiveCatalog();
    const confirmed = h.service.confirm('draft-1');
    if (!confirmed.ok) throw new Error(confirmed.error);
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
      serviceRkey: 'listing-2',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    const approved = h.service.approve('draft-1', prepared.value.held?.snapshot.snapshot_digest ?? '');
    if (!approved.ok) throw new Error(approved.error);

    const published = await h.service.publish('draft-1');
    if (!published.ok) throw new Error(published.error);

    // The draft's own record of what it published must BE what it published.
    expect(published.value.publication?.pointer).toEqual(prepared.value.held?.pointer);
    expect(published.value.publication?.pointer.previous_snapshot_digest).toBe(HEAD_DIGEST);
    expect(published.value.publication?.pointer.service_rkey).toBe('listing-2');
  });

  it('records the LIVE pointer when the head has already moved past us', async () => {
    // §5 step 10's already-published case, where the head is one hop ahead:
    // the publication happened, this node lost the answer, and by the time it
    // retried a LATER publication had landed. The publisher reports success
    // and hands back the pointer that is actually live.
    //
    // Recording the held pointer beside the live CID would give this node a
    // head that never existed — sequence N's pointer under sequence N+1's
    // CID — and §10 item 8 nominates `publication` as the answer to "what did
    // this draft publish". A fabricated answer there is worse than none.
    const h = withLiveCatalog();
    const confirmed = h.service.confirm('draft-1');
    if (!confirmed.ok) throw new Error(confirmed.error);
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
      serviceRkey: 'listing-2',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    const held = prepared.value.held?.pointer;
    if (held === undefined) throw new Error('fixture');
    const approved = h.service.approve('draft-1', prepared.value.held?.snapshot.snapshot_digest ?? '');
    if (!approved.ok) throw new Error(approved.error);

    // The successor: our snapshot is its predecessor, which is exactly how the
    // publisher recognised this case.
    const successor: CatalogPointer = {
      ...held,
      snapshot_sequence: held.snapshot_sequence + 1,
      snapshot_digest: 'f'.repeat(64),
      previous_snapshot_digest: held.snapshot_digest,
      snapshot_rkey: 'snapshot-successor',
    };
    h.setPublishResult({
      ok: true,
      pointerCid: 'cid-successor',
      snapshotCid: '',
      pointer: successor,
    });

    const published = await h.service.publish('draft-1');
    if (!published.ok) throw new Error(published.error);

    expect(published.value.publication?.pointer).toEqual(successor);
    expect(published.value.publication?.pointerCid).toBe('cid-successor');
    // Not the held one, which is the mistake this exists to catch.
    expect(published.value.publication?.pointer).not.toEqual(held);
  });

  it('survives a restart between approval and publish with the link intact', async () => {
    // The held pointer is durable state, not something recomputed on the way
    // out — which is the whole reason it is on the draft rather than in a
    // closure.
    const h = withLiveCatalog();
    const confirmed = h.service.confirm('draft-1');
    if (!confirmed.ok) throw new Error(confirmed.error);
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-13T09:00:00.000Z',
      serviceRkey: 'listing-2',
    });
    if (!prepared.ok) throw new Error(prepared.error);
    const reread = h.drafts.get('draft-1');
    expect(reread?.held?.pointer).toEqual(prepared.value.held?.pointer);
  });
});

/**
 * §6's first named rule: "Core requires a content receipt for `model_derived`
 * drafts and refuses to publish one without it."
 *
 * IT WAS IMPLEMENTED AND UNTESTED. Every publish case above reaches `approved`
 * through `toApproved`, which calls `confirm`, and `confirm` on a model-derived
 * draft always mints the receipt — so the `receipt === null` branch was
 * unreachable from the suite and `missing_receipt` appeared nowhere in it. The
 * rule could have been deleted with the suite green.
 *
 * The state is reachable in production: `readProvenanceClass` fails an
 * unreadable `provenance_class` column CLOSED to `model_derived`, so an
 * `owner_authored` draft whose class column is corrupted comes back
 * model-derived with no receipt.
 */
describe('a model-derived draft must say which model read it', () => {
  it('refuses to confirm without the extraction (§5)', async () => {
    // A receipt minted without it records that SOMETHING read the page, which
    // is not attribution — and the receipt is the artefact meant to answer
    // that question later, when the person is no longer there to ask.
    const h = harness();
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('fixture');
    h.drafts.put({ ...draft, extraction: null });
    const outcome = h.service.confirm('draft-1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('missing_receipt');
  });

  it('and an EXEMPT class needs none, because nothing was inferred', async () => {
    const h = harness();
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('fixture');
    h.drafts.put({ ...draft, provenanceClass: 'owner_authored', extraction: null });
    expect(h.service.confirm('draft-1').ok).toBe(true);
  });
});

describe('the receipt rule, in both directions', () => {
  async function approvedThen(mutate: (d: CatalogDraft) => CatalogDraft): Promise<Awaited<ReturnType<CatalogDraftService['publish']>>> {
    const h = harness();
    await toApproved(h);
    const approved = h.drafts.get('draft-1');
    if (approved === null) throw new Error('fixture: expected an approved draft');
    h.drafts.put(mutate(approved));
    return h.service.publish('draft-1');
  }

  it('refuses to publish a model-derived draft with no receipt', async () => {
    const outcome = await approvedThen((d) => ({ ...d, receipt: null }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('missing_receipt');
  });

  it('refuses to publish an EXEMPT draft that somehow carries one', async () => {
    // The other direction, and it is not symmetry for its own sake: a receipt
    // on an exempt draft means something minted one outside the path that
    // checks presence, which is the forgery the receipt exists to detect.
    const outcome = await approvedThen((d) => ({
      ...d,
      provenanceClass: 'owner_authored',
      receipt: { digest: 'f'.repeat(64), revision: d.contentRevision, vouchedBy: null },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('missing_receipt');
  });

  it('refuses a receipt that does not describe the items it sits on', async () => {
    // Re-derived, not trusted: the receipt is the whole reason to believe a
    // person saw these bytes, so a row edited after writing must not pass.
    const outcome = await approvedThen((d) => ({
      ...d,
      receipt: { digest: 'f'.repeat(64), revision: d.contentRevision, vouchedBy: null },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('digest_mismatch');
  });

  it('publishes when the receipt is genuine, so the rule is not simply always-refuse', async () => {
    const h = harness();
    await toApproved(h);
    const outcome = await h.service.publish('draft-1');
    expect(outcome.ok).toBe(true);
  });
});

/**
 * The held bytes are RE-DERIVED before they are signed.
 *
 * Every other check compares one stored value with another stored value, so a
 * row edited after writing agrees with itself and passes. These bytes are
 * about to become a public commitment, and the digest the owner approved means
 * something only if the bytes still produce it.
 */
describe('what is published is what was built', () => {
  async function approvedWithHeld(
    mutate: (held: NonNullable<CatalogDraft['held']>) => NonNullable<CatalogDraft['held']>,
    /**
     * Move the approval to whatever the mutated bytes now say.
     *
     * Whoever can rewrite the held columns can rewrite the approval beside
     * them, so leaving the approval behind would let the digest comparison
     * answer for checks that are actually about something else. Setting it
     * strips that cover away and tests the check named in the title.
     */
    followApproval = false,
  ): Promise<Awaited<ReturnType<CatalogDraftService['publish']>>> {
    const h = harness();
    await toApproved(h);
    const approved = h.drafts.get('draft-1');
    if (approved?.held == null) throw new Error('fixture: expected held bytes');
    const held = mutate(approved.held);
    h.drafts.put({
      ...approved,
      held,
      ...(followApproval && approved.approval !== null
        ? { approval: { ...approved.approval, digest: held.snapshot.snapshot_digest } }
        : {}),
    });
    return h.service.publish('draft-1');
  }

  it('refuses a held snapshot whose digest no longer describes it', async () => {
    const outcome = await approvedWithHeld((held) => ({
      ...held,
      // One field changed after the review. The stored digest still matches
      // the approval, so every equality check above this one passes.
      snapshot: { ...held.snapshot, item_count: held.snapshot.item_count + 1 },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('digest_mismatch');
  });

  it('refuses when the held pages are not the pages committed to', async () => {
    const outcome = await approvedWithHeld((held) => ({ ...held, pages: [] }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('digest_mismatch');
  });

  it('refuses a page that is internally valid but is not the page committed to', async () => {
    // THE CASE THE ORDER CHECK EXISTS FOR. Altering a page's items alone is
    // caught by `verifyCatalogPage`, which recomputes the digest from the
    // content — so the interesting attempt is one that RE-DIGESTS the page it
    // substituted. That page verifies against itself perfectly, and the only
    // thing that catches it is comparing its digest with the one the snapshot
    // committed to at that position.
    const outcome = await approvedWithHeld((held) => {
      const first = held.pages[0];
      if (first === undefined) throw new Error('fixture: expected a page');
      const swapped = { ...first, items: [{ name: 'Something the owner never saw' }] };
      return {
        ...held,
        pages: [{ ...swapped, page_digest: catalogPageDigest(swapped, hash) }],
      };
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('digest_mismatch');
  });

  it('refuses a held pointer that names a different snapshot', async () => {
    // The pointer carries the chain link and the listing binding, and neither
    // is covered by the snapshot's own digest.
    const outcome = await approvedWithHeld((held) => ({
      ...held,
      pointer: { ...held.pointer, snapshot_digest: 'f'.repeat(64) },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('digest_mismatch');
  });

  it('refuses a perfectly consistent snapshot carrying DIFFERENT items', async () => {
    // THE CASE EVERY OTHER CHECK LETS THROUGH. Substitute the items, re-digest
    // the page, recompute the payload root and the snapshot digest, and point
    // the pointer at it: the held bytes are now internally flawless. The
    // receipt still covers the items the person confirmed, and only comparing
    // the two catches that the node is about to sign a different catalog.
    const outcome = await approvedWithHeld((held) => {
      const first = held.pages[0];
      if (first === undefined) throw new Error('fixture: expected a page');
      const substituted = {
        ...first,
        items: [{ ...item(), name: 'A product the owner never saw' }],
      };
      const page = { ...substituted, page_digest: catalogPageDigest(substituted, hash) };
      const snapshot = {
        ...held.snapshot,
        page_digests: [page.page_digest],
        payload_root: catalogPayloadRoot([page.page_digest], hash),
      };
      const digested = { ...snapshot, snapshot_digest: catalogSnapshotDigest(snapshot, hash) };
      return {
        ...held,
        snapshot: digested,
        pages: [page],
        pointer: {
          ...held.pointer,
          snapshot_digest: digested.snapshot_digest,
          snapshot_rkey: digested.snapshot_digest,
        },
      };
    }, true);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('digest_mismatch');
    expect(outcome.error).toContain('the receipt covers');
  });

  it('refuses a pointer that names the right digest under the wrong record key', async () => {
    // §10.2 addresses a snapshot BY its digest, so `snapshot_rkey` and
    // `snapshot_digest` are one string by construction. A pointer that
    // disagrees sends every consumer to a record that is not there, and the
    // snapshot's own digest cannot catch it — the pointer is a second record.
    const outcome = await approvedWithHeld((held) => ({
      ...held,
      pointer: { ...held.pointer, snapshot_rkey: 'some-other-key' },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error).toContain('record key');
  });

  it('refuses a pointer that disagrees with the snapshot about the sequence', async () => {
    const outcome = await approvedWithHeld((held) => ({
      ...held,
      pointer: { ...held.pointer, snapshot_sequence: held.pointer.snapshot_sequence + 1 },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error).toContain('sequence');
  });

  it('publishes when the held bytes verify, so the guard is not always-refuse', async () => {
    const h = harness();
    await toApproved(h);
    expect((await h.service.publish('draft-1')).ok).toBe(true);
  });
});

/**
 * Publication is two network round trips, and every owner operation stays
 * callable during them.
 */
describe('a draft that moves while it is being published', () => {
  it('REFUSES THE EDIT while publication holds the draft, so nothing races', async () => {
    // DETECTING THE COLLISION IS NOT PREVENTING IT. An earlier version noticed
    // afterwards that the draft had moved — by which time both records were
    // public and the seller's correction was the thing that lost. The claim is
    // taken before the first write, so the edit is refused for the duration
    // and the two can no longer interleave at all.
    const h = harness();
    await toApproved(h);

    let editWhilePublishing: { ok: boolean; refusal?: string } | null = null;
    h.setPublishHook(() => {
      // Runs between the claim and the writes, which is exactly the window.
      const attempt = h.service.editValue('draft-1', '0.name', 'Corrected mid-flight');
      editWhilePublishing = attempt.ok ? { ok: true } : { ok: false, refusal: attempt.refusal };
    });

    const published = await h.service.publish('draft-1');
    expect(published.ok).toBe(true);
    expect(editWhilePublishing).toEqual({ ok: false, refusal: 'publishing' });
    // And the claim does not outlive the publication.
    expect(h.drafts.get('draft-1')?.publishClaim).toBeNull();
  });

  it('lets the seller edit again once the publication is done', async () => {
    // A claim that outlived its publication would wedge the draft as surely as
    // no claim at all, one direction along.
    const h = harness();
    await toApproved(h);
    h.setPublishResult({ ok: false, error: 'network', lostSwap: false });
    await h.service.publish('draft-1');
    expect(h.drafts.get('draft-1')?.publishClaim).toBeNull();
    expect(h.service.editValue('draft-1', '0.name', 'After the failure').ok).toBe(true);
  });

  it('is escaped by PUBLISHING, not by editing, when a claim was abandoned', async () => {
    // A process that died between the claim and the writes must not brick the
    // draft for ever — and the way out is to finish the publication, not to
    // start editing around it. A claim is only ever taken in `publish`, which
    // needs `approved`, so a draft wedged this way is one whose bytes the
    // owner already approved and whose records may already be half-written.
    const h = harness();
    await toApproved(h);
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('fixture');
    h.drafts.put({ ...draft, publishClaim: { token: 't', atMs: 1 } });

    // The edit stays refused, because age cannot tell a dead publication from
    // a slow one and the wrong guess publishes the bytes the seller replaced.
    expect(h.service.editValue('draft-1', '0.name', 'Long after')).toMatchObject({
      refusal: 'publishing',
    });
    // Publishing takes the abandoned claim over and completes...
    expect((await h.service.publish('draft-1')).ok).toBe(true);
    // ...and once it has, the draft is terminal rather than wedged.
    expect(h.drafts.get('draft-1')?.publishClaim).toBeNull();
  });

  it('refuses rather than overwriting the seller’s correction', async () => {
    const h = harness();
    await toApproved(h);
    const before = h.drafts.get('draft-1');
    if (before == null) throw new Error('fixture');

    // The seller repairs a value while the snapshot write is in flight. The
    // repository has no lock and no revision CAS, so without a re-read the
    // loaded object is written back over this.
    h.setPublishResult({ ok: true, pointerCid: 'cid-p', snapshotCid: 'cid-s' });
    const service = h.service;
    const original = h.drafts.get('draft-1');
    if (original == null) throw new Error('fixture');
    const racing = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        h.drafts.put({ ...original, contentRevision: original.contentRevision + 1 });
        resolve();
      });
    });
    const [outcome] = await Promise.all([service.publish('draft-1'), racing]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.refusal).toBe('stale_revision');
    // And the concurrent edit survived — it was not overwritten by a
    // `published` write built from the stale object.
    expect(h.drafts.get('draft-1')?.contentRevision).toBe(before.contentRevision + 1);
    expect(h.drafts.get('draft-1')?.state).not.toBe('published');
  });
});

/**
 * The lease, driven rather than reasoned about.
 *
 * A lease has exactly two ways to be wrong and they pull in opposite
 * directions: too weak and two publications interleave, too strong and a dead
 * process locks the seller out of their own draft for ever. Both need a second
 * claimant and a clock you can move, which is why the harness has both.
 */
describe('the publication lease', () => {
  it('refuses a second claimant while the first is genuinely in flight', async () => {
    const h = harness();
    await toApproved(h);

    // A publication that has started and not finished — the state the claim
    // exists to describe, held open rather than simulated by a stored row.
    let letFirstFinish: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => (letFirstFinish = resolve));
    h.setPublishHook(() => inFlight);

    const first = h.service.publish('draft-1');
    await Promise.resolve();

    // A SECOND PROCESS over the same store, not the same service reentered.
    const second = await h.other.publish('draft-1');
    expect(second).toMatchObject({ ok: false, refusal: 'publishing' });
    // And it did not write anything: one publication, one set of records.
    expect(h.publishCalls()).toBe(1);

    letFirstFinish();
    expect((await first).ok).toBe(true);
  });

  it('hands the draft on once the first claimant has been quiet past the TTL', async () => {
    // The other direction. A process that died mid-publication holds a claim
    // nobody will ever release, so the TTL has to be able to break it.
    const h = harness();
    await toApproved(h);

    let letFirstFinish: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => (letFirstFinish = resolve));
    h.setPublishHook(() => inFlight);
    const first = h.service.publish('draft-1');
    await Promise.resolve();

    expect(await h.other.publish('draft-1')).toMatchObject({ refusal: 'publishing' });
    h.advanceClock(5 * 60 * 1000);
    // Same call, same draft, five minutes later: the claim is abandoned.
    h.setPublishHook(() => undefined);
    expect((await h.other.publish('draft-1')).ok).toBe(true);

    letFirstFinish();
    await first;
  });

  it('does not let an overrunning publication release the claim that replaced it', async () => {
    // THIS IS WHY THE CLAIM CARRIES A TOKEN. Age alone can say a claim is
    // abandoned; it cannot say whose it is. A blind release by the process
    // that overran would drop the successor's claim and put both back inside
    // the window the lease exists to close.
    const h = harness();
    await toApproved(h);

    h.setPublishHook(() => {
      // The takeover, as the store sees it: our claim replaced by another's.
      const current = h.drafts.get('draft-1');
      if (current === null) throw new Error('fixture');
      h.drafts.put({ ...current, publishClaim: { token: 'successor', atMs: 1_800_000_500_000 } });
    });
    // A failed write, so the terminal writes (which clear the claim on
    // purpose) stay out of the way of what is being tested.
    h.setPublishResult({ ok: false, error: 'network', lostSwap: false });

    await h.service.publish('draft-1');

    expect(h.drafts.get('draft-1')?.publishClaim).toEqual({
      token: 'successor',
      atMs: 1_800_000_500_000,
    });
  });

  it('and the SUCCESS write does not clear a successor\u2019s claim either', async () => {
    // The token check in `releaseClaim` would be worth nothing if the write
    // one statement later cleared the claim unconditionally: the guard would
    // hold for an instant and be undone by the same code path. Both terminal
    // writes take the claim from the post-await re-read, where ours is already
    // gone and a successor's is not ours to drop.
    const h = harness();
    await toApproved(h);

    h.setPublishHook(() => {
      const current = h.drafts.get('draft-1');
      if (current === null) throw new Error('fixture');
      h.drafts.put({ ...current, publishClaim: { token: 'successor', atMs: 1_800_000_500_000 } });
    });

    expect((await h.service.publish('draft-1')).ok).toBe(true);
    expect(h.drafts.get('draft-1')?.publishClaim).toEqual({
      token: 'successor',
      atMs: 1_800_000_500_000,
    });
  });

  it('releases the claim when the publication THROWS', async () => {
    // `recordPublication` writes to the pointer store, outside any catch, and
    // a store write can fail. Without the `finally` the draft would refuse
    // every edit and every retry for the rest of the TTL — and the worst case
    // is the one where it matters most, the write failing just after the repo
    // accepted the records, so the catalog is public and the draft is wedged.
    const h = harness();
    await toApproved(h);
    h.setPublishThrows(true);

    await expect(h.service.publish('draft-1')).rejects.toThrow('the pointer store is unavailable');

    expect(h.drafts.get('draft-1')?.publishClaim).toBeNull();
    // And the seller can still work: the draft is not a casualty of the fault.
    expect(h.service.editValue('draft-1', '0.name', 'After the fault').ok).toBe(true);
  });

  it('survives a restart, because the claim is in the store and not in a process', async () => {
    // A lease held in memory is not a lease. The row is what a second process
    // reads, so this asserts through a service that has never seen the first.
    const h = harness();
    await toApproved(h);
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('fixture');
    h.drafts.put({ ...draft, publishClaim: { token: 'from-before-the-restart', atMs: 1_800_000_500_000 } });

    expect(await h.other.publish('draft-1')).toMatchObject({ refusal: 'publishing' });
    expect(h.other.editValue('draft-1', '0.name', 'During someone else’s publish')).toMatchObject({
      refusal: 'publishing',
    });
  });

  it('treats a claim stamped in the FUTURE as abandoned', async () => {
    // A phone whose clock was corrected backwards — or an NTP step after a bad
    // RTC read — leaves claims ahead of `now`. Read as live they would hold
    // for the whole size of the skew, which is the one sequence that wedges a
    // draft indefinitely: the TTL cannot expire a claim that keeps being
    // younger than it is. Mobile is the product and `Date.now()` is wall
    // clock, so this is a real Tuesday, not a thought experiment.
    const h = harness();
    await toApproved(h);
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('fixture');
    h.drafts.put({
      ...draft,
      publishClaim: { token: 'from-the-future', atMs: 1_800_000_500_000 + 60 * 60 * 1000 },
    });

    // Publication can take it over, which is the escape from a wedge...
    expect((await h.service.publish('draft-1')).ok).toBe(true);
    // ...and the draft is free afterwards.
    expect(h.drafts.get('draft-1')?.publishClaim).toBeNull();
  });

  it('frees a draft whose publication CANNOT pass its own checks', async () => {
    // THE WEDGE, which is what the claim-before-the-checks ordering exists to
    // remove. The claim used to be taken after fifteen validation gates, and
    // an abandoned claim was cleared by `publish` and by nothing else — so a
    // node that came up fenced, or held bytes that stopped validating, left a
    // draft that could neither publish nor be edited, with no release route.
    // The lease built exactly the wedge its TTL exists to prevent.
    const h = harness();
    await toApproved(h);
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('fixture');
    h.drafts.put({ ...draft, publishClaim: { token: 'from-the-crash', atMs: 1 } });

    // The node lost authority while the claim was standing, so publication
    // refuses at a gate rather than reaching the writes.
    h.setFenced(true);
    expect(await h.service.publish('draft-1')).toMatchObject({ refusal: 'fenced' });

    // The attempt still took the abandoned claim over and gave it back, so the
    // seller has their draft rather than a locked one.
    expect(h.drafts.get('draft-1')?.publishClaim).toBeNull();
    expect(h.service.editValue('draft-1', '0.name', 'While the node is fenced').ok).toBe(true);
  });

  it('refuses an edit while a publication is STILL RUNNING past the TTL', async () => {
    // THE TTL DOES NOT DECIDE THIS. Five minutes is a guess about whether the
    // first publication is still alive, and a publication that is merely slow
    // — two round trips on a bad mobile connection — looks exactly like a dead
    // one. Guess wrong and the edit is accepted locally while the OLD bytes
    // are still travelling to the wire: the seller's correction is recorded as
    // taken and the catalog they replaced is what gets published. The
    // post-await revision check reports that afterwards; it cannot undo it.
    const h = harness();
    await toApproved(h);

    let letFirstFinish: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => (letFirstFinish = resolve));
    h.setPublishHook(() => inFlight);
    const first = h.service.publish('draft-1');
    await Promise.resolve();

    h.advanceClock(10 * 60 * 1000);
    // Long past the TTL, and the publication is demonstrably still running.
    expect(h.service.editValue('draft-1', '0.name', 'While it is on the wire')).toMatchObject({
      refusal: 'publishing',
    });

    letFirstFinish();
    expect((await first).ok).toBe(true);
    // And the moment it finishes, the seller has their draft back.
    expect(h.drafts.get('draft-1')?.publishClaim).toBeNull();
  });

  it('and a future-stamped claim does not block the publication either', async () => {
    // Asserted on its own draft, because the edit above voids the approval by
    // design — proving the edit went through would otherwise be the reason
    // the publish did not.
    const h = harness();
    await toApproved(h);
    const draft = h.drafts.get('draft-1');
    if (draft === null) throw new Error('fixture');
    h.drafts.put({
      ...draft,
      publishClaim: { token: 'from-the-future', atMs: 1_800_000_500_000 + 60 * 60 * 1000 },
    });

    expect((await h.service.publish('draft-1')).ok).toBe(true);
  });
});

/**
 * §9.4 — one identity, one product, on every path into a draft.
 *
 * `assembleCatalogItems` refuses a colliding pair, and the three ingress
 * routes and `repairRow` all go through it. `editValue` does not: it rewrites
 * ONE assembled item in place, so it is the only way a collision can be put
 * back after assembly, and the only path whose guard is its own.
 */
describe('a product identity edited onto another item', () => {
  /** A draft with two genuinely distinct products, which is the precondition. */
  function twoItems(): CatalogDraft {
    const first = item();
    const second: CatalogItem = {
      ...item(),
      product: { scheme: 'manufacturer_sku', value: 'STOOL-1', issuer_did: SUPPLIER },
      name: 'Oak stool',
    };
    // `acceptedProvenance` always keys its map at '0', so the second item's
    // entry is that same map under '1' rather than a lookup that would always
    // miss.
    const accepted = acceptedProvenance(first)['0'] ?? {};
    return makeDraft({ items: [first, second], provenance: { '0': accepted, '1': accepted } });
  }

  it('is refused, naming the item that already holds it', () => {
    const h = harness(twoItems());

    const collide = h.service.editValue('draft-1', '1.product', {
      scheme: 'manufacturer_sku',
      value: 'CHAIR-1',
      issuer_did: SUPPLIER,
    });

    expect(collide).toMatchObject({ refusal: 'item_rejected' });
    if (collide.ok) return;
    expect(collide.error).toContain('item 1');
    // And nothing was written: the draft still holds two distinct products.
    expect(h.drafts.get('draft-1')?.items[1]?.product.value).toBe('STOOL-1');
  });

  it('but an edit to a genuinely new identity still goes through', () => {
    // Otherwise the guard could be "refuse every product edit" and pass.
    const h = harness(twoItems());

    const moved = h.service.editValue('draft-1', '1.product', {
      scheme: 'manufacturer_sku',
      value: 'STOOL-2',
      issuer_did: SUPPLIER,
    });

    expect(moved.ok).toBe(true);
    expect(h.drafts.get('draft-1')?.items[1]?.product.value).toBe('STOOL-2');
  });

  it('and an item may keep its own identity across an unrelated edit', () => {
    // The collision check must skip the item being edited, or renaming a
    // product would refuse because it "collides" with itself.
    const h = harness(twoItems());
    expect(h.service.editValue('draft-1', '1.name', 'Oak stool, tall').ok).toBe(true);
  });
});

/**
 * A node holding the identity but not the pointer row.
 *
 * FOUND BY A LIVE RUN, not by this suite — every test here starts with a local
 * store and a repo that agree, and the defect only exists when they disagree.
 * A new phone, a re-pair, or a backup older than the last publication leaves a
 * node that can publish under the supplier's DID and has never recorded a
 * head. It derived sequence 1 with no predecessor and wrote it with no
 * compare-and-swap token, so the write could not lose: against a real PDS the
 * live head went from sequence 2 back to sequence 1 and the chain link was
 * gone.
 */
describe('the local head and the repo disagree', () => {
  const LIVE: CatalogPointer = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: 7,
    protocol_version: '1.0',
    published_at: '2026-08-14T09:00:00.000Z',
    snapshot_digest: 'a'.repeat(64),
    snapshot_rkey: 'a'.repeat(64),
    previous_snapshot_digest: 'b'.repeat(64),
  };

  /** A node that can publish: a writer is installed, so a clobber is possible. */
  function publishingNode(reader: (() => Promise<{ record: unknown; cid: string } | null>) | 'throws' | null): Harness {
    const h = harness();
    installCatalogRecordWriter(async () => ({ cid: 'cid-written' }));
    if (reader === 'throws') {
      installCatalogRecordReader(() => {
        throw new Error('the network is down');
      });
    } else if (reader !== null) {
      installCatalogRecordReader(reader);
    } else {
      installCatalogRecordReader(null);
    }
    return h;
  }

  afterEach(() => {
    installCatalogRecordWriter(null);
    installCatalogRecordReader(null);
  });

  it('ADOPTS the live head rather than republishing from sequence 1', async () => {
    const h = publishingNode(async () => ({ record: LIVE, cid: 'cid-live-head' }));
    h.service.confirm('draft-1');
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-15T09:00:00.000Z',
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.held?.pointer.snapshot_sequence).toBe(8);
    expect(prepared.value.held?.pointer.previous_snapshot_digest).toBe(LIVE.snapshot_digest);
    // AND IT WILL CAS. Without the live CID the write carries no swap token
    // and cannot lose, which is what made the clobber silent.
    expect(prepared.value.held?.expectedPointerCid).toBe('cid-live-head');
  });

  it('refuses when the head cannot be read, rather than guessing sequence 1', async () => {
    const h = publishingNode('throws');
    h.service.confirm('draft-1');
    expect(
      await h.service.prepare('draft-1', { protocolVersion: '1.0', publishedAt: 'x' }),
    ).toMatchObject({ refusal: 'head_unreadable' });
  });

  it('refuses when this node can write but has no reader at all', async () => {
    const h = publishingNode(null);
    h.service.confirm('draft-1');
    expect(
      await h.service.prepare('draft-1', { protocolVersion: '1.0', publishedAt: 'x' }),
    ).toMatchObject({ refusal: 'head_unreadable' });
  });

  it('refuses a live head that is not a valid pointer', async () => {
    const h = publishingNode(async () => ({ record: { nonsense: true }, cid: 'cid-x' }));
    h.service.confirm('draft-1');
    expect(
      await h.service.prepare('draft-1', { protocolVersion: '1.0', publishedAt: 'x' }),
    ).toMatchObject({ refusal: 'head_unreadable' });
  });

  it('treats a genuine absence as the first publication', async () => {
    // Null is a real answer — this catalog has never been published — and it
    // must not be confused with the unreadable cases above.
    const h = publishingNode(async () => null);
    h.service.confirm('draft-1');
    const prepared = await h.service.prepare('draft-1', {
      protocolVersion: '1.0',
      publishedAt: '2026-08-15T09:00:00.000Z',
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.held?.pointer.snapshot_sequence).toBe(1);
    expect(prepared.value.held?.pointer.previous_snapshot_digest).toBeUndefined();
  });

  it('does not ask at all when this node cannot publish', async () => {
    // No writer means no clobber is possible, and demanding a reader from a
    // node that only builds bytes would refuse every legitimate caller.
    const h = harness();
    installCatalogRecordWriter(null);
    installCatalogRecordReader(() => {
      throw new Error('must not be consulted');
    });
    h.service.confirm('draft-1');
    expect(
      (
        await h.service.prepare('draft-1', {
          protocolVersion: '1.0',
          publishedAt: '2026-08-15T09:00:00.000Z',
        })
      ).ok,
    ).toBe(true);
  });
});

describe('§6.4 attribution at the receipt', () => {
  it('past the boundary, confirm mints a v2 receipt naming the voucher, and publish dual-reads it', async () => {
    const h = harness();
    h.boundary.cross(1_800_000_000_000, []);
    const approved = await toApproved(h);
    expect(approved.receipt?.vouchedBy).toBe(OWNER_DID);
    // The stored digest IS the v2 commitment — recomputed the way publish does.
    expect(approved.receipt?.digest).toBe(
      catalogContentReceiptDigest(
        {
          items: approved.items,
          provenance: approved.provenance,
          contentRevision: approved.contentRevision,
          extraction: approved.extraction,
          attribution: { version: 2, vouched_by: OWNER_DID },
        },
        hash,
      ),
    );
    const published = await h.service.publish('draft-1');
    expect(published.ok).toBe(true);
  });

  it('past the boundary, confirm with no known voucher refuses', () => {
    const h = harness();
    h.boundary.cross(1_800_000_000_000, []);
    h.setVoucher(null);
    expect(h.service.confirm('draft-1')).toMatchObject({
      ok: false,
      refusal: 'no_user_presence',
    });
  });

  it('a v1 receipt outside the index refuses at publish once the boundary is crossed; indexed passes', async () => {
    // Confirm BEFORE the crossing — a genuine pre-staff v1 receipt.
    const h = harness();
    const approved = await toApproved(h);
    expect(approved.receipt?.vouchedBy).toBeNull();

    // Crossed with an EMPTY index: the v1 receipt reads as a downgrade.
    h.boundary.cross(1_800_000_000_500, []);
    const refused = await h.service.publish('draft-1');
    expect(refused).toMatchObject({ ok: false, refusal: 'digest_mismatch' });

    // The same walk, with the receipt grandfathered — history stays readable.
    const h2 = harness();
    const approved2 = await toApproved(h2);
    h2.boundary.cross(1_800_000_000_500, [
      { digest: approved2.receipt?.digest ?? '', kind: 'content_receipt' },
    ]);
    const published = await h2.service.publish('draft-1');
    expect(published.ok).toBe(true);
  });
});
