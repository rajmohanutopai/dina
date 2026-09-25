# Jiffy merchant integration — Test Plan

**Scope:** `docs/JIFFY_MERCHANT_INTEGRATION_PLAN.md` as built: Piece A1 (catalogue binding), Piece B (integration scopes, status, orders export, refresh, settings proposals), Piece C (order attachments), the phone cards on both surfaces.
**Method:** contract tests by rule, one per behaviour the plan names in §5, then adversarial review by workflow. Every scenario names the layer it runs at and the test that pins it. Test files live under `packages/core/__tests__` unless stated.

Layers: **protocol** (`@dina/commerce-protocol`), **module** (pure commerce modules), **store** (SQLite + in-memory, same suite), **route** (`CoreRouter` + `registerCommerceRoutes`, in-process callers), **authz** (signed-caller matrix), **ingress** (`applyInboundTradeDocument`), **phone** (`apps/mobile/__tests__`).

---

## 1. Who calls (plan §3.2, §5 rows 1–3)

| # | Scenario | Expected | Test |
|---|---|---|---|
| W1 | Owner reaches every integration door | admitted | `server/routes/commerce_integration.test.ts` "the owner reaches both doors" |
| W2 | Staff device with a live grant for THAT scope on `supplier`/`both` | admitted; another scope's grant, a `buyer`-only grant, a revoked grant → 403 `access_denied` | `commerce/integration.test.ts` admission; route test "a staff device reaches a door only on a live grant…" |
| W3 | Brain, admin, plain device, agent, plugin, connector, service | never authorized on any of the nine doors (matrix) | `auth/authz_matrix.test.ts` "Merchant integration rows" |
| W4 | Wrong verb, tail, sibling path | inherits nothing | same, "the doors are exact" |
| W5 | A SIGNED staff device | authenticates as `staff` on all nine doors; still refused on an owner-only route | `auth/staff_caller.test.ts` |
| W6 | Refusal body for a device | names the reason, discloses nothing else | route test "the refusal for a device names the reason…" |
| W7 | Migration v46 | grants table rebuilt: old rows survive, integration scopes insert, unknown scope refused by CHECK | `commerce/integration.test.ts` "migration v46" |
| W8 | The owner on the attach door | 403 `integration_device_required` (a connector's document) | `server/routes/commerce_integration_attachments.test.ts` "the owner is refused on this one door…" |

## 2. Status (B1)

| # | Scenario | Expected | Test |
|---|---|---|---|
| S1 | Device reads status | its own live integration grants (with `installs`), pointers, settings revision digests; no settings contents | `commerce/integration.test.ts` "status" |
| S2 | Owner reads status | every device's live integration grants; revoked ones gone | same |
| S3 | Bound-but-unpublished catalogue | listed as `unpublished`, `bound: true`, nulls | same + route test "the catalogues door" |
| S4 | Settings revision | sha256 of canonical JSON; null when absent | "settingsRevision" |

## 3. Orders export (B2, §5 rows 5–6)

| # | Scenario | Expected | Test |
|---|---|---|---|
| E1 | Reserved, decided, unreadable-ack rows | decided only, oldest first, ties by digest; unreadable counted and advances the cursor | `commerce/integration.test.ts` "orders export (sqlite/memory)" |
| E2 | Paging | total order `(decided_at, order_digest)`; same cursor → same page; pages chain without gap or repeat | "pages are a total order" |
| E3 | Accepted event | retained order (totals, lines priced from the bound quote, delivery projection); rejection carries `order: null` | "an accepted event carries the RETAINED order" |
| E4 | Counterproposal | `rejected` with reason `counterproposal`, no quote content | same |
| E5 | Receipts re-validated | an order or quote whose bytes moved reads as no order | via `rehydrate*` — pinned by `commerce/boundary.test.ts` (no casts, no raw parse) |
| E6 | Wire shape | snake_case events, `next_cursor`, `unreadable`; retained-order case | route test "pages decided orders in snake_case…", "an accepted event carries the retained order in snake_case" |
| E7 | Malformed cursor / limit | 400 before touching the store; limit bounded | "refuses a malformed cursor or limit" |
| E8 | Fixtures | acknowledgements are digest-valid (`makeAcknowledgement`), never hand-built | helpers |

## 4. Catalogue binding and refresh (A1, A2, §5 rows 4, 7)

| # | Scenario | Expected | Test |
|---|---|---|---|
| R1 | Owner binds via `from_connector` (rest/spreadsheet_url) | binding row; upload writes none | `server/routes/commerce_integration_refresh.test.ts` "binding" |
| R2 | Upload of a bound catalogue | binding deleted; refresh 404 again | "an upload of a bound catalog supersedes its source" |
| R3 | Refresh with binding | pulls the BOUND source; body `kind`/`credential_resource`/`operation` ignored; draft `prepared`, `source_parsed`; nothing published | "pulls the bound source again…" |
| R4 | Replay same command | same draft, no pull; `draft_id` + `source_digest` in body; after the owner deleted the draft → `draft: null` | "the same command replays…", "a replay names the draft it minted…" |
| R5 | Same command, other catalogue or precondition | 409 `command_conflict` | same |
| R6 | Failed pull / rows that make no item | 409; no draft left, no command recorded; the same command retries | "a failed refresh leaves nothing behind" |
| R7 | `source_digest` precondition | mismatch → 409 with the digest; malformed → 400 | "an expected source digest is checked…" |
| R8 | Scope / install | no scope or buyer-only → 403; owner may refresh | "a device without the scope…" |
| R9 | Publication | approve/publish routes 403 for staff | "the catalogues read names the binding…" |
| R10 | Stores | binding round-trip, list, delete; refresh-command first-writer-wins, null precondition | `commerce/catalog_source_bindings.test.ts` |
| R11 | Migration v47/v48 tables | created by `IDENTITY_MIGRATIONS`; CHECKs hold | same (sqlite backend) |

## 5. Settings proposals (B3, §5 rows 8–10)

| # | Scenario | Expected | Test |
|---|---|---|---|
| P1 | Allowlist | unsupported control → `unsupported_control` naming it | `commerce/integration_settings.test.ts` "what may be proposed" |
| P2 | Stale revision / invalid merge / absent base | `revision_conflict` (with current) / `invalid_settings` (findings) / `settings_absent` | same |
| P3 | Mistyped boolean, null, invalid region | `invalid_settings` naming the field; no card | "a mistyped boolean or an invalid region is refused…" |
| P4 | Proposal | pending_approval card, id from command, idempotency key, content digest; same command → pending; different content → `command_conflict` | "the card and the owner's decision" |
| P5 | Approve | merge re-validated against the record NOW, written through `writeSupplier`, completed with the applied revision (from the bytes written) | same |
| P6 | Deny / lapse | nothing written | same |
| P7 | Revision moved before approve | card fails `revision_conflict` | same |
| P8 | Queued / running | reads as `pending` | "a card mid-apply…" |
| P9 | Listing under load | 60 unrelated approvals; the proposal still lists | "a node busy with other approvals…" |
| P10 | Brain | cannot create (400 `reserved_payload_type`), approve or cancel (403); owner approves | "the workflow routes fence the card" |
| P11 | `/v1/service/respond` against a Core-minted card | 403 `owner_decision_required` BEFORE any claim; card stays pending | same |
| P12 | Hooks | `composeWorkflowHooks`: first non-passthrough gate wins, all handlers run, throws isolated | "composition with the coordination hooks" |
| P13 | Doors | GET names revision, controls, proposals (applied revision read toward null); POST 202/200/409/400 | route test "the settings doors" |

## 6. Order attachments (Piece C, §5 rows 11–13)

| # | Scenario | Expected | Test |
|---|---|---|---|
| A1 | Shape per kind | reads typed; vocabularies pinned; source must be an integration device + token; https-only URL with host and no credentials; positive amount; decimal version; known method | `packages/commerce-protocol/__tests__/order_attachment.test.ts` |
| A2 | Digest | sixth trade domain, frozen value; tamper fails; unknown digested field tolerated | same |
| A3 | Binding | id, digest, parties, §9.13 version; checkout amount equals accepted total to the paisa; evidence amounts free | same |
| A4 | Store | first-writer on digest AND command id; buyer rows carry no command id; per-order order | `commerce/order_attachments.test.ts` "the attachment store" |
| A5 | Author | binds to the accepted order (receipt + decided ref + accepted ack), attribution from the CALLER (body `source` ignored), outbound row with command id; order state untouched | "binds to the accepted order…" |
| A6 | Idempotency | same command → replayed; different content → `command_conflict`; new command → new document | same |
| A7 | Refusals | unknown/foreign order 404; reserved or rejected 409 `order_not_accepted`; price change 409 `amount_mismatch`; http URL / bad provider / bad payload 400 | "refuses an unknown or foreign order…" |
| A8 | `evidence_refs` | captured payments + started production, oldest first; nothing else | "the next status carries…"; wiring: `server/routes/commerce_effect.test.ts` "a status the sweep signs carries…" |
| A9 | Buyer verify | sender = supplier, self = buyer, order held, digest/parties/version bound, accepted; retained inbound with envelope; duplicate; stranger `not_ours`; re-priced checkout refused | "verifies the sender is the order's supplier…" |
| A10 | Cards | checkout → one card with link, amount, expiry (task expiry = link expiry); authorized / fulfilment → none; captured → once per `provider_ref` across versions; none once the khata holds that ref | "the owner's two questions" |
| A11 | Decision | yes → buyer's `PaymentNote` (buyer key, method, external_ref, order_refs) pushed via the dispatcher, card completed with the digest; no → nothing; money closed → card failed; checkout yes → `{opened: true}` | "a yes to record this as paid…" |
| A12 | Doors | owner 403; no/other grant 403; 201 + ONE `commerce.trade` push with kind `order_attachment`; replay 200 pushes nothing; GET lists; 400/404/409; money closed 503 | `server/routes/commerce_integration_attachments.test.ts` |
| A13 | Ingress | the pushed body applies on the buyer (card raised), duplicates, stranger refused; Brain fenced on the new types | same, "the buyer node receives what left" |
| A14 | Ledgers | money-line manifest includes `order_attachments.ts` + `trade_dispatch.ts`; in-memory double ledgered; card payload parse allow-listed | `commerce/money_boundary.test.ts`, `commerce/boundary.test.ts` |

## 7. Phone (both surfaces)

| # | Scenario | Expected | Test |
|---|---|---|---|
| M1 | Classifier | `integration_settings_proposal` → controls as lines, proposer as requester; attachment cards → supplier as requester, order + amount lines, https link carried | `apps/mobile/__tests__/hooks/useServiceInbox.test.ts` |
| M2 | Deny | proposal and both attachment cards are plain cancels (no `service.respond`) | same |
| M3 | Owner surface | checkout: "Open the payment link?", link button opens https URL, Dismiss/Done; payment: "Record this payment?", Deny/Record as paid; non-https link never offered | `components/approval_inbox_attachments.test.tsx` |
| M4 | Web surface | cards say where to decide, no Approve/Deny; the link still opens | `components/approval_inbox_web_surface.test.tsx` |

## 8. Live bed (Phase 4) — run 2026-09-23

Supplier = chairmaker (the bed's seller with published catalogue and decided orders), buyer = sancho. Stand-in: `dina-nodes/commerce/jiffy_connector.ts` (staff device, signed requests).

| # | Scenario | Result |
|---|---|---|
| L1 | Pair the stand-in as staff; owner proves presence and grants the five scopes (first grant sets the §6.4 PIN) | ✅ status lists five grants, the published catalogue (`bound: false`) and the settings digest; unpaired/ungranted calls 403 |
| L2 | Refresh through a bound source | ⚠️ door + binding tested by the route suites; a live pull needs an https public host (the feed policy refuses loopback/private), so no local stand-in endpoint could be bound |
| L3 | Propose `acceptColdInvites: true` against the read revision | ✅ 202 with the card id; the card on chairmaker; owner-console approve → `completed`, `applied_revision` on the settings door |
| L4a | Attach to an order the buyer never retained | ✅ supplier accepts (its record), buyer REFUSES (its record); audit row now carries the reason |
| L4b | Attach a checkout link and a captured payment to an order sancho holds | ✅ both retained inbound with attribution; two cards; owner-console approve → `PaymentNote` under sancho's key, pushed; chairmaker's trade inbox shows `unacknowledged_payment`; the checkout card completes `{opened: true}` |
| L4c | The web inbox (rebuilt bundle) | ✅ "Open the payment link?" with the live link button and the owner-console note; "Record this payment?" with the ref line and the note |
| L5 | Export | ✅ seven decided orders, retained order bodies, stable `(decided_at, order_digest)` cursor; the connector's replay is the same page |

## 9. Adversarial round — run 2026-09-23

Eight lenses (authz, idempotency, boundaries, privacy, protocol, data, card lifecycle, tests), two refuters per finding: 29 raised, 17 stood (nine distinct), 12 refuted twice. Each fix carries a pinned scenario:

| # | Scenario | Expected | Test |
|---|---|---|---|
| R1 | Brain POSTs `/v1/workflow/tasks/:id/fail` on a Core-minted card | 403; the card stays `pending_approval` | `integration_settings.test.ts` fence; `commerce_integration_attachments.test.ts` both cards |
| R2 | Staff GET attachments for an order this node BOUGHT (dual-role node) | 404 `unknown_order`; the owner reads it | attachments route test "a staff device reads only the orders this node SUPPLIES" |
| R3 | Two checkout links on one order | one pending card (the newest); the earlier cancelled `superseded` | `order_attachments.test.ts` "a newer checkout link supersedes…" |
| R4 | A checkout link that lands after its `expires_at` | retained; no card (`expired`) | same |
| R5 | Refund (higher version) after a captured card; a lower-numbered capture arriving late; a zero capture | card cancelled `superseded_by_processor`; `superseded`; `not_a_card` | "only the NEWEST revision…" |
| R6 | Yes on a payment card whose ref the khata already holds / whose newest evidence is refunded or re-priced | completes `already_recorded`, nothing authored / fails `evidence_superseded` | "a yes to record this as paid…" |
| R7 | The push reports failure | note retained; card completes `dispatched: false` | same |
| R8 | Card failed (money line closed at the yes), then the same payment re-reported; a card the owner denied | re-asked under `<id>-r<digest8>`; `already_decided` | same |
| R9 | Attachment arrives before the acceptance | `applied` + `awaiting_acceptance`, no card; the retained acceptance raises it through `acceptance_seam.ts`; the sweep asks nothing twice | "an attachment that lands before the acceptance…" |
| R10 | Two overlapping refreshes, one command id | one pull, identical answers, one draft; later call replays | `commerce_integration_refresh.test.ts` "two overlapping refreshes…" |
| R11 | URL port > 65535, control/bidi character; zero-amount capture; `Infinity` in a tolerated field | refused by the validator with a reason (never a throw) | `order_attachment.test.ts` |

## 10. The Jiffy agent's eleven items — built 2026-09-25

| # | Scenario | Expected | Test |
|---|---|---|---|
| J1 | Accepted order exported | each line carries `product` as signed on the order; `name` once a live published item matches, absent otherwise | `commerce/integration.test.ts` "an accepted event carries the RETAINED order"; route test "an accepted event carries the retained order in snake_case…" |
| J2 | Owner mints a staff code | 201 `dina1:` code naming the device; the pending code is role `staff`, no scope; 403 without the owner capability; 400 for an empty, over-64, control-character or non-string name | core-server `owner_setup.test.ts` "mints a named staff setup code…" |
| J3 | Owner lists and revokes staff devices | status lists `staff_devices`; revoke is staff-only (404 for a coding agent), 503 when not durable, 204 when durable | core-server `owner_setup.test.ts` "lists staff devices and revokes only a staff device…" |
| J4 | A staff device names itself at completion | the owner's name stands; other roles keep the label override | `server/routes/pair.test.ts` "a staff code keeps the owner's name…" |
| J5 | A named device proposes settings | card description and payload name it (`proposed_by_name`), the listing carries it, the phone card reads "proposed by <name> (did…)" | route test "the card and the listing name the proposing device…"; phone `useServiceInbox.test.ts`, `approval_inbox_web_surface.test.tsx` |
| J6 | `expected_revision: null` | 409 `supplier_settings_absent` before settings exist; 409 `revision_conflict` with the live revision after | route test "a null revision answers supplier_settings_absent…" |
| J7 | Reference runner prices a quote | all lines or none; declines `not_in_catalog`, `no_published_price`, `unit_mismatch`, `below_minimum_order`; Core signs the quote | `commerce/supplier_runner.test.ts` |
| J8 | Reference runner on the real workflow routes | idle with no task; ignores an operator's runner device; claims and completes for the Core-minted device; a Core-signed acknowledgement results | same, "the loop through the real workflow routes" |
| J9 | Supplier pack consent | begin names the listing; bind the runner before confirm; confirm writes the self listing (unlisted when none, merged into a known_only one); a public self listing is refused, then confirms once moved; `bind_listing` re-binds; owner-only | `server/routes/commerce_install_reference.test.ts` |
| J10 | Server buyer orders from a held quote | quotes listed with `expired`; `from_quote` needs presence, builds and verifies the order, holds the approval; `orders/submit` sends it; unknown 404, lapsed 409 `quote_expired`, no buyer pack refused | `server/routes/commerce_order_from_quote.test.ts` |
| J11 | Trade document from a non-contact | admitted for an order-bound kind when the sender is the buyer of an order this node ACCEPTED or the supplier of an order it placed; a refused proposal's receipt admits nobody; revenue-share kinds stay contacts-only; a sender who is neither is dropped before any verifier | `commerce/trade_counterparty.test.ts`; `commerce/trade_transport.test.ts` "the supplier of an order this node holds is admitted…", "a stranger's push drops…" |
| J15 | Two buyers share a purchase order id | the runner answers each buyer's own status; a third party learns nothing | `commerce/supplier_runner.test.ts` status case |
| J12 | Row categories | a connector/CSV row naming a configured id narrows to it; other text rides as `attributes.section` (clipped to 200); an unconfigured id is never promoted; a model-read row carries the settings unchanged | `commerce/catalog_assembler.test.ts` "a non-model row narrows…", "the draft class decides…" |
| J13 | First boot in security mode | with `DINA_UNLOCK_PASSPHRASE` only `wrapped_seed.bin` (0600) is written, no keyfile and no phrase file; `recoveryPhraseFromWrapped` gives the phrase back with the passphrase; the presence path exists from boot one; later boots unwrap the same seed, answer `wrapped` without the variable and refuse a wrong one; without the variable the keyfile path is unchanged | core-server `master_seed.test.ts` "security mode from the first boot" |
| J14 | Owner-bound pull and MsgBox | recorded as the one exception in `dina_details.md` and plan §3.1 | documentation |

Suites after this round and its review fixes: core 514 suites / 9682 tests, core-server 134 / 2851, phone 241 / 3470; workspace typecheck clean. Owed: a live server-to-server order on the bed (tender → `from_quote` → submit, the reference runner accepting, the Jiffy stand-in attaching).

### 10.1 Live bed — run 2026-09-25 (four nodes restarted on this code)

| # | Step | Result |
|---|---|---|
| JL1 | Retire alonso's supplier pack; begin → `bind_reference_runner` → confirm (naming the minted device) | ✅ consent names the self listing (unlisted, five capabilities); confirm answers `listing: { ok, rkey: self, discoverability: unlisted }` |
| JL2 | sancho tenders 3 × `ALON-PLANK-2` to alonso | ✅ the reference runner claimed and completed in 0.5 s; sancho holds a Core-signed quote, ₹4,500 × 3 = ₹13,500; the list flags an old chairmaker quote `expired` |
| JL3 | `from_quote` on sancho | ✅ refused `no_user_presence` until the passphrase proved presence; then order `po_e923…` held as an approval |
| JL4 | `orders/submit` | ✅ the runner accepted in 0.4 s with `SO-B437780E73`; the acceptance reached sancho |
| JL5 | alonso's export | ✅ the line carries `product` and `name: "Teak plank 8ft"` |
| JL6 | Owner mints a staff code on alonso; the stand-in completes it sending `device_name: "Owner"` | ✅ stored as "Jiffy till connector"; listed in `staff_devices` |
| JL7 | Grants (first carries the PIN), status | ✅ five scopes; status names the supplier settings revision |
| JL8 | Proposal with `expected_revision: null`; a real proposal | ✅ `409 revision_conflict` with the live revision; `202`, card "…proposed by "Jiffy till connector"?", listing `proposed_by_name`; test card cancelled |
| JL9 | Checkout link attached to the accepted order | ✅ alonso sent it (`d2d_send commerce.trade delivered=true`), sancho applied it and raised "Pay INR 13500.00 for order po_e923… through clover?" |

Not driven live: counterparty admission between non-contacts (alonso and sancho are contacts; pinned by `trade_counterparty.test.ts`), a row-category refresh (the feed policy refuses a local source), and a first boot in security mode (needs a fresh node; pinned by `master_seed.test.ts`).
