# Jiffy merchant integration — development plan

Status: **BUILT, Phases 1–4, held uncommitted** (2026-09-23; designed the same
day at `da0c067d`). What was built, where it departs from this text and what a
live bed run showed is in `implementation-notes.html` → "Jiffy merchant
integration"; the scenario matrix is `JIFFY_MERCHANT_INTEGRATION_TEST_PLAN.md`.
Departures worth knowing before reading on: the attach door takes a flat body
(`POST /v1/commerce/integration/orders/attachments`), the export cursor is
`(decided_at, order_digest)`, rejections export (§6 Q1 answered yes; a
counterproposal surfaces as `rejected/counterproposal` with no terms), and the
`OrderAttachment` digest is the sixth `dina:commerce:trade:v1:` domain rather
than a §9.12 domain, since that set is closed.

Inputs: the Jiffy integration notes of 23 September ("Dina changes needed for
the Jiffy merchant integration") and the six-row gap table from the Jiffy
integration agent. Both were checked line by line against the code; every
finding in them is accurate. This plan answers them with three pieces of work
rather than the seven proposed endpoints, because three of the six gaps are
already half-answered by contracts Dina has and the notes did not find.

Companion documents: `COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md` (§3.4,
§6.5, §6.6, §8.3, §9.11, §12.1, §15.5, §16.2, §18.3),
`TRADE_FIRST_STRATEGY.md` (§6 staff grants, §7 order inbox),
`RESEARCHER_KERNEL_ARCHITECTURE.md` (§5.D rails).

---

## 1. Division of labour, restated

Jiffy owns its application, enterprise permissions and the Clover
integration. Dina owns catalogue publication, discovery, quotes, negotiation
and approved orders. Dina also owns every owner decision: what is published,
what terms apply, which order is accepted. Jiffy authenticates its users; that
never proves a Dina owner is present.

Laws this plan must keep, each with the place it is enforced today:

| Law | Where it lives |
|---|---|
| The owner's reusable capability never leaves the owner's surfaces | `makeOwnerGuard` on every commerce owner route; the capability is scoped by path in the lite binder |
| Publication and settings are the owner's commercial acts | `registerCatalogRoutes` (owner-only), `PUT /v1/commerce/settings/{buyer,supplier,business}` (owner-only); a draft's `approve` requires owner presence on every provenance class |
| Staff can never publish a catalogue, edit grants, or reach routes outside their matrix | `TRADE_FIRST_STRATEGY §6.6`, `caller_type.ts` (`staff` is its own caller class, fail-closed) |
| Core never holds a credential in a record; connectors read and decide nothing | `connectors.ts`, `credential_broker.ts`, `connector_executors.ts` (credential never crosses an origin, never in a URL) |
| An external system's word is evidence, never a signed act | `country_rails.ts`: a rail's answer lands on a task correlated to the note's digest; nothing writes a `PaymentAcknowledgement` |
| Idempotency is proven by the external system, never declared by Dina | `idempotency_evidence.ts` (§15.5) |
| External callers reach a node only over signed requests, tunnelled through MsgBox when the node is not on the public internet | `relay/rpc_handler.ts` (unseal → identity binding → inner Ed25519 verify) |
| Dina advises on purchases and never touches money | README "Cart Handover" |

---

## 2. The six gaps against what exists

| # | Gap (Jiffy's words) | Finding verified | Existing seam | Left to build |
|---|---|---|---|---|
| 1 | Limited merchant permissions | Yes | `staff` device role: paired device, own caller type, owner-created value-capped install-scoped grants, revoked with the device (`staff_grants.ts`, `POST /v1/commerce/staff-grants`) | A scope family for an integration; a status read |
| 2 | Catalogue submission and publication status | Yes | Pull connector: `POST /v1/commerce/catalog/drafts/from_connector` with `kind: 'rest'`, credential by broker resource, fetch under §10.3 policy, one shared `importCatalogRows`, draft `created → confirmed → prepared → approved → published`; `GET /v1/commerce/catalog/drafts`, `GET /v1/commerce/catalog/published`; `POST /v1/commerce/connector/change` classifies widening as re-consent | A connector-triggered refresh of an owner-bound source; read access to draft and publication state for the integration |
| 3 | Policy updates | Yes | Owner-only settings routes | A proposal that lands as an owner approval card; a settings revision digest; expected-revision conflicts |
| 4 | Accepted-order hand-off | Yes | Durable order-reference store keyed `(buyer_did, purchase_order_id)` with `order_digest`, `quote_digest`, state and acknowledgement (§15.5); `GET /v1/commerce/inbox` (owner) lists reserved orders | A cursored export of decided orders for the integration scope, with stable event ids |
| 5 | Checkout-link hand-off | Yes | Nothing | A new order attachment document, supplier to buyer |
| 6 | External payment and fulfilment evidence | Yes | `PaymentNote` (buyer act) and `PaymentAcknowledgement` (supplier act) in `trade_documents.ts`; the rail observation pattern in `country_rails.ts`; `CommerceOrderStatus.evidence_refs` already on the wire | Connector-authored evidence retained on the supplier and projected to the buyer, never as a buyer or supplier act |

Two names to avoid. `connector` is already an authz role: the server-split
service key that may only `POST /v1/staging/ingest`. `publication_candidate`
is a `read` host operation by design. Neither should be widened.

---

## 3. The three pieces

```
Piece A  Catalogue through the pull connector        Jiffy hosts; Dina pulls; owner approves
Piece B  Integration scopes on the staff machinery   status, orders export, catalogue refresh, settings proposal
Piece C  Order attachments                            checkout hand-off and payment evidence, supplier → buyer
```

Gap 1 → B. Gap 2 → A + B. Gap 3 → B. Gap 4 → B. Gap 5 → C. Gap 6 → C.

### 3.1 Piece A — catalogue through the pull connector

Direction stays as designed: Dina pulls, Jiffy hosts. Pushing candidates into
Dina would need a new write authority on the publication path, which §6.6 of
the trade doc forbids staff and which no existing caller class holds. Pulling
needs no new authority: the owner binds a source once, and every later pull
runs under that consent.

**What Jiffy hosts.** One HTTPS endpoint per merchant returning JSON rows in
the catalogue vocabulary Dina already accepts (`KNOWN_COLUMNS` in
`catalog_import.ts`):

```
sku, mpn, scheme, identifier, name, description, category, brand,
unit_code, pack_size, min_order_quantity, lead_time_days, variant_of,
list_price_minor_units, currency
```

Rows are Clover-derived and allowlisted on Jiffy's side. Unknown columns are
reported as findings against the shape, at row 1, and refuse nothing else.

**Categories.** The owner's settings own category ids (`catalogCategoryIds`);
a row never invents one. A row whose `category` is exactly one of those ids
narrows that item's `category_ids` to it. Any other text, such as Clover's
"Cakes & Pastries", rides on the item as `attributes.section` (clipped to 200
characters), a label that governs nothing, and the item carries every
configured id. This applies to connector and CSV rows only; a model reading a
photograph never picks a category.
The endpoint carries a source digest header so Dina's draft can record which
bytes it read. Authentication is a bearer token per merchant, held in Dina's
credential broker as a resource the owner created; the token never appears in
a URL and never crosses an origin.

**Transport exception.** The pull is an outbound HTTPS request from the
owner's node to the endpoint the owner bound, not a D2D or agent message, so
it does not travel through MsgBox. `dina_details.md` records this exception:
an outbound pull from an owner-bound source.

**What the owner does once, on their own surface.** Store the credential
(`PUT /v1/commerce/credentials/:resource`), bind the source
(`from_connector` with `kind: 'rest'`, `credential_resource`, `operation:
'read_catalog'`, `catalog_id`, `default_scheme`), review the draft, approve
with presence, publish. A change of endpoint or credential later goes through
`connector/change`; a widening is re-consent.

**What Dina adds (small).**

- A1. `POST /v1/commerce/integration/catalog/refresh` — the integration asks
  Dina to pull the already-bound source again. Admitted by scope
  `integration_catalog_refresh` (Piece B). The route re-runs
  `loadCatalogThroughConnector` with the STORED binding: no body field may
  name a source, a credential or an operation. Provenance class is
  `source_parsed`, so `confirm` mints no receipt and the draft stops at
  `prepared`, waiting for the owner's `approve`. The response is the draft id,
  the source digest and the findings, with `state: 'prepared'` or a refusal.
  Same command id and same source digest → the same draft. Same command id
  and a different digest → `409 command_conflict`.
- A2. Read access for the integration scope to `GET /v1/commerce/catalog/drafts`
  (by `catalog_id`) and `GET /v1/commerce/catalog/published`, projected
  through a NEW read-only shape (`describeCatalogForIntegration`) that carries
  `catalog_id`, `state`, `snapshot_sequence`, `snapshot_digest`,
  `published_at`, and for drafts `draft_id`, `state`, `source_digest`,
  `findings_count`. Nothing about buyers, prices under negotiation, or other
  catalogues.
- A3. A daily reminder item in the owner's commerce inbox when a refreshed
  draft has waited more than a day for approval, beside the existing
  `catalog_stale` item.

Jiffy's "saved in Jiffy / awaiting approval / applied in Dina" maps to: the
endpoint updated (Jiffy's state); `refresh` returned `prepared` (awaiting the
owner); `published` shows the new `snapshot_sequence` (applied).

### 3.2 Piece B — integration scopes on the staff machinery

**Identity.** Jiffy pairs ONE device per merchant node with role `staff`.
The owner mints the code with `POST /v1/owner/setup/staff {device_name}`
(owner capability header; the owner console's "Staff devices" section is the
button), which answers `201 { setup_code: 'dina1:…', device_name, expires_at }`.
Jiffy completes it with `POST /v1/pair/complete` and its own Ed25519 key. The
name is 1 to 64 printable characters and is the owner's: a staff code ignores
a `device_name` sent at completion, because every card the device raises
names it ("Jiffy till connector"). `GET /v1/owner/setup/status` lists
`staff_devices`; `DELETE /v1/owner/setup/staff/:device_id` revokes one, and a
revoked device loses every grant and its PIN in one cascade. The admin-only
`/v1/pair/initiate` still works; it is no longer the owner's path. Transport
is the MsgBox RPC tunnel the dina-agent CLI already uses: sealed box,
identity binding, inner signature, then the normal router.

Why `staff` and not a new role: the staff class already has its own caller
type mapped in the signed pipeline, its own rows in the authz matrix, the
attribution boundary of `TRADE_FIRST §6.4`, a grant store with install scope
and caps, owner-only grant creation and device-wide revocation. A new role
would copy all of that to change one word. The consent card names the device,
so the owner reads "Jiffy integration may…", which is the disclosure that
matters.

**Scopes.** Four new members of `STAFF_SCOPES`, install scope `supplier`,
uncapped (no order total is at stake; money control stays at the owner's
`decide`):

| Scope | Admits |
|---|---|
| `integration_status` | `GET /v1/commerce/integration/status` |
| `integration_orders_export` | `GET /v1/commerce/integration/orders` |
| `integration_catalog_refresh` | `POST /v1/commerce/integration/catalog/refresh`, the two catalogue reads of A2 |
| `integration_settings_propose` | `POST /v1/commerce/integration/settings/proposal`, `GET /v1/commerce/integration/settings` |

Piece C adds a fifth, `integration_trade_evidence`.

Each route is exact and method-bound in `authz.ts` with `allowed:
{'owner','staff'}`, and re-checks the live grant in the handler through the
same gate `trade/inbox` uses (`runtime.staffGrants.listByDevice` → refuse
`no live staff grant`). The owner creates the grants with the existing
`POST /v1/commerce/staff-grants { device_did, scope, installs, pin? }`, which
needs owner presence. The FIRST grant for a device must carry `pin` (at least
4 characters): it sets the device's presence PIN, and without it the answer is
`400 pin_required`. Later grants may omit it or rotate it. The owner console
lists and revokes grants with the existing routes. No new grant surface.

**B1. Status read.**

```
GET /v1/commerce/integration/status
→ {
    integration_api_version: 1,
    business_did,                       // this node's DID
    device_did,                         // the caller, echoed
    scopes: [{ scope, installs, created_at }],
    catalogs: [{ catalog_id, state, snapshot_sequence, snapshot_digest, published_at }],
    settings_revision: { supplier: <digest>, business: <digest> }
  }
```

`settings_revision` is the canonical JSON digest of the current settings
record, computed on read. No column is added; a revision is a hash of what is
stored.

**B2. Accepted-order export.**

```
GET /v1/commerce/integration/orders?cursor=<opaque>&limit=<n>
→ { events: [...], next_cursor }
```

One event per DECIDED order in the durable order-reference store whose
decision is `accepted` and whose acknowledgement is retained. Never a reserved
order, never a runner's `accepted` that Core has not recorded (§15.5). Each
event:

```
event_id            = sha256(order_digest ‖ acknowledgement_digest)   // stable across replays
decided_at
buyer_did, purchase_order_id
order_digest, quote_digest, acknowledgement_digest
totals: { currency, minor_units }                                    // exact, from the bound quote
lines: [{ line_id, product, name?, quantity, unit_price }]      // product as signed on the order;
                                                                      // name from the live published catalogue
delivery_projection                                                   // the permitted projection only
supplier_order_id?                                                    // when the owner recorded one
```

Cursor = `(decided_at, event_id)` encoded opaquely, the same shape the
AppView's search cursor uses. Replay from any cursor returns the same events
in the same order; a reconnect loses nothing because events are derived from
retained rows, never from a queue. If the order-reference store has no
monotone decision stamp, append migration v46 adding `decided_at` to it (boot-read
table: append, never edit in place).

What the export never carries: buyer personal data beyond the DID, negotiation
history, other merchants' records. An unknown or foreign order is `404
unknown_order` with no detail.

**B3. Settings proposal.**

```
POST /v1/commerce/integration/settings/proposal
{ command_id, kind: 'supplier', expected_revision, controls: { ...allowlisted fields } }
→ 202 { task_id, state: 'pending_owner_approval' }
  | 200 { state: 'applied', task_id, applied_revision }   // same command_id, already decided
  | 409 revision_conflict { current_revision } | 409 command_conflict
  | 409 supplier_settings_absent | 400 unsupported_control | 400 invalid_settings
```

A proposal needs a base the owner set: until the owner saves supplier
settings, `settings_revision.supplier` reads `null`, and a proposal (with
`expected_revision: null` or any digest) answers `409
supplier_settings_absent`. A `null` sent after settings exist answers `409
revision_conflict` with the revision to use. The card and the listing name
the proposer by the owner's device name (`proposed_by_name`) beside its DID
(`proposed_by`).

The route validates the controls with `validateSupplierSettings` on the
merged record, refuses any field outside a fixed allowlist (`unsupported
controls rejected`), compares `expected_revision` with the current digest,
then creates an owner approval task (kind `approval`, payload type
`integration_settings_proposal`, `idempotencyKey = command_id`). The owner
approves or denies on the existing inbox; the workflow service's
`approvalDecisionHandler` applies `writeSupplier` on approve, the same hook
the disclosure review uses. Brain may not decide it (a guard beside
`brainDisclosureReviewGuard`). `GET /v1/commerce/integration/settings` returns
the applied revision and each proposal's state.

Command idempotency, once, for every integration write: the workflow task's
idempotency key is the command id, and the task payload carries a content
digest. Same id, same digest → the recorded result. Same id, different digest
→ `409 command_conflict`. This is the workflow repository's existing partial
unique index plus one digest compare; no new table.

### 3.3 Piece C — order attachments

Gaps 5 and 6 need something to travel from the supplier's node to the buyer's
node, bound to an accepted order, that is neither a `PaymentNote` nor a
`PaymentAcknowledgement`. Today no such document exists.

**One new document type, `OrderAttachment`,** in `@dina/commerce-protocol`:

```
OrderAttachment {
  protocol_version
  attachment_id
  purchase_order_id, buyer_did, supplier_did
  order_digest                                   // binds to the accepted order
  kind: 'checkout_handoff' | 'payment_evidence' | 'fulfilment_evidence'
  source: { kind: 'integration', device_did, provider: 'clover' }   // attribution, always present
  payload                                        // typed per kind, below
  issued_at, expires_at?
  attachment_digest                              // canonical digest, new domain in digests.ts
}

checkout_handoff:   { session_ref, url (https only), amount: Money }   // amount MUST equal the accepted total
payment_evidence:   { provider_ref, amount: Money, state: 'authorized'|'captured'|'refunded'|'failed', version }
fulfilment_evidence:{ provider_ref, state: 'production_started'|'ready'|'handed_to_carrier', version }
```

A new digest domain means a commerce-protocol version bump, a conformance
vector for the digest, and the `$type`-safe read seam every published shape
already has.

**Supplier side.**

- `POST /v1/commerce/integration/orders/attachments { command_id,
  order_digest, kind, provider, payload, expires_at? }` — scope
  `integration_trade_evidence`. `provider` is required and must match
  `[a-z0-9][a-z0-9_-]{0,63}` (e.g. `clover`); it becomes `source.provider`.
  The handler loads the order by digest from
  the durable store (foreign or unknown → `404 unknown_order`), refuses a
  `checkout_handoff` whose `amount` or currency differs from the accepted
  total (`409 amount_mismatch`; a checkout can never change price, currency
  or lines), refuses a non-HTTPS URL, stamps `source` from the CALLER's
  device DID (never from the body), retains the attachment in a new
  `order_attachments` table (migration v46 or v47: digest, order digest,
  kind, source device, payload JSON, created_at, `command_id` unique with
  content digest), and sends it to the buyer over the commerce D2D lane
  signed by the supplier node like every other outbound document.
  Idempotent by `command_id` as in B3.
- Retention feeds the existing `CommerceOrderStatus` emitter: a
  `payment_evidence` with state `captured` and a `fulfilment_evidence` with
  `production_started` each add the attachment digest to `evidence_refs` on
  the next status the owner emits. They never advance `OrderState` on their
  own: dispatch and delivery stay the owner's acts (`preparing`,
  `dispatched`, `delivered`).

**Buyer side.**

- Ingress verifies the sender is the order's supplier, that `order_digest`
  names an order this buyer holds, and that `source.kind` is `integration`
  (a supplier's own key may not author an attachment claiming to be Clover's).
  Retain; refuse duplicates by digest.
- `checkout_handoff` renders as a card on the order: provider, amount, "Open
  payment link", expiry. Dina opens the URL and does nothing else. No card
  data, no payment credential, ever enters Dina.
- `payment_evidence` renders as a status line: "Clover reports payment
  captured, ₹X, ref …". It is evidence. If the buyer wants the khata to
  record the payment, their Dina offers "record this as paid?", the owner
  decides, and only then is a `PaymentNote` authored under the buyer's key.
  The supplier's `PaymentAcknowledgement` remains the supplier owner's act,
  and the existing payment-status rail may check the evidence when a pack is
  active. Payment confirmed, production started, supplier-reported delivery
  and buyer receipt stay four distinct facts with four distinct authors.

---

## 4. Sequencing

Each phase ends green on the full suites (one package at a time, `--runInBand`),
typecheck clean, lint on touched files at HEAD's count, and with a live pass on
the four-node bed against the test infrastructure.

### Phase 0 — prove the catalogue path with no Dina change (2 days, mostly Jiffy)

- Jiffy hosts a per-merchant catalogue endpoint in the known-column shape,
  bearer-authenticated, with a source digest header.
- On the bed, albert's owner stores the credential and binds the source with
  `from_connector` (`kind: 'rest'`), approves and publishes; the test AppView
  indexes the catalogue (`com.dinakernel.service.search` and the catalogue
  records).
- Record the recipe in `dina-nodes/TESTING.md`.
- Acceptance: a Clover-derived row set is discoverable on test-appview with
  zero Dina code change.

### Phase 1 — integration identity, status, orders export (4 days)

- `STAFF_SCOPES` + four scopes; `staff_grants.ts` validation; authz rows;
  handler gate helper shared by the new routes.
- B1 status read; settings revision digest (pure function in
  `commerce_settings.ts`).
- B2 orders export with cursor; migration v46 for `decided_at` only if the
  order-reference store lacks a monotone decision stamp.
- Tests: `staff_grants.test.ts` (new scopes, install scope `supplier`
  required, uncapped), `authz_matrix.test.ts` rows, a route test in the
  `commerce_trade_staff.test.ts` style (handler-level `callerType: 'staff'`)
  covering: live grant admits, missing grant refuses, owner admits, brain
  refuses, foreign order 404 with no detail, cursor replay equality, reserved
  order excluded, runner-`accepted` without retained acknowledgement excluded.
- Live: pair a `jiffy_connector.ts` stand-in in `dina-nodes/` as a staff
  device over MsgBox; owner grants the two scopes; export the bed's decided
  orders; revoke the device; the next call is 403.

### Phase 2 — catalogue refresh and settings proposal (4 days)

- A1 refresh route (stored binding only; `source_parsed`; stops at
  `prepared`); A2 integration projection of drafts and publication; A3 inbox
  item.
- B3 proposal route, `integration_settings_proposal` approval kind, decision
  handler applying `writeSupplier`, Brain guard, expected-revision and
  command-conflict refusals; `GET …/integration/settings`.
- Tests: `catalog_draft_service.test.ts` (refresh yields `prepared`, never
  `approved`), route tests for the four refusals, a workflow-service test that
  the approval decision applies exactly once and a denial applies nothing, a
  contract test that no body field of `refresh` can change the bound source
  or credential.
- Live: Jiffy stand-in refreshes; owner approves on the web inbox; the new
  `snapshot_sequence` shows on test-appview; a proposal with a stale
  `expected_revision` is a 409.

### Phase 3 — order attachments (5 days)

- `@dina/commerce-protocol`: `OrderAttachment`, digest domain, validators,
  conformance vector, version bump and changelog.
- Supplier: retention table (migration), route, amount and URL checks,
  attribution from the caller, D2D send, `evidence_refs` feed into the status
  emitter.
- Buyer: ingress verification, retention, card for `checkout_handoff`, status
  line for evidence, "record this as paid?" card that authors a `PaymentNote`
  only on the owner's yes.
- Tests: protocol vectors; supplier route tests (mismatched amount 409,
  http URL 400, body-supplied `source` ignored, foreign order 404, duplicate
  command idempotent); buyer ingress tests (wrong sender refused, unknown
  order refused, supplier-key-authored attachment claiming `integration`
  refused); phone tests for the two cards; a lifecycle test that evidence
  never advances `OrderState`.
- Live: on the bed, chairmaker (buyer) orders from albert (supplier); the
  Jiffy stand-in attaches a checkout link and then `captured` evidence; the
  buyer's web card shows the link and the evidence line; the buyer records
  the payment; the khata shows one `PaymentNote` authored by the buyer and
  nothing authored by the connector.

### Phase 4 — the three-bakery demo and hardening (3 days)

- Three supplier nodes with Jiffy-hosted catalogues, one buyer, PeerLens
  review evidence on test-appview, quote fan-out and negotiation through
  Dina's normal lanes, orders, checkout hand-off, evidence.
- A `security-review` pass on the diff; an adversarial workflow round on the
  five integration routes with the refuters aimed at cross-merchant reads,
  grant escalation and attribution forgery.
- `implementation-notes.html` entries and a test-plan section, as for group
  coordination.

Total: about 18 working days of Dina work, of which Phase 0 is nearly all
Jiffy's.

---

## 5. Required behaviours from the Jiffy notes, and where each is enforced

| Behaviour | Enforcement |
|---|---|
| Same command id and content → original result; different content → rejected | Workflow idempotency key + payload content digest (B3, C) |
| Expected-revision mismatch is a conflict, never an overwrite | Settings revision digest compare (B3) |
| Requests cannot cross merchants, grants or installs | Every route loads by the caller's node; foreign digests are `404` with no detail; grants are per device and install scope |
| Revoked grants reject new privileged work | Device revocation stamps all grants; the gate reads live grants on every call |
| Errors disclose nothing about another merchant | Non-disclosing refusals, the lifecycle engine's existing rule |
| Accepted-order export is retained Core acceptance | Decided state with retained acknowledgement only (B2) |
| Reconnect and cursor replay lose no events | Events derived from retained rows; cursor is `(decided_at, event_id)` |
| Checkout attachment cannot change price, currency or lines | `amount_mismatch` against the accepted total; no line fields exist on the attachment |
| Evidence is attributed to the connector and provider | `source` stamped from the caller's device DID; body-supplied source ignored; buyer refuses a supplier-key-authored `integration` claim |
| No fabricated `PaymentNote` or `PaymentAcknowledgement` | Attachments are their own document type; the buyer authors a note only on the owner's yes |
| Payment, production, delivery and receipt stay distinct | Evidence adds `evidence_refs`; `OrderState` moves only on owner acts |
| No card data or payment credentials enter Dina | The attachment carries a session reference and an HTTPS URL; the credential broker refuses credential-shaped values in records |

---

## 6. Open questions

1. Should `integration_orders_export` include `rejected` decisions, so Jiffy
   can close its own job records? Proposed: yes, as `decision: 'rejected'`
   events with no totals.
2. Cursor window: how long does the supplier retain decided orders for
   export? Proposed: the order-reference store's own retention; nothing new.
3. Should a `checkout_handoff` be re-issuable after expiry with a new
   `session_ref`? Proposed: yes, a new attachment; the buyer's card shows the
   latest unexpired one.
4. Does the owner want a per-grant daily cap on refresh calls? The AppView
   rate limit and the per-DID Core rate limit already bound abuse; proposed:
   no.
5. Whether a `fulfilment_evidence` of `handed_to_carrier` should PROPOSE a
   `dispatched` status to the owner (a card, never an automatic transition).
   Proposed: yes, in Phase 4 if the demo wants it.

---

## 7. What Jiffy builds meanwhile

From the Jiffy notes, unchanged: merchant bindings and scoped connector
commands on Jiffy's side, persisted publication and order jobs, the real
Clover inventory mapping into the known-column shape, checkout reconciliation,
idempotent evidence delivery keyed by Dina's `command_id`, and replacement of
the simulation buttons. Operations that need a grant Dina has not yet granted
show a visible unavailable or pending state. No fake acceptance, no owner
bypass.

Two things Jiffy can start before Phase 1 lands: the catalogue endpoint
(Phase 0 needs nothing from Dina), and the MsgBox device client, which is the
dina-agent CLI's transport and already documented in `cli/`.

---

## 8. After the first integration review (2026-09-25)

The Jiffy agent's review found eleven gaps. The protocol fixes are folded into
§3 above: product and name on exported lines, the owner's staff setup door,
the device name on the settings card, `supplier_settings_absent`, the
provider token, the first-grant PIN, categories, and the MsgBox exception.
The four missing pieces are built as follows.

- **A supplier that answers without a separate runner.** The supplier pack's
  consent step can bind Core's own reference runner:
  `POST /v1/commerce/install/bind_reference_runner { install_id }` (owner
  only) mints a runner device inside Core, before confirm. The runner claims
  tasks on the pack's plugin lane through the node's own
  `/v1/workflow/tasks/claim` and `/complete` routes, so every guard still
  runs and Core still signs. It prices a quote from the live published
  catalogue at the published price per sell unit: all lines or none, and it
  declines `not_in_catalog`, `no_published_price`, `unit_mismatch` or
  `below_minimum_order`. It accepts submitted orders with an `SO-` reference,
  answers status from the asking buyer's retained order (looked up by the
  authenticated buyer and the purchase order id together, since buyers choose
  their own ids), and agrees to every cancellation; Core's own cancellation
  ruling still decides whether one stands. An operator
  may still pair their own runner instead; the reference runner serves only
  the device Core minted.
- **Pack install writes the listing.** `begin` names the listing the consent
  will write (`rkey: 'self'`, its visibility, the five commerce
  capabilities). `confirm` binds those capabilities to the pack in the self
  listing, unlisted when no listing exists. A public self listing is refused
  (`409 self_listing_public`), because a public custom listing needs schemas
  the commerce lanes do not publish. `POST /v1/commerce/install/bind_listing
  { install_id }` re-binds for an install that is already active.
- **A server buyer turns a quote into an order.** `GET
  /v1/commerce/buyer/quotes` lists held quotes (latest revision each, with an
  `expired` flag). `POST /v1/commerce/orders/from_quote { supplier_did,
  quote_id, projection?, service_rkey? }` needs owner presence on a node that
  can prove it (as `orders/prepare` does). It builds the
  order Core would build from a draft, verifies it against the quote, and
  holds it as an approval; the existing `POST /v1/commerce/orders/submit
  { approval_id }` sends it. A lapsed quote answers `409 quote_expired`.
- **Trade documents between non-contacts.** An order-bound `commerce.trade`
  document (delivery note or receipt, payment note or acknowledgement, order
  attachment) is admitted from a sender who is a contact OR a counterparty:
  the buyer of an order this node ACCEPTED, or the supplier of an order this
  node placed. A retained receipt alone does not count, because admission
  keeps the receipt of every refused proposal and any peer can cause one of
  those. The revenue-share chain names no order and stays with contacts. A
  sender who is neither is dropped before any verifier runs.
