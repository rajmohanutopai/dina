# Researcher Kernel — Group A test plan (the consumer research loop)

Status: Group A built (Steps 1–6), unit/integration tests green, deep-reviewed. This
plan enumerates **every scenario** the money-free consumer research loop must satisfy,
so a thorough (multi-agent) audit can check each against the implementation AND its test
coverage — finding bugs, workarounds, coverage gaps, code smells, and spec deviations.

Spec: `docs/RESEARCHER_KERNEL_ARCHITECTURE.md` §5.A (A1–A6). Functional reference:
`dina_details.md`. The loop: `/ask "best/compare X"` → `search_products` → AppView catalog
+ seller trust → catalog→Offer bridge → `rankOffers` → money-free `where_to_buy`
comparison card → chat card → mobile render. **No money ever moves (Cart Handover).**

---

## L1 — Catalog→Offer bridge (`packages/core/src/commerce/catalog_offers.ts`)
Tests: `__tests__/commerce/catalog_offers.test.ts`.

- **L1.1** A priced candidate maps to an `Offer` with a deterministic synthetic quoteId `catalog:${supplierDid}:${scheme}:${value}:${snapshotRef}`.
- **L1.2** `expiresAt` = `validUntil` when present, else the `CATALOG_NEVER_EXPIRES` sentinel (year ≥ 9000).
- **L1.3** An unpriced candidate is **reported in `unpriced`, never dropped**.
- **L1.4** `availableQuantity` = the requested quantity (deliberately neutralises the ranking's stock filter — a catalog snapshot has no live stock; verify this is honest and documented, not a silent bypass).
- **L1.5** `indicativePrice` becomes the comparable total; no fabricated fields.
- **L1.6** Malformed/partial candidate rows do not crash the bridge.

## L2 — Seller trust producer (`packages/brain/src/reasoning/trust_producer.ts`)
Tests: `__tests__/reasoning/trust_producer.test.ts`.

- **L2.1** `overallTrustScore` 0..1 → 0..10000 bp, clamped.
- **L2.2** `null` trust → `undefined` (NOT scored as a zero — §13.4 absent-≠-worst).
- **L2.3** `fetchSellerTrustBp` is fail-soft per DID: one `getProfile` throwing does not sink the others.
- **L2.4** DIDs are de-duplicated before fetch.
- **L2.5** A DID absent from the returned map means "no trust", never zero.

## L3 — Offer ranking reuse (`packages/core/src/commerce/offer_ranking.ts`)
Group A REUSES this; it must not re-score or fork. Weights: price 6000, lead_time 2500, trust 1500.

- **L3.1** The cheaper comparable offer wins on price.
- **L3.2** An offer with absent trust is not penalised as zero — the trust weight is redistributed, not applied as 0 (§13.4).
- **L3.3** A currency-mismatched offer is excluded/reported, never silently converted (§9.1).
- **L3.4** Ranking order is stable and drives the card (the card does not re-sort).

## L4 — The `search_products` tool (`packages/brain/src/reasoning/product_tools.ts`)
Tests: `__tests__/reasoning/product_tools.test.ts`. AppView surface: `appview_client/http.ts`.

- **L4.1** Happy path: compares offers across suppliers → `where_to_buy` card + `ranked` + `handoff`.
- **L4.2** Discovery returns nothing → an honest "No supplier lists this" note, not an error, not an empty card.
- **L4.3** Discovery **throws** → `failed: true`, note says "unavailable", no card (outage ≠ "no offers").
- **L4.4** An unpriced supplier is surfaced in `unpriced`, ranked ones in `ranked`.
- **L4.5** Currency inference: anchors on the first priced candidate's currency when the user names none; off-currency offers reported `currency_mismatch`, never converted.
- **L4.6** Requires `query` OR `identifiers`; throws when neither is given.
- **L4.7** Forwards `query` / `identifiers` / `region` / `limit` to discovery verbatim.
- **L4.8** **Money-free**: card action is `where_to_buy`; the tool never completes a purchase and exposes no buy/pay/checkout affordance.
- **L4.9** NOT terminal — returns `ranked` to the loop so it can weigh preferences (A6).
- **L4.10** `region` is passed to discovery ONLY, not re-applied as a rank filter (wire region vs offer `scheme:value` differ; AppView already enforced it).
- **L4.11** Brain-local: reaches AppView directly (the `search_peerlens` precedent); adds no `CoreClient` method; Core makes no external call.

## L5 — Comparison card, hand-off mode (`packages/core/src/commerce/comparison_card.ts`)
Tests: `__tests__/commerce/comparison_card.test.ts`.

- **L5.1** `mode:'handoff'` → `primaryAction:'where_to_buy'`, "Indicative price" / "Listing valid until" labels, `handoff` links present.
- **L5.2** `mode:'order'` (default) is **byte-identical** to before hand-off mode existed (no regression to the buyer path); `handoff` absent.
- **L5.3** `renderValidity`: a far-future sentinel (year ≥ 9000) renders "no stated expiry"; a real date passes through unchanged.
- **L5.4** No winner (every offer filtered) → "none — no offer met the requirements" + the exclusion reasons, not an error or blank card.
- **L5.5** `incomparable` is read off `ranking.missing` (recorded), not recomputed — the card cannot disagree with the ranking it explains.
- **L5.6** The card is useful on the GENERIC CardSpec fallback (every field a printable string).

## L6 — CardSpec projection (`packages/brain/src/service/comparison_card_spec.ts`)
Tests: `__tests__/service/comparison_card_spec.test.ts`. Validator: `packages/protocol/src/services/card-spec.ts`.

- **L6.1** `where_to_buy` → title "Where to buy", headline key/values, "Where to buy" section.
- **L6.2** An https `sourceUrl` → a tappable `link` block; an `at://` `serviceUri` → a named keyValue line (never a fake link).
- **L6.3** A non-https `sourceUrl` (http://, localhost) is dropped by validation; the supplier still appears via its service-URI line.
- **L6.4** The reasoning tail ("Why"/"Scored on"/"Excluded") is ordered AFTER the structured sections, so the block cap (32) never trims the where-to-buy links/alternatives.
- **L6.5** A non-`commerce_comparison` value, or a card missing `fields`, → `null`.
- **L6.6** Whole spec re-run through `validateCardSpec({trusted:false})`; a stray `badge` is stripped.
- **L6.7** Structured sections (handoff, alternatives, incomparable) come from the card's typed arrays, so a headline-label change can never drop them.

## L7 — Lift into the answer (`packages/brain/src/composition/ask_coordinator.ts`)
Tests: `__tests__/composition/commerce_card_lift.test.ts`.

- **L7.1** A successful `search_products` call → `answer.commerceCard` (a validated CardSpec).
- **L7.2** A failed call → no lift.
- **L7.3** A turn with no research → no `commerceCard`.
- **L7.4** Researched twice → the LAST card wins.
- **L7.5** The narrative (`answer.text`) survives — card is evidence beside it, never instead of it.

## L8 — Lifecycle + chat-bridge posting (`chat/thread.ts`, `composition/coordinator_ask_handler.ts`)
Tests: `__tests__/chat/thread*`, `__tests__/composition/coordinator_ask_handler.test.ts`.

- **L8.1** `commerce_comparison` lifecycle: in the union, keyed on `cardId`, and `readLifecycle` validates `cardId` + object `cardSpec`.
- **L8.2** `postCommerceCard` fires in BOTH the fast-path and the deferred branch (same card either way); no double-post (paths are mutually exclusive).
- **L8.3** A non-commerce ask posts NO card (the "no late-thread post" invariant — 128 composition tests).
- **L8.4** The empty-content lifecycle message is NOT dropped by the empty-`dina`-row skip (it dispatches by `displayType`, not content).

## L9 — Mobile render (`apps/mobile/src/components/InlineComparisonCard.tsx`, `apps/mobile/app/index.tsx`)
Tests: `apps/mobile/__tests__/components/inline_comparison_card.test.tsx`.

- **L9.1** Renders the card via `SafeCardRenderer` under `testID="chat-card-commerce-response"`.
- **L9.2** A tappable https where-to-buy link renders (`safe-card-renderer-link`).
- **L9.3** A corrupt persisted `cardSpec` → renders nothing (boundary re-validation as untrusted).
- **L9.4** A stray trust badge in the persisted card is stripped.
- **L9.5** `toDisplayType` + `chatRowKind` + the `renderMessage` branch are all wired for `commerce-comparison`.

## L10 — Money for people to read (`packages/core/src/commerce/money_display.ts`)
Tests: `packages/core/__tests__/commerce/money_display.test.ts`, `comparison_card.test.ts`, `tally_export.test.ts`.

- **L10.1** Minor units → decimal at the currency's exponent (INR 449900 → "4499.00"; JPY 48000 → "48000"); fixed decimals; 15-digit amounts stay exact (BigInt).
- **L10.2** Unknown currency → the ISO-4217 default of 2; a currency string naming an `Object.prototype` key is unknown too (the table is a `Map`); the 0- and 3-decimal ISO currencies are listed.
- **L10.5** A stated price that is not Money (`''`, `-4050`, `12.50`, `abc`, `' 42 '`, `0x10`, `1e3`, `007`, a non-code currency) never becomes an `Offer`: `catalogCandidatesToOffers` re-validates with the protocol's `validateMoney` and reports the row in `unpriced` with `malformedPrice`; `formatMoneyAmount` refuses non-Money; the research tool never throws on one bad row (`catalog_offers.test.ts`, `money_display.test.ts`, `product_tools.test.ts`).
- **L10.6** One listing per supplier (`oneListingPerSupplier`): the cheapest valid price wins, a priced listing beats an unpriced one, the count folded is told; the card refuses a DID choice a supplier holds twice.
- **L10.3** The card renders `INR 500.00`, never `INR 50000` — the recommendation, the alternatives and the Tally export share the one rule.
- **L10.4** The research tool hands the loop `price: "INR 4499.00"` and `trustPercent`, and no `total`/`currency`/`trustBp` field remains for the model to misread.

## L11 — The seller as the owner knows them (`product_tools.ts` `lookupContacts`)
Tests: `packages/brain/__tests__/reasoning/product_tools.test.ts` ("the seller as the owner knows them").

- **L11.1** A supplier DID that is a contact carries `contact: {name, trustLevel, preferredFor}` on the ranked offer; a stranger carries no `contact` key (no invented name).
- **L11.2** Unpriced listings are annotated too.
- **L11.3** A `contactLookup` answer whose `did` differs (alias / display-name match) is NOT attached.
- **L11.4** A thrown lookup is logged by DID (`search_products.contact_lookup_failed`) and the offer stays in the list unnamed. KNOWN LIMIT: both production transports answer `null` on a transport fault (their `contactLookup` contract), which the tool cannot tell from a stranger — recorded as an open question (Iter 31), not hidden.
- **L11.5** Each supplier is looked up once, by DID (a supplier listed twice is one lookup), at most four at a time.
- **L11.6** The card's "Recommended", alternatives (`seller`) and where-to-buy links (`sellerName`) carry `Name (did)`; the CardSpec mapper labels links and rows with it (`comparison_card_spec.test.ts`).
- **L11.7** Every host wires `contactLookup` on the pipeline's `coreClient` (mobile lazy proxy, brain-server, every test fake) — the type requires it.

## L12 — `recommend_offer` commits the decision to the card (`product_tools.ts`, `comparison_card.ts` `choice`)
Tests: `product_tools.test.ts` ("recommend_offer"), `comparison_card.test.ts` ("the owner's choice"), `commerce_card_lift.test.ts`.

- **L12.1** `search_products` returns a `researchId`; absent on outage and on "nobody lists it".
- **L12.2** A pick rebuilds the SAME research's card: "Recommended" = the pick (with the owner's name when known), "Chosen for" = the reason, "Set aside" lines; the passed-over ranking #1 stays an alternative; set-aside sellers leave the alternatives and the hand-off links; the chosen offer's OWN price/score, not the #1's.
- **L12.3** A pick of nothing → "Recommended: none — <reason>", offers still listed.
- **L12.4** Refusals: unknown supplier; an unpriced listing as the pick; set_aside naming a DID the research does not hold; the pick also set aside; a supplier set aside twice; more set-aside entries than suppliers; a non-array set_aside; an entry without a reason; empty reason; missing/forged/foreign/expired `research_id` (live at exactly the 15-min TTL, gone one ms past); the cache is bounded (16) — the oldest is forgotten and the newest 16 resolve.
- **L12.5** The reason is one bounded line (C0/C1 control and bidi characters stripped, cut at exactly 240), set-aside reasons included.
- **L12.9** ONE research cache per pipeline (`createResearchCache` in `buildAgenticAskPipeline`): a `research_id` minted before a Pattern A pause resolves in the registry the resume rebuilds (`product_tools.test.ts` "one cache serves every registry").
- **L12.10** The CardSpec mapper collapses "Set aside" lines into one bounded list block; 19 set-aside lines leave the price, the where-to-buy list and the incomparable section on the card (`comparison_card_spec.test.ts`).
- **L12.6** `buildComparisonCard({choice})` throws on a supplier outside the ranking — never a silent fallback to #1; without `choice` the card is byte-for-byte the old card plus seller labels.
- **L12.7** The chat bridge posts the LAST research card: a `recommend_offer` card wins over the `search_products` card; a REFUSED recommend leaves the research card standing.
- **L12.8** Both tools are registered (18 tools) and non-terminal; the tool's `note` steers the model back to answering, never to narrating the card.

## L13 — Routing (`intent_classifier.ts`, `prompts.ts` VAULT_CONTEXT / ASK_RETRIEVAL_PLAN)
Tests: `intent_classifier.test.ts`, `intent_classifier.eval.test.ts` (gated, 3 product cases), `prompts.test.ts`.

- **L13.1** `products` is a valid intent source; unknown literals still drop; `trust_network` still folds to `peerlens`; the classifier prompt separates a product across suppliers from a named store's live state (`intent_classifier.test.ts`, ungated).
- **L13.2** The ask prompt names `products` in the legend and maps it to `search_products` → `recommend_offer`; rule 3 asks PeerLens AND the offers (when offered — a forced lane removes the tool), separates a product from a named store, hands the decision to the stated preferences; "only recommend what … returned" lists `search_products`; `recommend_offer` does not count against the per-source budget (`prompts.test.ts`, ungated).
- **L13.3** The planner prompt asks for the preferences check on a purchase (finance budget, general seller notes) with a worked example that is NOT a harness question (`prompts.test.ts`).
- **L13.4** No per-scenario rule anywhere (sources and what to do with them only).
- **L13.5** When the classifier names `products` AND `provider_services`, the hint block adds the products-before-providers line; `products` alone adds neither the provider block nor the line (`ask_handler.test.ts`).
- **L13.6** Live: the intent eval on OpenRouter — four product questions → `products` + `peerlens`, two of them asserting no `provider_services` (19/19, Iter 31).
- **L13.7** The small structured calls (classifier, planner, lightweight) share `SMALL_TASK_MAX_TOKENS` (2048): a reasoning model spends output tokens thinking before the JSON, and 512 left the planner answering an empty string on the production credits model.

## L14 — A6 against the real model (`apps/home-node-lite/brain-server/__tests__/a6_preference_diligence_real_llm.test.ts`)
Gated: `DINA_RUN_REAL_LLM=1` + `DINA_BRAIN_LLM_PROVIDER` (+ key); runs the shared `buildHomeNodeAskRuntime` over an in-process Core, real SQLCipher stores, a fixture AppView; ~4 min.

- **L14.1** Reputation over price: ranker #1 = cheapest 28% seller; the answer names trust and a trusted seller's price; the card recommends a trusted seller, not the cheapest.
- **L14.2** Budget below every offer (finance vault, planner-fetched): the answer names the budget and that offers exceed it; the card recommends none.
- **L14.3** Sworn-off seller known only by contact name; ranker #1 = that seller: the answer names ChairMaker and the exclusion; the card does not recommend ChairMaker.
- **L14.4** `preferred_for` contact, not ranker #1: the answer names Don Alonso; the card recommends Don Alonso.
- **L14.5** Every scenario: `searchCatalog` was hit; the evidence block (tools by turn, planner fetches, AppView methods, card line, answer) is printed; supplier DIDs are opaque; no owner PII anywhere (fixture data).
- **L14.6** The skip path: without the gate the suite reports one skipped-marker test and the rest skip; the default provider is OpenRouter; a named provider without its key fails loudly (the server's own `loadLLMConfig`).
- **L14.7** The personas are published to Brain as the server does at boot (`setAccessiblePersonas`), so the loop's own vault tools see every vault.
- **L14.8** S1 is decisive: the cheapest seller is 72%-trusted (a pick a model would make on its own), the primary needle is tied to the owner's statement, and the test asserts the owner's vault was read (planner fetch from the persona, or a `vault_search` turn).
- **L14.9** The card check accepts the owner's "none — <reason>" and rejects the ranker's own "none — no offer met the requirements".
- **L14.10** An empty final turn (a reasoning model that only thought) is nudged once by the loop (`agentic_loop.test.ts`), so the owner is not handed silence beside the ranker's card.

## L15 — §5.D: the rail data model and the three hooks (Iters 32–38)
Tests: `packages/core/__tests__/pii/checksums.test.ts`, `commerce/{trade_identity,commerce_settings,country_rails}.test.ts`, `contacts/directory.test.ts`, `server/routes/{contacts,commerce_business_settings}.test.ts`, `client/core_client_contact_body.test.ts`, `apps/home-node-lite/brain-server/__tests__/contacts_routes.test.ts`, `apps/mobile/__tests__/screens/{business_identity,contact_trade_details}.render.test.tsx`, `screens/trade_rail_check.test.ts`.

- **L15.1** GSTIN: the published example validates; a wrong check character, a transposition, a bad state code, a non-existent PAN holder type and ten malformed shapes are refused.
- **L15.2** Registrations: closed scheme set, per-scheme rule, normalise-then-validate, bounded count, duplicates refused, the VALUE never echoed in a finding.
- **L15.3** Business settings: a third kind `business`, stored NORMALISED, "absent" ≠ "invalid", owner-only, credential-shaped keys refused, and a stored row that is not an object refuses rather than throwing out of the read.
- **L15.4** Contact paper identity: migration v44 is append-only; a refusal writes NOTHING; tri-state per field; survives a re-add; a pre-v44 or hand-edited row reads as "not stated".
- **L15.5** Channels: stored in the people graph, canonicalised, replacing removes the old binding, a value another live person holds is refused (with no PII in the finding), the RAW input is judged so free text cannot become a number, and a refusal on one channel writes neither.
- **L15.6** Both stores are judged before either is written: the route and the phone commit only when `checkPaperIdentity` and `checkContactChannels` both pass.
- **L15.7** The capture paths exist on the product: **Business identity** (Settings) for the node's own, **Trade details** (long-press a contact) for the counterparty's; findings render beside their field, an unplaced finding lands in the error slot, and a refused save keeps the owner on their typing.
- **L15.8** The web half goes through Core: `GET /api/v1/contacts/lookup` + `PUT /api/v1/contacts/:did`, findings passed through (not a 502), a failed read throws rather than showing a blank form, and the channels it cannot read are not sent.
- **L15.9** Filing hook: India `eway-bill` (both GSTINs + the dispatch priced by the khata's own rule) and USA `invoice-terms` (the order's net days, refused outside the pack's enum); every missing fact is a named reason with nothing staged; one task per note; it cards; a thrown fault is caught and named by type.
- **L15.10** Reminder hook: owner-initiated only; the amount is derived, never supplied, and bounded by what the fold still says is outstanding (`nothing_outstanding` when settled); the channel comes from the contact; per-due-per-day idempotency; every refusal has words the owner can act on.

## X — Cross-cutting invariants
- **X1** Money-free end to end: no buy/pay/checkout/collect anywhere in the loop; the only action is `where_to_buy` (Cart Handover — Dina credits the source, the human buys there).
- **X2** Absent trust is never zero (§13.4) — consistent across L2, L3, L5.
- **X3** Boundary re-validation as UNTRUSTED at every trust boundary (the lift's `buildComparisonCardSpec` and the mobile render).
- **X4** Brain-local orchestration: Core has no new method and makes no external call for research.
- **X5** No per-scenario prompt rules. Routing is NOT left to the tool description: the ask prompt's source legend gates the loop (Iter 30 found it routed every purchase question to PeerLens), so `products` is a named intent source and the prompt maps it to `search_products` + `recommend_offer`. The weighing itself stays the model's.
- **X6** Spec §5.A coverage: A1 (product-search tool), A2 (consumer caller/loop), A3 (trust producer), A4 (screen/surface), A5 (recommend + hand-off), A6 (preference weighing) are each satisfied or explicitly, honestly deferred with a recorded reason.
- **X7** A1 routing is VERIFIED end to end: `coordinator_ask_handler.test.ts` scripts a loop turn that calls `search_products` and asserts the money-free card lands on the thread via the bridge (fast-path and deferred). So A1 is not left to "a real-model test that doesn't exist" — it is covered by an integration test.
- **X8** A6 preference weighing is EMERGENT (no per-scenario prompt rule) and CONFIRMED against the real model (Iter 30, `apps/home-node-lite/brain-server/__tests__/a6_preference_diligence_real_llm.test.ts`, gated on `DINA_RUN_REAL_LLM=1`): four scenarios where the ranker's #1 conflicts with a stated preference, 4 of 4, the card agreeing with the prose. The machinery the model needs is unit-covered: readable prices (`money_display`), the owner's contact record on each offer (`contactLookup` bridge), and `recommend_offer` committing the decision to the card (`buildComparisonCard({choice})`).
- **X9** A3 has a KNOWN gap recorded, not hidden: seller trust is wired and tested; product-review evidence (`subject_scores` → the card's `evidence` param) is NOT fetched yet, so the Evidence line reads "none recorded" — deferred, and noted at `trust_producer.ts` and in the notes.
