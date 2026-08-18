/**
 * The commerce aggregate boundary, enforced statically (ARCH-0 / WS-0.5).
 *
 * `QuoteFamily.hold()` is worthless while `holdUse()` stays callable, and
 * `StatusChain.advance()` is worthless while `casAdvance()` does. Behavioural
 * tests cannot express that: they test what the code DOES, and the risk here
 * is what a future caller COULD do. A grep proved nobody bypassed the
 * aggregates today; it proved nothing about the design.
 *
 * So the rule is asserted over the source itself. It fails on the commit that
 * reintroduces a bypass, not on the incident that exploits one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const COMMERCE_SRC = path.join(__dirname, '..', '..', 'src', 'commerce');
const CORE_SRC = path.join(__dirname, '..', '..', 'src');

/** Raw persistence primitives that must not be reachable from a caller. */
const RAW_MUTATORS = [
  'registerHead',
  'casAdvanceHead',
  'holdUse',
  'settleUse',
  'voidUnexpired',
  'activeUseCount',
  'initGenesis',
  'casAdvance',
  'setFence',
];

/** Files allowed to name them: the repositories themselves and their owners. */
const OWNERS = new Set([
  'quote_ledger.ts',
  'quote_family.ts',
  'status_heads.ts',
  'status_chain.ts',
  'order_refs.ts',
  'commerce_order.ts',
]);

/**
 * Drop `InMemory*` class bodies.
 *
 * They are test doubles, so a call inside one is not a production caller — and
 * their `Map`/`Set` operations (`this.rows.delete(...)`) collide by name with
 * the very mutators these rules check.
 */
function withoutInMemoryClasses(source: string): string {
  return source.replace(/export class InMemory[\s\S]*?\n\}\n/g, '\n');
}

function tsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? tsFiles(path.join(dir, e.name))
        : e.name.endsWith('.ts')
          ? [path.join(dir, e.name)]
          : [],
    );
}

/** Strip comments so prose ABOUT a rule is not mistaken for a call to it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Strip STRING LITERALS too, keeping template interpolations.
 *
 * The orphan ledger counts a symbol as internally consumed when its own file
 * names it more than once. A class that names itself inside an error message
 * met that bar without a single call, so any such class could have gone
 * unwired and stayed off the ledger. A message is not a call.
 *
 * Template interpolations survive, because an interpolated symbol IS a
 * reference.
 */
function codeNoStrings(source: string): string {
  // A SCANNER, NOT A PATTERN, because the thing being read is not regular.
  //
  // The regex version stripped quotes before backticks, so an apostrophe
  // inside a template — `the seller's settings` — read as an opening quote and
  // paired with the next one hundreds of lines away, deleting every call site
  // between them. Reordering did not save it either: a NESTED template
  // (`${n > 5 ? `and more` : ''}`) leaves the interpolation pattern matching to
  // the first `}` and the backticks unbalanced again.
  //
  // Comments then repeated the mistake a third time. They were pre-stripped
  // with a flat `//`-to-end-of-line regex BEFORE this scanner ran, so the
  // first template holding an at-URI — `at://${did}/…` — lost everything
  // after its `//`, closing backtick included. Every backtick after it
  // swapped roles, and sixteen thousand characters of route code — with the
  // only production callers of eleven ledgered methods inside — read as
  // template text. The ledger then demanded rows for methods that were wired.
  //
  // All three failures are the same mistake — matching a nesting language
  // with a flat pattern — and all three are silent in BOTH directions: as
  // easily as inventing an offender, the swallowed stretch could hide the
  // uncalled method the ledger exists to catch. So comments, strings, and
  // templates are read together in the one pass that knows which context it
  // is in. `frames` carries one number per open template: -1 while its
  // literal text is being read, else the brace depth of the interpolation
  // currently open under it — so a `}` inside `${…}` knows whether it closes
  // the interpolation or an object literal, and a nested template returns to
  // its parent.
  let out = '';
  let i = 0;
  const frames: number[] = [];
  const literalText = (): boolean => frames.length > 0 && frames[frames.length - 1] === -1;
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (literalText()) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        frames.pop();
        i += 1;
        continue;
      }
      // An interpolation is CODE and is kept — that is where calls hide.
      if (ch === '$' && source[i + 1] === '{') {
        frames[frames.length - 1] = 0;
        out += ' ';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Comments are recognized HERE, in code context, never inside a string.
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < source.length && source[i] !== ch) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      out += ch + ch;
      continue;
    }
    if (ch === '`') {
      frames.push(-1);
      i += 1;
      continue;
    }
    if (frames.length > 0) {
      // Inside `${…}`: braces nest, and only the balancing `}` ends it.
      if (ch === '{') {
        frames[frames.length - 1] = (frames[frames.length - 1] ?? 0) + 1;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '}') {
        const depth = frames[frames.length - 1] ?? 0;
        if (depth === 0) {
          frames[frames.length - 1] = -1;
          out += ' ';
        } else {
          frames[frames.length - 1] = depth - 1;
          out += ch;
        }
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe('commerce aggregate boundary', () => {
  /**
   * WS-0.7. A cast to a wire type is indistinguishable, to a reader, from an
   * unchecked one — which is exactly how five rehydration sites came to trust
   * receipts nobody had re-validated. `readPurchaseOrderProposal` /
   * `readSignedQuote` hand back a TYPED value, so the cast has no reason to
   * exist and its absence is the enforceable form of the rule.
   */
  it('no commerce source casts a value into a wire order or quote type', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      const body = code(fs.readFileSync(file, 'utf8'));
      // `order_decision.ts` hands a counterproposal's replacement quote
      // straight to `decideOrder`, which registers it through the quote family
      // — the ONE gate that owns audience binding. Checking it here too would
      // be a second opinion that could disagree with the one that counts.
      if (path.basename(file) === 'order_decision.ts') continue;
      if (/as\s+(unknown\s+as\s+)?(PurchaseOrderProposal|SignedQuote)\b/.test(body)) {
        offenders.push(path.relative(COMMERCE_SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE UNRECEIPTED PUBLISH BODY IS GATED ON PRESENCE, NOT ON A COMMENT.
   *
   * `/v1/commerce/catalog/publish` still accepts an item list, which publishes
   * with no content receipt, no snapshot approval and no presence step. §6
   * retires that body, and the retirement is CONDITIONAL: it survives only
   * while the draft lane — where the receipt and the approval live — cannot
   * publish at all. A conditional nobody can see is how a bypass outlives its
   * reason, so this pins the mechanism.
   *
   * TWO QUESTIONS, ONE MODULE. They were one function returning a constant,
   * and splitting them is what made the retirement honest:
   *
   *   can presence be established?  a CAPABILITY. The retirement asks this.
   *                                 Once a node can check a passphrase the
   *                                 lane is usable and the bypass closes —
   *                                 whether or not anyone is at the keyboard
   *                                 this second.
   *   is a person here now?         an INSTANT. `userPresent` asks this, and
   *                                 must not be satisfied by a node that
   *                                 merely COULD have asked somebody.
   *
   * Both come from `owner_presence.ts`, so a second hand-rolled answer to
   * either is the drift this catches.
   */
  it('the item-list retirement and the draft lane read ONE presence module', () => {
    const routes = code(
      fs.readFileSync(path.join(CORE_SRC, 'server', 'routes', 'commerce.ts'), 'utf8'),
    );
    // Both answers come from the module, not from this file.
    expect(/from '\.\.\/\.\.\/commerce\/owner_presence'/.test(routes)).toBe(true);
    // The retirement asks the CAPABILITY question...
    expect(
      /if \(ownerPresenceCanBeEstablished\(\)\)[\s\S]{0,400}item_list_retired/.test(routes),
    ).toBe(true);
    // ...and the draft service asks the INSTANT one.
    expect(/userPresent:\s*ownerPresentNowForRoutes/.test(routes)).toBe(true);
    expect(routes.match(/function ownerPresentNowForRoutes\(/g) ?? []).toHaveLength(1);
    // And no hand-rolled constant standing in for either.
    expect(/userPresent:\s*\(\)\s*=>\s*(false|true)/.test(routes)).toBe(false);
    expect(/function ownerPresenceCanBeEstablished\(\)[\s\S]{0,80}return (false|true);/.test(routes)).toBe(
      false,
    );
  });

  /**
   * ONLY THE PUBLISHER MINTS A POINTER.
   *
   * The draft lane held a snapshot across the owner's review and then
   * reassembled a pointer from that snapshot's fields at publish time. It
   * type-checked and it published, but `previous_snapshot_digest` and
   * `service_rkey` live ONLY on the pointer: the repo accepted the write,
   * AppView refused it for a broken chain, and Core reported a successful
   * publication buyers never saw. Every publish test passed because they all
   * started from an empty pointer repo, where the dropped fields do not exist.
   *
   * `snapshot_rkey` is the tell — a field no other record carries — so a
   * second place constructing a pointer cannot avoid naming it.
   */
  it('only the catalog publisher constructs a pointer', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(CORE_SRC)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const name = path.basename(file);
      if (name === 'catalog_publisher.ts') continue;
      if (/\bsnapshot_rkey\s*:/.test(code(fs.readFileSync(file, 'utf8')))) {
        offenders.push(path.relative(CORE_SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `repairRow` takes its assembler as a CALLBACK, so the guarantee is the
   * caller's to keep.
   *
   * Assembly is where two rows resolving to one product identity are refused,
   * and that refusal is what keeps a colliding pair out of a draft, out of the
   * provenance map keyed by identity, and out of a signature. Every other way
   * into a draft calls `assembleCatalogItems` directly; repair reaches it only
   * because the one route that calls `repairRow` happens to pass
   * `assembleFromRows`. A second call site passing anything else would reopen
   * the hole silently, and no type would object — the parameter's type is
   * satisfied by any function returning items and findings.
   *
   * The callback exists for a real reason: the service is deliberately
   * settings-agnostic and the route supplies the seller's CURRENT settings, so
   * moving the assembler into the service would drag supplier settings across
   * that boundary. This pins the invariant instead of removing the seam.
   */
  it('every repairRow call site assembles through the assembler', () => {
    // PER CALL SITE, NOT PER FILE. The first version asked whether a file
    // containing `repairRow(` also contained `assembleFromRows(` anywhere —
    // co-occurrence, not correspondence. A SECOND repair call in
    // `commerce.ts` passing an arbitrary callback would have satisfied it on
    // the first call's match, which is precisely the hole it was written to
    // close. So this walks each call expression and reads its own argument
    // list, bracket-matched rather than line-matched, because the callback
    // spans several lines and contains nested parentheses of its own.
    const sites: { file: string; text: string }[] = [];
    for (const file of tsFiles(CORE_SRC)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      // The definition is not a call site.
      if (path.basename(file) === 'catalog_draft_service.ts') continue;
      const source = code(fs.readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/\brepairRow\s*\(/g)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        let depth = 0;
        let close = open;
        for (let i = open; i < source.length; i += 1) {
          if (source[i] === '(') depth += 1;
          else if (source[i] === ')') {
            depth -= 1;
            if (depth === 0) {
              close = i;
              break;
            }
          }
        }
        sites.push({ file: path.relative(CORE_SRC, file), text: source.slice(open, close + 1) });
      }
    }

    for (const site of sites) {
      // The assembler must be invoked INSIDE this call's own arguments.
      expect({ file: site.file, assembles: /assembleFromRows\s*\(/.test(site.text) }).toEqual({
        file: site.file,
        assembles: true,
      });
    }
    // Non-vacuity, and by COUNT as well as by file: a second call site in the
    // same file is the case the old assertion could not see.
    expect(sites.map((s) => s.file)).toEqual(['server/routes/commerce.ts']);
  });

  /**
   * WS-2.2b. The cast guard above looks for `as SignedQuote` and friends, and
   * that is exactly why it missed the site with teeth: admission read the
   * retained quote REQUEST as `JSON.parse(…) as { delivery: … }` — an
   * ANONYMOUS shape, so no wire type name to grep for.
   *
   * That record carries the priced delivery projection an order's delivery is
   * checked against, so a projection edited in the store after writing became
   * the yardstick and a mismatched order would pass. Reading a stored record
   * belongs to `rehydrate.ts`, which re-derives the digest; a bare
   * `JSON.parse` in this directory means someone read one without.
   */
  it('no commerce source parses a stored record outside the rehydration module', () => {
    const ALLOWED = new Set([
      // The rehydration module IS the safe reader.
      'rehydrate.ts',
      // And so is the archive preflight, for the same reason rather than as
      // an exception to it: the rule forbids reading a stored record WITHOUT
      // re-deriving its digest, and re-deriving every receipt's digest is
      // the entire purpose of the function that parses there.
      'archive_preflight.ts',
      // Evidence and census are metadata about records, not records: they
      // carry no digest to re-derive, and both read as empty on failure.
      'receipt_evidence.ts',
      // Runner answers arrive from a plugin, not from the store. They are
      // validated against the PINNED schema at the tool lane, which is a
      // different contract from a record digest.
      'order_decision.ts',
      // The same case, for the quote lane: `readRunnerTerms` parses the
      // supplier runner's unsigned TERMS, which have never been stored and
      // carry no digest to re-derive. Every field is checked before use and an
      // unreadable answer becomes `terms_unusable`, so a runner that returns
      // nonsense gets a refusal rather than a quote — which is the discipline
      // this guard exists to enforce, applied where a digest cannot be. The
      // buyer's REQUEST, which does have a digest, goes through
      // `validateQuoteRequest` and not through a bare parse.
      'quote_issuance.ts',
      // The retained quote request is parsed and IMMEDIATELY re-derived
      // through `validateQuoteRequest`, which ends in
      // `verifyCommerceRecordDigest` — so a row edited after writing is caught
      // rather than believed. That is the discipline this guard enforces, not
      // an exemption from it: the row is the yardstick an arriving quote is
      // measured against, and it checks itself on every read.
      'buyer_requests.ts',
      // A catalog feed body arrives over HTTP and has not been stored yet;
      // `parseJson` already answers a typed `body_unreadable` refusal.
      'catalog_ingest.ts',
      // Two reads survive here, both examined and both safe:
      //   - `loadHeadStatus` parses inside try/catch and then runs
      //     `validateCommerceOrderStatus` AND compares `status_digest` to the
      //     head, so the record is re-derived exactly as rehydration would;
      //   - the cancellation-result scan skips a row it cannot parse, because
      //     one unreadable receipt must not make every other cancellation for
      //     the order unanswerable.
      // Both are narrower than a blanket exemption would suggest, which is
      // why the reasons are written down rather than the file merely listed.
      'lifecycle_engine.ts',
      // The settings store parses and IMMEDIATELY re-validates through the
      // same validator the write path uses, so a tampered row cannot come back
      // as policy. A row that fails is REFUSED rather than partially believed,
      // and the caller fails closed — which is the discipline this guard exists
      // to enforce rather than an exemption from it.
      'settings_store.ts',
      // A connector's answer arrives over HTTP and has not been stored: the
      // same case as `catalog_ingest.ts`. A parse failure is reported as a
      // failed operation, so an endpoint serving nonsense is refused rather
      // than partly believed.
      'connector_executors.ts',
      // `operations_json` is a stored list with no digest to re-derive, and it
      // is read TOWARD REFUSING: an unreadable list becomes the EMPTY list, so
      // a tampered row authorizes nothing instead of authorizing more. That is
      // the discipline this guard exists to enforce, applied where a digest
      // cannot be.
      'credential_store.ts',
      // §15.5 evidence, and the same discipline again: an unreadable probe row
      // reads as ABSENT, which `evaluateIdempotencyEvidence` calls `no_probe`
      // and which leaves automatic resubmission OFF. Believing a partially
      // parsed probe would authorise the one action §15.5 wants disabled by
      // default — every field is checked and a single miss discards the whole
      // record.
      'idempotency_store.ts',
      // The draft store parses and IMMEDIATELY re-derives: `readItems` runs
      // every stored item back through `validateCatalogItem`, the same
      // validator the assembler ran on the way in, and a single failure makes
      // the whole set read as EMPTY. These are the bytes that get signed, so
      // believing a row edited after writing is the one thing that must not
      // happen — and the state machine refuses to publish a draft with no
      // items, so an unreadable row publishes nothing rather than something
      // nobody checked. The provenance class fails closed to `model_derived`
      // for the same reason, and an unknown draft state reads as absent.
      'catalog_draft_store.ts',
      // §3's egress-authorization store, same discipline: `hydrate` parses
      // the pinned hash list and re-validates every entry as hex64 — one
      // bad hash reads the whole row as ABSENT, and an absent authorization
      // transmits nothing. Believing a partially parsed hash list would
      // authorize bytes the owner never consented to leave.
      'image_egress.ts',
      // The BUYER aggregate's store (§5.1), same discipline as the catalog
      // draft store beside it: every document is re-validated on the way
      // out — an unknown conversation state, a half-written vouch entry,
      // or TWO live conversations for one supplier reads as NO DRAFT
      // rather than a draft this build half-believes.
      'order_draft_store.ts',
    ]);
    const offenders: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      if (ALLOWED.has(path.basename(file))) continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      if (/JSON\.parse\(/.test(body)) offenders.push(path.basename(file));
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE ORPHAN LEDGER (ARCH-0).
   *
   * The defect this codebase produces most is not a wrong rule — it is a
   * correct, well-tested rule that nothing calls. It has been found by hand
   * five times in this workstream alone: the reconcile lane, the epoch
   * watermark, the census, the admission arrival evidence, and the ingress
   * refusal detail. Each time the module was imported, its tests passed, and
   * production never reached the function.
   *
   * A scenario test finds these, eventually, and only for the paths a scenario
   * happens to walk. This finds them at the commit, and — more usefully — it
   * makes the CURRENT set visible. An entry here is not a bug; it is a claim
   * that something is built and not yet wired, which is a fact the WBS should
   * be able to state and this test forces it to.
   *
   * The rule for editing the list: an entry LEAVES when the symbol is wired,
   * and joins only with a reason. A name added silently to keep the suite
   * green is the exact failure the list exists to prevent.
   */
  it('every exported commerce symbol is either wired or listed as not yet wired', () => {
    const NOT_YET_WIRED = new Map<string, string>([
      ['trade_ledger.ts:InMemoryTradeDocumentRepository', 'test double'],
      ['tender.ts:InMemoryTenderRepository', 'test double'],
      ['staff_grants.ts:InMemoryStaffGrantRepository', 'test double'],
      ['staff_pins.ts:InMemoryStaffPinRepository', 'test double'],
      ['invite_store.ts:InMemoryInviteRepository', 'test double'],
      ['revshare_ledger.ts:InMemoryRevshareDocumentRepository', 'test double'],
      ['attribution_boundary.ts:InMemoryAttributionBoundaryRepository', 'test double'],
      // Test doubles. Exported on purpose so suites can swap storage; a
      // production caller would be the bug.
      ['order_refs.ts:InMemoryCommerceOrderRefRepository', 'test double'],
      ['quote_ledger.ts:InMemoryCommerceQuoteLedgerRepository', 'test double'],
      ['receipts.ts:InMemoryCommerceReceiptRepository', 'test double'],
      ['catalog_pointer_store.ts:InMemoryCatalogPointerRepository', 'test double'],
      ['idempotency_store.ts:InMemoryIdempotencyEvidenceRepository', 'test double'],
      ['status_heads.ts:InMemoryCommerceStatusHeadRepository', 'test double'],
      // The draft store (PCL-4). The state machine that owns it is PCL-5 and
      // the routes are PCL-6; both entries leave when those land.
      ['catalog_draft_store.ts:InMemoryCatalogDraftRepository', 'test double'],
      ['image_egress.ts:InMemoryImageEgressAuthorizationRepository', 'test double'],
      // §3's Hop-1 gate (PC-1). The gate and its stores exist and are
      // exercised by `image_egress.test.ts`; the artifact store that feeds
      // them is PC-2 and the routes + composition-root broker install are
      // PC-3, so no production caller exists yet. These entries leave when
      // the seller lane lands — the ledger is what stops the gate becoming
      // another "built and nothing calls it".
      ['image_artifacts.ts:InMemoryCommerceImageArtifactRepository', 'test double'],
      ['sku_ledger.ts:InMemorySkuLedgerRepository', 'test double'],
      ['order_draft_store.ts:InMemoryOrderDraftRepository', 'test double'],
      // §5.2 resolution (PC-6): the matcher, the closed-fields discovery
      // projection and authority-first hydration exist and are pinned by
      // `order_line_resolution.test.ts`; the buyer routes/surface that
      // drive them land with PC-7/PC-8.
      ['order_line_resolution.ts:matchLineAgainstCatalog', 'buyer routes land with PC-7/PC-8'],
      ['order_line_resolution.ts:discoveryRequirementsFor', 'buyer routes land with PC-7/PC-8'],
      ['order_line_resolution.ts:hydrateOrderLineEvidence', 'buyer routes land with PC-7/PC-8'],
      // §5.1's aggregate (PC-5): the store and derivations exist and are
      // exercised by `order_draft_store.test.ts`; the state-machine
      // service and routes are the rest of PC-5/PC-7.
      ['order_draft_store.ts:liveConversationFor', 'service lands with PC-5'],
      // §4.2's reservation ledger (PC-3): the claim primitive exists and is
      // exercised by `sku_ledger.test.ts`; the mint policy in the pack's
      // importer/assembler and the repair-screen integration are the rest
      // of PC-3, and these entries leave when that lands.
      // §6's artifact store (PC-2): ingest, egress revalidation and the
      // retention listing exist and are exercised by
      // `image_artifacts.test.ts`; the routes + composition-root
      // re-encoder install land with the seller lane (PC-3).
      ['image_artifacts.ts:revalidateStoredArtifact', 'routes land with PC-3'],
      ['image_egress.ts:imageEgressBrokerInstalled', 'gate lands with PC-2/PC-3'],
      ['buyer_requests.ts:InMemoryBuyerQuoteRequestRepository', 'test double'],
      ['order_approvals.ts:InMemoryOrderApprovalRepository', 'test double'],
      ['buyer_quotes.ts:InMemoryBuyerQuoteRepository', 'test double'],
      ['buyer_status.ts:InMemoryBuyerStatusRepository', 'test double'],
      ['buyer_orders.ts:InMemoryBuyerOrderRepository', 'test double'],
      ['settings_store.ts:InMemoryCommerceSettingsRepository', 'test double'],
      ['pending_decisions.ts:InMemoryPendingSupplierDecisionRepository', 'test double'],
      ['watermarks.ts:InMemoryCommerceEpochWatermarkRepository', 'test double'],
      ['credential_store.ts:InMemoryCredentialStore', 'test double'],

      // §8.3's LEASE FALLBACK, deliberately unreached. The spec permits a
      // narrowly scoped lease only when a connector cannot work through a
      // typed operation, and none of the connectors that exist needs one — the
      // spreadsheet and REST backends both go through `broker.perform`.
      //
      // It stays built and unwired on purpose. Adding a route that issues
      // leases with nothing to redeem them would put a credential-leasing
      // endpoint on the node for no working feature, which is attack surface
      // bought with nothing. The check is here so the connector that finally
      // needs one gets the five-way binding rather than inventing a fourth.
      ['credential_broker.ts:redeemLease', '§8.3 fallback; no connector needs a lease yet'],

      // THE BUYER LANE (WS-5 / WS-7). Discovery, fan-out, ranking and
      // evidence are built and gated; nothing calls them because the buyer
      // surface that would — the mobile screens and the AppView-backed
      // discovery — is not built. `procurement_journey` drives them directly,
      // which is why they look exercised and are not.
      // All FOUR catalog functions are wired now (WS-5.1). `ingestCatalog`
      // waited longest and its old ledger reason was right: it fetches, and a
      // route that CONSTRUCTED a `FeedTransport` would put an outbound request
      // behind an owner endpoint where the egress gates cannot see it. The
      // resolution kept that boundary instead of crossing it — the composition
      // root INSTALLS a transport, the route only asks whether one exists, and
      // Core stays the half that verifies what comes back.
      // Ranking, fan-out and the evidence headline are WIRED (WS-5/WS-7 Core
      // half): `procurement_service` composes them and two owner routes call
      // it. `composeProductEvidence` stays: it BUILDS the evidence the
      // headline summarises, and building it needs a PeerLens read that Core
      // does not have — the service takes composed evidence as an argument
      // rather than learning to fetch.
      ['product_evidence.ts:composeProductEvidence', 'WS-5: no PeerLens evidence reader in Core'],
      // The buyer lane is WIRED end to end: `submitApprovedOrder` verifies the
      // §15.2 binding, creates the §12.7 record, sends through the
      // service-query lane, and settles — with both composition roots binding
      // the sender. Nothing here is left to a future item.
      // §12.7's re-poll is WIRED (WS-7.7), and the two corrections along the
      // way are worth keeping. The first ledger entry said it "just needs a
      // tick"; the second said the blocker was the signature. Both were
      // right in turn. `sweepReconcilePolls` took an
      // `ask: (…) => Promise<OrderReconcileResult | null>` — a REQUEST that
      // resolved to its own answer — and the requester lane does not work
      // that way: every outbound `service.query` is fire-and-forget with the
      // answer arriving later as a correlated `service.response`. So the
      // sweep is now split into ASK (`askReconcilePolls`, which fires and
      // advances `nextPollAtMs`) and APPLY (`applyReconcileAnswer`, driven
      // from the inbound response), and `ReconcilePollSweeper` runs the ask
      // on a tick both composition roots start.

      // §20.10 probing resistance is now WIRED (WS-2.11): the ingress spends
      // budget before dispatch. Only the assertion helper remains unwired,
      // and it is a property-checker for tests by design.
      ['probing_resistance.ts:refusalsAreUniform', 'assertion helper, used by tests only'],

      // The reference packs are no longer documentation-only: `install_plan`
      // installs them, one per role, which is what §18.1's "two installs, not
      // one superset" turns into in practice.

      // The single-record form of the watermark check. The RESULT form
      // (`admitSupplierRecords`) is wired at the tool lane; this one waits for
      // a per-record arrival seam. Kept because the two share their rules and
      // splitting them later would duplicate the comparison.
      ['watermark_gate.ts:admitSupplierEpoch', 'single-record form; result form is wired'],
    ]);

    const exported = new Map<string, Set<string>>();
    for (const file of tsFiles(COMMERCE_SRC)) {
      const name = path.basename(file);
      if (name === 'index.ts') continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      const names = new Set<string>();
      for (const re of [
        /^export (?:async )?function (\w+)/gm,
        /^export const (\w+)/gm,
        /^export class (\w+)/gm,
      ]) {
        for (const m of body.matchAll(re)) names.add(m[1]);
      }
      if (names.size > 0) exported.set(file, names);
    }

    // Every production file in the repo, so "wired" means reachable from
    // somewhere real rather than from a sibling in this directory.
    const production: { file: string; body: string }[] = [];
    const roots = [path.join(CORE_SRC, '..', '..'), path.join(CORE_SRC, '..', '..', '..')];
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (['node_modules', 'dist', '.git', '__tests__', '__e2e__'].includes(e.name)) continue;
          walk(full);
        } else if (/\.tsx?$/.test(e.name) && !seen.has(full)) {
          seen.add(full);
          // COMMENTS STRIPPED HERE TOO. The first version of this guard read
          // production files raw, so a symbol named only in another module's
          // PROSE counted as wired — which is how `buildCatalogSnapshot`, whose
          // sole non-test mention is a sentence in `catalog_import.ts`, sat off
          // the ledger looking called. A guard with a comment-shaped bypass is
          // worse than no guard, because it certifies.
          production.push({ file: full, body: code(fs.readFileSync(full, 'utf8')) });
        }
      }
    };
    // Every package AND every app. The composition roots that wire commerce
    // live in `apps/` — a walker that stopped at `packages/` would report
    // `createCommerceRuntime` itself as unwired, which is how this guard
    // failed the first time it ran.
    const REPO = path.join(CORE_SRC, '..', '..', '..');
    walk(path.join(REPO, 'packages'));
    walk(path.join(REPO, 'apps'));
    void roots;

    /**
     * Which commerce files are REACHABLE from outside the directory.
     *
     * Grown over SYMBOLS, not imports, because cross-package callers reach
     * commerce through the barrel (`from '@dina/core'`) and a barrel that
     * `export *`s everything would make every module look reachable. A file
     * joins when one of its exported names appears in a file that is already
     * reachable: `boot.ts` names `startCommerceSweepers`, so `sweepers.ts`
     * joins; `sweepers.ts` names `CommerceEpochRevalidator`, so
     * `epoch_revalidator.ts` joins.
     *
     * A ring of modules that only mention each other never joins, which is the
     * hole this closes — the guard used to accept `p.file !== file`, so a
     * cluster of mutually-referencing orphans certified itself.
     */
    const reachable = new Set<string>(
      production.filter((p) => !p.file.startsWith(COMMERCE_SRC + path.sep)).map((p) => p.file),
    );
    const commerceFiles = production.filter((p) => p.file.startsWith(COMMERCE_SRC + path.sep));
    for (let grew = true; grew; ) {
      grew = false;
      for (const candidate of commerceFiles) {
        if (reachable.has(candidate.file)) continue;
        const names = [...(exported.get(candidate.file) ?? [])];
        const named = names.some((name: string) => {
          const probe = new RegExp(`\\b${name}\\b`);
          return production.some(
            (p) =>
              p.file !== candidate.file &&
              reachable.has(p.file) &&
              path.basename(p.file) !== 'index.ts' &&
              probe.test(p.body),
          );
        });
        if (named) {
          reachable.add(candidate.file);
          grew = true;
        }
      }
    }

    const unwired: string[] = [];
    for (const [file, names] of exported) {
      const own = fs.readFileSync(file, 'utf8');
      // Strings stripped for the SAME-FILE count only: a class that names
      // itself in an error message is not calling itself.
      const ownCode = codeNoStrings(own);
      for (const name of names) {
        const counted = new RegExp(`\\b${name}\\b`, 'g');
        const decl = new RegExp(
          `^export (?:async function |const |class |function )${name}\\b`,
          'gm',
        );
        const sameFile = (ownCode.match(counted) ?? []).length - (ownCode.match(decl) ?? []).length;
        // SAME-FILE USE COUNTS, WITH ONE EXCEPTION.
        //
        // A constant its own module reads is live production code, reachable
        // through whatever that module exports; flagging it would fill the
        // ledger with forty entries and a ledger nobody can read hides the
        // next real orphan as surely as a stale entry does.
        //
        // An `InMemory*` class is different. It is a TEST DOUBLE by
        // convention — the ledger already carries five of them for exactly
        // that reason — and a double has no legitimate production caller, so
        // its own file naming it proves nothing. Excluding them from the
        // bypass is what surfaced `InMemoryIdempotencyEvidenceRepository`,
        // which has one test caller, no production caller, and had never
        // reached the ledger.
        if (sameFile > 0 && !/^InMemory/.test(name)) continue;
        // A FRESH, non-global regex per probe. `/g` makes `.test()` stateful
        // through `lastIndex`, so reusing one across files silently skips
        // every other match — the second bug this guard had on its first run.
        const probe = new RegExp(`\\b${name}\\b`);
        // A REACHABLE file, not merely a different one.
        //
        // The comment above always claimed "reachable from somewhere real
        // rather than from a sibling in this directory", and the code checked
        // only `p.file !== file` — so a commerce symbol named solely by another
        // commerce module counted as wired even when that module was itself
        // dead. A cluster of mutually-referencing orphans passed, on exactly
        // the defect class this ledger exists to surface.
        //
        // `reachable` is the transitive closure computed above: outside the
        // directory always, and inside it only when something reachable
        // imports it. That keeps the legitimate in-directory composition —
        // `runtime.ts` constructs the stores, the stores use `rehydrate` —
        // while a ring of dead modules is reachable from nothing.
        const elsewhere = production.some(
          (p) =>
            p.file !== file &&
            reachable.has(p.file) &&
            path.basename(p.file) !== 'index.ts' &&
            probe.test(p.body),
        );
        if (!elsewhere) unwired.push(`${path.basename(file)}:${name}`);
      }
    }

    // Anything unwired must be ON the ledger, and nothing on the ledger may
    // have been quietly wired without being removed from it — a stale entry
    // hides the next one.
    expect(unwired.filter((u) => !NOT_YET_WIRED.has(u))).toEqual([]);
    expect([...NOT_YET_WIRED.keys()].filter((k) => !unwired.includes(k))).toEqual([]);
  });

  /**
   * ARCH-0b / ARCH-0c. Thirteen `this.deps.tx(() => …)` calls used to live
   * inside three domain classes. Each was correct; together they meant nobody
   * could answer "what is atomic here?" without reading 2,500 lines, and
   * nothing stopped a fourteenth from being added wrong — nested (which fails
   * on mobile only, because op-sqlite cannot nest a raw BEGIN, while the
   * reentrant server test runner passes) or forgotten (which lets the second
   * of two writes fail alone).
   *
   * The boundary now belongs to the services. This asserts it stayed there.
   */
  it('only the transaction coordinator holds a transaction runner', () => {
    const ALLOWED = new Set([
      // The coordinator IS the holder.
      'transaction.ts',
      // The composition root builds it, once, from the Tier-0 runner.
      'runtime.ts',
    ]);
    const offenders: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      if (ALLOWED.has(path.basename(file))) continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      // A `TxRunner` TYPE or a `.tx(` CALL. The first catches a dependency
      // that could open one; the second catches opening one through some
      // other name.
      if (/\bTxRunner\b/.test(body) || /\.tx\s*\(/.test(body)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The other half of the same rule: a DOMAIN method that runs inside a
   * transaction says so in its name, so a caller cannot reach one by accident
   * from outside a boundary.
   */
  it('every public method on an engine is named InTx or Record', () => {
    const ENGINES = ['admission.ts', 'lifecycle_engine.ts'];
    const offenders: string[] = [];
    for (const name of ENGINES) {
      const body = code(fs.readFileSync(path.join(COMMERCE_SRC, name), 'utf8'));
      for (const m of body.matchAll(/^ {2}(?!private |constructor|get |static )(\w+)\(/gm)) {
        const method = m[1] ?? '';
        if (
          !method.endsWith('InTx') &&
          !method.endsWith('Record') &&
          !method.endsWith('ForOwnBuyer')
        ) {
          offenders.push(`${name}:${method}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE HOLE THAT HID THE QUOTE LANE. A cold audit found that
   * `CommerceAdmissionService.registerSignedQuote` had no production caller —
   * every journey test called it directly, so the supplier could not issue a
   * quote on a real node and 8,000 green tests said nothing about it.
   *
   * The orphan ledger above could not have caught it: it scans top-level
   * `export function|const|class` and never class METHODS, so an unwired
   * method on a wired class is invisible to it. That is the specific gap, and
   * this is the specific guard — narrow on purpose. Extending the whole ledger
   * to every method would demand an allow-list of internal helpers large
   * enough to hide the next one in.
   *
   * APPLICATION SERVICES ONLY. These are the seams the rest of Core is meant
   * to enter commerce through, so a public method here with no caller is a
   * capability the product does not actually have.
   */
  it('every public method on an application service has a production caller', () => {
    // DERIVED, NOT TYPED OUT. The list was two hand-written filenames, so
    // `catalog_draft_service.ts` — added later — was outside the rule
    // entirely, and its `recordEdit` sat with no caller and no ledger row
    // while this test passed. A guard whose scope is maintained by memory
    // stops covering the thing it was written for on the day someone adds a
    // file. Any `*_service.ts` in this directory is in.
    const SERVICES = fs
      .readdirSync(COMMERCE_SRC)
      .filter((f) => f.endsWith('_service.ts'))
      .sort();
    expect(SERVICES.length).toBeGreaterThanOrEqual(3);
    // A method may be listed only with a reason it is not yet reachable.
    const NOT_YET_CALLED = new Map<string, string>([
      [
        // SUPERSEDED, not merely unused. `issueQuote` replaced it: this one
        // infers the audience from `quote.buyer_did`, which is the record
        // checking itself, while `issueQuote` takes the authenticated sender.
        // Kept only because the quote-ledger tests exercise registration
        // directly; it should be deleted once those move to `issueQuote`, and
        // a new production caller must never be added.
        'admission_service.ts:registerSignedQuote',
        'superseded by issueQuote — delete once quote-ledger tests migrate',
      ],
      // The §16.2 recovery ceremony USED TO BE HERE — all three of it, plus
      // `registerReplacementQuote` — and the reason given was "no operator
      // surface yet". It stayed true for as long as nobody looked: a restored
      // supplier could LIST its frozen orders and had no way to recover one.
      // The routes exist now (`/v1/commerce/reconciliation/order`, `/fence`,
      // `/v1/commerce/quotes/replacement`), so the rows are gone.
      [
        'reconciliation_service.ts:signGenesis',
        '§9.11 genesis signing is reached through decideOrder today; no direct caller',
      ],
    ]);
    const callers = tsFiles(CORE_SRC)
      .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`))
      .map((f) => ({ name: path.basename(f), body: codeNoStrings(fs.readFileSync(f, 'utf8')) }));

    const offenders: string[] = [];
    for (const service of SERVICES) {
      const body = code(fs.readFileSync(path.join(COMMERCE_SRC, service), 'utf8'));
      for (const m of body.matchAll(/^ {2}(?!private |constructor|get |static )(\w+)\(/gm)) {
        const method = m[1] ?? '';
        const key = `${service}:${method}`;
        if (NOT_YET_CALLED.has(key)) continue;
        // Called from anywhere in production that is not the service itself.
        const called = callers.some(
          (c) => c.name !== service && new RegExp(`\\.${method}\\s*\\(`).test(c.body),
        );
        if (!called) offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * AN ALLOWLIST THAT CANNOT EXPIRE IS A PERMANENT EXCUSE.
   *
   * The check above skips every allowlisted key outright, so a row whose
   * reason has since been fixed sits there for ever, still saying the product
   * lacks a capability it now has. That is the same shape as the defects this
   * file exists to catch: a statement nothing re-examines.
   *
   * So a row is wrong in BOTH directions — an unwired method missing from it,
   * and a wired method still in it.
   */
  it('the not-yet-called allowlist has no stale rows', () => {
    const ALLOWLISTED = ['reconciliation_service.ts:signGenesis'];
    const callers = tsFiles(CORE_SRC)
      .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`))
      .map((f) => ({ name: path.basename(f), body: codeNoStrings(fs.readFileSync(f, 'utf8')) }));

    const stale = ALLOWLISTED.filter((key) => {
      const [service = '', method = ''] = key.split(':');
      return callers.some(
        (c) => c.name !== service && new RegExp(`\\.${method}\\s*\\(`).test(c.body),
      );
    });
    expect(stale).toEqual([]);
  });

  /**
   * THE HOLE IN THE GUARD ABOVE, closed by the audit that found it.
   *
   * The service-method check is scoped to application services, and the
   * class-level ledger counts a symbol as wired the moment `runtime.ts` names
   * its constructor. So a REPOSITORY the runtime builds, whose only mutator
   * nothing ever calls, passes both — which is exactly how
   * `BuyerQuoteRequestRepository.put` shipped with no writer while its reader
   * refused every inbound quote as `unsolicited_quote`. Eight thousand tests
   * were green and the buyer's quote path was unreachable in production.
   *
   * A STORE THAT IS NEVER WRITTEN IS NOT A STORE. Read methods are exempt by
   * name because plenty of stores are legitimately read-only from Core's side;
   * a mutator is a capability, and a capability with no caller is one the
   * product does not have.
   *
   * The class list is DERIVED from the composition root rather than typed out,
   * so a store added to `runtime.ts` tomorrow is covered without anyone
   * remembering to add it here.
   */
  it('every mutator on a runtime-constructed commerce store has a production caller', () => {
    const READ_ONLY = /^(get|list|count|find|has|load|chain|recent|all|peek|latest|evidence)/;
    const NOT_YET_CALLED = new Map<string, string>([
      // Each entry is a capability the product does not YET have, said out
      // loud. A row here is a promise to wire it, not permission to forget.
      [
        'idempotency_store.ts:forget',
        '§15.5 probe eviction — no retention sweep calls it yet',
      ],
      // Exposed the moment this rule stopped counting the in-memory double's
      // `Map.delete` as a use. A draft holds the extracted rows of a
      // photographed price list — the seller's own data — and there is no way
      // to remove one: no route, no sweep, no erasure path. §10 item 7 records
      // retention, erasure and export as undefined FOR THE DRAFT STORE
      // SPECIFICALLY, so this is that gap with a name rather than a new one.
      [
        'sku_ledger.ts:holder',
        '§4.2 — read by the repair screen surface when PC-3 lands its routes',
      ],
      [
        'order_draft_store.ts:delete',
        '§6 buyer erasure — rides PC-8\'s retention screen with the photographs',
      ],
      [
        'sku_ledger.ts:highWater',
        '§4.2 — read by the repair screen surface when PC-3 lands its routes',
      ],
    ]);

    // BOUND TO THE RUNTIME FIELD, not to the bare method name. A first version
    // searched for `.put(` anywhere and every store passed, because half of
    // them have a `put`. Matching the field the composition root exposes —
    // `buyerQuoteRequests.put(` — is what makes the question "is THIS store
    // written" rather than "does any store have a method by this name".
    const runtimeSource = code(fs.readFileSync(path.join(COMMERCE_SRC, 'runtime.ts'), 'utf8'));
    const fieldOfClass = new Map<string, string>();
    for (const m of runtimeSource.matchAll(/(\w+):\s*new\s+(SQLite\w+)\s*\(/g)) {
      fieldOfClass.set(m[2] ?? '', m[1] ?? '');
    }
    const callers = tsFiles(CORE_SRC)
      .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`))
      .map((f) => ({ file: f, body: codeNoStrings(fs.readFileSync(f, 'utf8')) }));

    const offenders = new Set<string>();
    /** Mutators that DO have a caller — used to catch a stale allowlist row. */
    const certified = new Set<string>();
    for (const file of tsFiles(COMMERCE_SRC)) {
      const name = path.basename(file);
      const body = code(fs.readFileSync(file, 'utf8'));
      for (const cls of body.matchAll(/^export class (SQLite\w+)(?:\s+implements\s+(\w+))?/gm)) {
        const field = fieldOfClass.get(cls[1] ?? '');
        if (field === undefined) continue;
        const iface = cls[2];
        for (const m of body.matchAll(/^ {2}(?!private |constructor|get |static )(\w+)\(/gm)) {
          const method = m[1] ?? '';
          if (READ_ONLY.test(method)) continue;
          const key = `${name}:${method}`;
          // NOT skipped when listed: a listed mutator is still evaluated so a
          // row that has quietly become wired can be caught below.
          // THREE WAYS TO COUNT AS CALLED, and all three are real wiring:
          //
          //   - the store's OWN module uses it. `verifyInboundQuote` lives
          //     beside the repository it appends to and takes it as a
          //     parameter, so the receiver is a local name; the module owns
          //     its store and that is the ordinary shape here.
          //   - somewhere else reaches it through the runtime FIELD, which is
          //     the only name the composition root exposes.
          //   - a collaborator receives the store by INJECTION and calls it
          //     under a local name. `CatalogDraftService` takes the runtime's
          //     `catalogDrafts` as `drafts: CatalogDraftRepository`, so a
          //     field-name search saw an unwritten store where six writes sit.
          //     The receiver is matched by its DECLARED INTERFACE, not by name,
          //     which is why this stays the question "is THIS store written":
          //     another store's `put` is typed to another interface and cannot
          //     answer for this one.
          //
          // What none of them covers is a mutator nothing invokes at all,
          // which is the case this test exists for.
          const ownModuleUses = new RegExp(`\\.${method}\\s*\\(`).test(
            // Strip the class body's own declaration line so a method is not
            // counted as calling itself — AND the in-memory double's body,
            // which is not production and whose `Map`/`Set` calls share names
            // with the mutators being checked. `SQLiteCatalogDraftRepository
            // .delete` has no caller anywhere, and
            // `InMemoryCatalogDraftRepository.delete`'s `this.rows.delete(...)`
            // — a `Map.delete` — matched the pattern and certified it wired.
            withoutInMemoryClasses(body).replace(
              new RegExp(`^ {2}${method}\\(`, 'gm'),
              '  __decl__(',
            ),
          );
          const call = new RegExp(`\\b${field}\\.${method}\\s*\\(`);
          const calledElsewhere = callers.some(
            (c) => path.basename(c.file) !== name && call.test(c.body),
          );
          // The injected receiver must be DECLARED with this store's interface
          // in the same file that calls the method, so the annotation and the
          // call cannot come from two unrelated places.
          const calledByInjection =
            iface !== undefined &&
            callers.some((c) => {
              if (path.basename(c.file) === name) return false;
              const receivers = [...c.body.matchAll(new RegExp(`(\\w+)\\s*:\\s*${iface}\\b`, 'g'))]
                .map((r) => r[1] ?? '')
                .filter((r) => r.length > 0);
              return receivers.some((r) => new RegExp(`\\b${r}\\.${method}\\s*\\(`).test(c.body));
            });
          const wired = ownModuleUses || calledElsewhere || calledByInjection;
          if (wired) certified.add(key);
          else if (!NOT_YET_CALLED.has(key)) offenders.add(key);
        }
      }
    }
    expect([...offenders]).toEqual([]);
    // AND THE LIST MUST NOT GO STALE, the same rule the orphan ledger carries.
    // Without this, a row stays after its mutator is wired, and worse, a row
    // whose mutator was NEVER unwired reads as a promise being kept. The
    // `catalog_draft_store.ts:delete` row went on this list only because the
    // rule had been counting the in-memory double's `Map.delete`; a
    // rule-and-list pair with no staleness check cannot tell those apart.
    expect([...NOT_YET_CALLED.keys()].filter((k) => certified.has(k))).toEqual([]);
  });

  it('no production file outside an owner calls a raw persistence mutator', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      if (OWNERS.has(path.basename(file))) continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      for (const mutator of RAW_MUTATORS) {
        // `.mutator(` — a call through some receiver, which is exactly the
        // bypass shape. A bare identifier could be an unrelated local.
        if (new RegExp(`\\.${mutator}\\s*\\(`).test(body)) {
          offenders.push(`${path.basename(file)} calls .${mutator}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the mutable per-repository globals are gone', () => {
    // Five setters and five getters used to hand the raw repositories to any
    // caller that asked. They are replaced by one composition root.
    const offenders: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      const body = code(fs.readFileSync(file, 'utf8'));
      if (/export function (get|set)Commerce\w*Repository\s*\(/.test(body)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('commerce engines depend on aggregate stores, never on raw repositories', () => {
    const engines = ['admission.ts', 'lifecycle_engine.ts', 'epoch_service.ts'];
    for (const name of engines) {
      const body = code(fs.readFileSync(path.join(COMMERCE_SRC, name), 'utf8'));
      // A dependency FIELD typed as a raw repository is the bypass; a type
      // import for a signature is not, so match the declaration shape.
      expect(body).not.toMatch(/^\s+\w+:\s*Commerce\w*(Ledger|Head|Ref)Repository;/m);
    }
  });

  it('only the composition root constructs the commerce engines', () => {
    // The engines were previously built by tests and by nothing else, so the
    // whole subsystem was unreachable in production and no test could notice.
    // Construction is now the root's job for a second reason too: the engines
    // must share ONE Tier-0 transaction runner and be tied to each other
    // (§12.8 acceptance-with-genesis). A caller that builds its own gets
    // neither, and gets them silently.
    const engines = ['CommerceAdmissionEngine', 'CommerceLifecycleEngine', 'CommerceEpochService'];
    const offenders: string[] = [];
    for (const file of tsFiles(CORE_SRC)) {
      if (path.basename(file) === 'runtime.ts' && file.includes('commerce')) continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      for (const engine of engines) {
        if (new RegExp(`new ${engine}\\s*\\(`).test(body)) {
          offenders.push(`${path.basename(file)} constructs ${engine}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * BOTH BOOTS START THE COMMERCE TICKS (WS-2.4).
   *
   * The admission sweep used to be started inside the shared workflow plane,
   * under a comment saying both boots got it from one place. They did not: the
   * phone composes its own background work and never calls that plane. So on
   * the product's primary surface no abandoned reservation ever timed out and
   * no quote capacity was ever refunded — and the same shape of gap left the
   * phone with no epoch service at all, which meant every commerce operation
   * there refused for ever.
   *
   * A behavioural test on one boot cannot see this: it passes while the other
   * boot does nothing. So the claim is asserted over both composition roots.
   */
  it('every composition root starts and stops the commerce background ticks', () => {
    const REPO = path.join(CORE_SRC, '..', '..', '..');
    const ROOTS = [
      // The server's Fastify boot.
      path.join(REPO, 'apps', 'home-node-lite', 'core-server', 'src', 'boot.ts'),
      // The phone's plane, started from `boot_service.ts` and stopped from the
      // identity teardown in `storage/init.ts`.
      path.join(REPO, 'apps', 'mobile', 'src', 'services', 'commerce_plane.ts'),
    ];
    const missing: string[] = [];
    for (const root of ROOTS) {
      const body = code(fs.readFileSync(root, 'utf8'));
      if (!/startCommerceSweepers\s*\(/.test(body)) missing.push(`${path.basename(root)}: start`);
      // Stopping matters as much: a phone that kept the epoch tick running
      // after an identity switch would go on re-reading the previous
      // identity's repo.
      if (!/\.stop\(\)/.test(body)) missing.push(`${path.basename(root)}: stop`);
    }
    expect(missing).toEqual([]);
  });

  /**
   * §12.7 — both roots must install the held-evidence reader.
   *
   * The regression is recorded in `reconcile_poller.ts` and it is worth the
   * second guard: `installHeldEvidenceReader` was once called only from tests,
   * so every real node presented NO evidence — which makes a supplier's
   * `never_received` legal, and that is the one answer authorizing a
   * resubmission. §12.7's re-adoption path was inert end to end.
   *
   * STATIC AND OVER BOTH ROOTS, for the reason the sweeper guard above gives:
   * a behavioural test on one boot passes while the other does nothing. And
   * static rather than through an exported getter, because an accessor whose
   * only caller is a test is the same orphan shape this ledger exists to
   * catch — the fix for "is it wired" must not itself be unwired.
   */
  it('every composition root installs the held-evidence reader', () => {
    const REPO = path.join(CORE_SRC, '..', '..', '..');
    const ROOTS = [
      path.join(REPO, 'apps', 'home-node-lite', 'core-server', 'src', 'storage', 'init.ts'),
      path.join(REPO, 'apps', 'mobile', 'src', 'storage', 'init.ts'),
    ];
    const missing: string[] = [];
    for (const root of ROOTS) {
      const body = code(fs.readFileSync(root, 'utf8'));
      if (!/installHeldEvidenceReader\s*\(/.test(body)) {
        missing.push(`${path.basename(path.dirname(root))}/init.ts: install`);
      }
      // The reader must be BUILT from the node's own repositories rather than
      // handed something narrower: `makeHeldEvidenceReader` is what reads the
      // acknowledgement envelope and the status chain, and installing a
      // hand-rolled stand-in is how a node comes to present less than it holds.
      if (!/makeHeldEvidenceReader\s*\(/.test(body)) {
        missing.push(`${path.basename(path.dirname(root))}/init.ts: make`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a symbol named only inside a string does not count as wired', () => {
    // The hole this closes: a class that names itself in an error message
    // looked internally consumed, so any such class could sit unwired and off
    // the ledger. Interpolations still count, because they are references.
    const source = [
      'export class Widget {}',
      "const message = 'Widget: this is prose';",
      'const used = `${Gadget}`;',
    ].join('\n');
    const stripped = codeNoStrings(source);
    expect(stripped).not.toContain('this is prose');
    expect((stripped.match(/\bWidget\b/g) ?? []).length).toBe(1);
    expect(stripped).toContain('Gadget');
  });

  it('only the composition root constructs SQLite commerce repositories', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(CORE_SRC)) {
      if (path.basename(file) === 'runtime.ts' && file.includes('commerce')) continue;
      const body = code(fs.readFileSync(file, 'utf8'));
      // `SQLite\w+Repository`, NOT `SQLiteCommerce\w+Repository`. The narrower
      // pattern was the shape of the first version and it let two real
      // repositories through — `SQLiteBuyerOrderRepository` and
      // `SQLiteCatalogPointerRepository` — because neither carries `Commerce`
      // in its name. A guard that matches the naming convention rather than
      // the thing certifies whatever happens to be named differently.
      const m = body.match(/new SQLite\w+Repository\s*\(/g);
      if (m) offenders.push(`${path.basename(file)} (${m.length})`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * WS-3.7's headline claim, made executable.
   *
   * "The one place an order leaves this node" was prose. Nothing enforced it,
   * so a second dispatch added later would break it silently — and the cost of
   * that break is the one this workstream keeps designing against: two paths
   * that disagree about what a failed send means, one of which authorizes a
   * duplicate order for real goods.
   *
   * The capability name is the chokepoint, because ANY second path has to name
   * it to reach a supplier. The allow-list carries a reason per file, the same
   * discipline as the rehydration guard: a fifth file joining is a fact worth
   * examining, not a line to add.
   */
  it('only the buyer sender puts an order on the wire', () => {
    const ALLOWED = new Map<string, string>([
      // THE send path: builds the outbound service.query envelope.
      ['buyer_sender.ts', 'the one outbound path'],
      // The buyer's INGRESS: reads the supplier's answer back off the wire.
      ['buyer_response.ts', 'reads the answer, sends nothing'],
      // Supplier side: names the capability this node SERVES.
      ['order_decision.ts', 'supplier serving the capability'],
      ['provider_ingress.ts', 'supplier plugin lane serving the capability'],
    ]);
    const offenders: string[] = [];
    const REPO = path.join(CORE_SRC, '..', '..', '..');
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', '__tests__', '__e2e__', '.git'].includes(entry.name)) {
            continue;
          }
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
        if (ALLOWED.has(entry.name)) continue;
        // Comments stripped: a file DESCRIBING the capability in prose is not
        // a file sending one. Strings are kept, because the capability travels
        // as a string literal and stripping them would blind the guard to the
        // only form the defect takes.
        if (/\bsubmit_order\b/.test(code(fs.readFileSync(full, 'utf8')))) {
          offenders.push(path.relative(REPO, full));
        }
      }
    };
    walk(path.join(REPO, 'packages'));
    walk(path.join(REPO, 'apps'));
    expect(offenders).toEqual([]);
  });

  /**
   * WS-7.5 (§18.5, §15.2), made executable for the same reason.
   *
   * The approval card is bound to ONE canonical payload, and the binding is
   * checked on both halves before anything moves: the BUYER re-derives it from
   * the order actually about to be sent, and the SUPPLIER checks it before the
   * decision is recorded. The failure this prevents is not exotic — it is an
   * order re-planned between the tap and the send, or a runner answering
   * `accepted` where the owner approved `rejected`.
   *
   * A THIRD path that decided or dispatched an order without calling the
   * verifier would let the card and the order diverge, and nothing today would
   * notice. Exactly TWO call sites, and both must be present: a guard that only
   * caps the count would pass a build where one half stopped checking.
   */
  it('both halves check the approval binding, and nothing else does', () => {
    const EXPECTED = ['buyer_executor.ts', 'order_decision.ts'];
    const callers: string[] = [];
    for (const file of tsFiles(COMMERCE_SRC)) {
      const base = path.basename(file);
      if (base === 'approval_payload.ts') continue; // where it is defined
      const body = code(fs.readFileSync(file, 'utf8'));
      // A CALL, not an import: `verifyApprovalBinding(` with an argument list.
      if (/\bverifyApprovalBinding\s*\(/.test(body)) callers.push(base);
    }
    expect(callers.sort()).toEqual(EXPECTED);
  });

  /**
   * The other half of WS-3.7: a root that composes commerce but installs no
   * sender has an order surface that refuses at the last step, which reads to
   * an owner as the supplier being unreachable.
   *
   * Both roots do this in `storage/init.ts` rather than in the boot, because
   * the sender is bound to the identity's transport and must be torn down with
   * it — the phone's teardown is the reason this is not in `boot.ts`.
   */
  it('every composition root installs the buyer order sender', () => {
    const REPO = path.join(CORE_SRC, '..', '..', '..');
    const ROOTS = [
      path.join(REPO, 'apps', 'home-node-lite', 'core-server', 'src', 'storage', 'init.ts'),
      path.join(REPO, 'apps', 'mobile', 'src', 'storage', 'init.ts'),
    ];
    const missing: string[] = [];
    for (const root of ROOTS) {
      const body = code(fs.readFileSync(root, 'utf8'));
      if (!/installBuyerOrderSender\s*\(\s*makeServiceQueryBuyerSender/.test(body)) {
        missing.push(`${path.basename(path.dirname(path.dirname(root)))}: sender`);
      }
      // The dispatch it sends over. Installing the sender without the dispatch
      // is a sender that refuses every order, which is worse than none because
      // it looks configured.
      if (!/installCommerceServiceQueryDispatch\s*\(\s*serviceQueryDispatch/.test(body)) {
        missing.push(`${path.basename(path.dirname(path.dirname(root)))}: dispatch`);
      }
    }
    expect(missing).toEqual([]);
  });
});
