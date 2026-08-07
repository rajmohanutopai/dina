# Dina Commerce and Procurement Plugin Architecture

**Status:** Design, v0.1 (2026-08-06)

**Scope:** A reusable Commerce Pack built on Dina's generic plugin, services,
workflow, approval, identity, vault, D2D, AppView, and managed-runtime
architecture. This is a vertical built on Dina. It is not a redefinition of
Dina as a retail application.

**Implementation posture:** Architecture and protocol design only. The current
plugin substrate has protocol types, persistence, authorization boundaries,
and runner claim/complete support, but the production install, consent,
context projection, dispatch, approval/result, advisory, and SDK journey is
not yet complete end to end. See `PLUGIN_ARCHITECTURE.md` for the authoritative
plugin-platform status.

**Companion documents:**

- `PLUGIN_ARCHITECTURE.md`
- `AGENT_CONTROL_PLANE.md`
- `PUBLIC_SERVICES_TAXONOMY.md`
- `SERVICE_PROVIDER_TIERS.md`
- `SERVICE_CAPABILITY_CATALOG_DESIGN.md`
- `SERVICES_LAUNCH_ARCHITECTURE.md`
- `CARD_SPEC_DESIGN.md`
- `IDENTITY_HUB_REDESIGN.md`

---

## 1. Executive Summary

Dina remains a general personal and organizational AI platform:

- identity and encrypted vaults;
- private context enrichment;
- human approvals and constrained grants;
- agent and plugin supervision;
- Dina-to-Dina communication;
- service publication and discovery;
- durable workflows;
- Ranked Reviews and trust evidence;
- mobile, self-hosted, and managed deployment.

Commerce is one plugin family that composes those primitives into a useful
business workflow. In the motivating scenario:

1. A supplier publishes a structured catalog and a small set of service
   capabilities.
2. A buyer asks their Dina for goods in ordinary language.
3. The buyer's Dina privately adds relevant context such as delivery region,
   preferred suppliers, quantity, budget policy, and past outcomes.
4. A commerce AppView finds candidate products and suppliers from signed
   catalog snapshots.
5. The buyer's Dina requests current, private quotes from a bounded set of
   supplier Dinas.
6. The buyer plugin deterministically compares normalized offers.
7. Dina presents the recommendation and requests approval before any order is
   submitted unless an explicit standing grant covers the exact action.
8. Buyer and supplier Dinas keep signed, durable records of the resulting
   order workflow.

The product is therefore not "Dina for FMCG." The product remains an open AI
and service network. Commerce is the first substantial domain pack proving
that independent Dinas can discover, negotiate, approve, and execute a real
cross-organization workflow.

---

## 2. Binding Architectural Decisions

The following decisions are normative for this design.

1. **Commerce is not Core logic.** Dina Core never contains branches for
   products, retailers, manufacturers, quotes, or purchase orders.
2. **One Commerce Pack, two least-privilege role families.** Buyer and Supplier
   are separate runner-plugin manifests backed by one shared protocol package.
   Optional networked connectors narrow further rather than widening either
   role to every backend.
3. **Role names are functional, not industry labels.** A retailer can also be
   a supplier; a distributor commonly installs both roles.
4. **Services are capabilities; products are data.** A supplier with 50,000
   products publishes a few service capabilities, not 50,000 service
   listings.
5. **Public discovery and private commitment are separate.** Public catalog
   data finds candidates. Current stock, negotiated pricing, exact delivery
   terms, and purchase commitments use private signed exchanges.
6. **Search and commercial arithmetic are deterministic.** An LLM may parse a
   request and explain results. It does not invent totals, taxes, unit
   conversions, ranking scores, or order state.
7. **Plugins propose; Core authorizes.** A plugin cannot approve its own order,
   mint a grant, use identity keys, or perform a Core-mediated effect without
   the current authority checks.
8. **The business owns the data.** Catalogs, quotes, orders, audit receipts,
   and exports cannot become inaccessible merely because a plugin is paused,
   replaced, or uninstalled.
9. **The shared AppView is discovery, not authority.** Live quote and order
   acceptance come from the supplier Dina and are bound to its identity.
10. **No paid ranking input exists.** Commercial access fees may exist, but
    payment cannot alter search rank or trust weight through a protocol field.
11. **No payment rail in v1.** V1 creates an approved order request or purchase
    order. Settlement remains outside Dina until a separately designed payment
    authority model exists.
12. **Managed hosting remains generic.** The same managed runtime can host a
    person's Dina, a school, a supplier, a retailer, an agent control plane, or
    another plugin family.
13. **Authoritative Dina calls are Core-brokered.** Plugins propose typed
    catalog, AppView, D2D, and publication operations. Core validates and
    performs them. A runner may still have separately declared network access
    to its own ERP or vendor backend; that access never gives it Dina identity
    authority and is why Core projects the minimum context and treats the
    runner as potentially hostile.
14. **There is one implementation of each rule.** Protocol validation,
    arithmetic, policy, orchestration, and projections live in shared packages
    or Core. Mobile, web, and Home Node clients do not reimplement them.
15. **Transaction identity is exact; reputation identity is hierarchical.** A
    500 ml pouch and a 1 litre carton remain different purchasable variants,
    but changing pack size, SKU, listing, or identifier does not automatically
    reset relevant product-family, formulation, manufacturer, or seller
    evidence.

---

## 3. Platform Boundary

### 3.1 What belongs to Dina

These remain generic platform responsibilities:

- DID identity and verified device/runtime bindings;
- encrypted vaults and tenant isolation;
- plugin installation, consent, update, pause, revoke, and uninstall;
- service listing publication and discovery;
- D2D request and response transport;
- context projection and PII controls;
- grants, approvals, execution permits, and audit receipts;
- workflow durability, idempotency, claims, retries, and `outcome_unknown`;
- typed host operations for public search, private D2D, publication, and
  credential use;
- safe CardSpec rendering;
- managed Home Node lifecycle;
- billing and resource metering;
- public review and standing infrastructure.

### 3.2 What belongs to the Commerce Pack

The pack owns domain meaning:

- product and variant references;
- catalog item schemas;
- units, case packs, quantity tiers, and commercial terms;
- catalog snapshot creation and import;
- candidate normalization;
- quote request and quote response schemas;
- deterministic offer comparison;
- purchase-order proposal and acknowledgement schemas;
- commerce-specific cards and settings;
- CSV, spreadsheet, ERP, inventory, and order-system adapters;
- commerce conformance fixtures.

### 3.3 What belongs to the commerce AppView extension

The extension owns public retrieval:

- ingesting proof-bound catalog snapshot declarations;
- validating snapshot shape, limits, issuer, and digest;
- indexing products, variants, supplier identity, regions, and freshness;
- maintaining an evidence-backed product relationship projection without
  collapsing exact variant identities;
- composing exact-variant, formulation, family, manufacturer, seller, and
  offer evidence with provenance;
- returning bounded candidate product and supplier references;
- refusing malformed, stale, withdrawn, or policy-ineligible publications;
- exposing retrieval evidence and snapshot version to the requester.

The AppView does not create live quotes, accept orders, or declare a supplier
authorized for a buyer.

The commerce AppView extension is network infrastructure, not an installed
Buyer or Supplier plugin. A Core may query one through a typed commerce-search
host operation. The Buyer runner supplies bounded search requirements and
receives verified candidates; it does not make an unrestricted HTTP request
to the AppView. The reference runners likewise ask Core to send D2D messages
and publish repo records. They may directly reach only separately consented
business-system domains, subject to the generic runner honesty boundary.

### 3.4 How Core brokers commerce without becoming commerce-aware

Core exposes generic extension operations with these properties:

- the operation has a stable typed name and pinned params/result schema;
- an installed, trusted adapter owns domain validation and projection;
- Core supplies authenticated caller, install, consent, and claim context;
- Core alone performs identity signing, D2D send, repo publication, approval,
  credential redemption, and durable workflow transition;
- the adapter returns a proposal or validated result, never an authority
  decision.

A host operation is a durable workflow step, not an arbitrary in-process
callback from runner code. The runner completes its current claim with a typed
proposal; Core validates it, records the transition, and enqueues the next
brokered read or effect step. A later runner claim receives the verified result
needed for comparison or presentation. This preserves claim-token,
idempotency, cancellation, retry, and `outcome_unknown` semantics across the
entire chain.

The Commerce Pack supplies the commerce schemas and adapters through this
generic seam. Core sees "validated extension operation for install X under
authority Y," not special branches such as `if (purchaseOrder)`. This is the
same architectural split as a database driver: the host owns lifecycle and
authority; the driver owns protocol meaning.

"Trusted adapter" does not mean marketplace plugin code loaded into Core. The
adapter is audited, version-gated platform extension code distributed through
the Dina release/update channel (or an equivalent administrator-controlled
enterprise extension channel). A plugin release declares the adapter protocol
version it needs through the generic `required_features` mechanism (for
example, `commerce-host-ops-v1`); installation fails if the node does not have
it. Arbitrary runner code cannot register a new privileged host operation.

The concrete contract — currently REQUIRED platform work, since only the
generic plugin task envelope exists today (section 23):

- at boot, each shipped adapter registers its operations in a Core-owned
  **extension-operation registry**: `{ operation_name, params_schema +
  digest, result_schema + digest, adapter_version, required_feature,
  action_class }`; registration is code-shipped, never data-driven, and two
  adapters cannot claim one name;
- registration creates zero authority. An install may invoke an operation
  only when one of its CONSENTED capabilities declares that operation in its
  manifest scope — the install's capability grants are the per-install
  operation allowlist, and an unlisted operation is denied before
  validation. The declaration is a concrete manifest field: each capability
  may carry `host_operations: string[]` — a bounded (≤ 16), sorted,
  deduplicated list of registered operation names. The list is part of the
  canonical manifest bytes, included in the scope hash (so widening it is a
  re-consent event), and rendered in the consent UI alongside the
  capability's other scopes. Deny-before-validation for unlisted operations
  is a required conformance test (25.2);
- an effectful operation routes through the canonical action plane exactly
  like any other plugin effect: authority-domain evaluation, approval or
  standing-grant check, a single-use execution permit bound to the proposal
  digest, the generic bounded retry policy, and the deny-by-default safety
  floor. `required_feature` expresses compatibility only; it never
  substitutes for authority;
- a runner requests an operation only by completing its current claim with a
  typed proposal naming a registered operation; the request rides the
  existing plugin task envelope and claim-token discipline — there is no
  separate in-process callback surface;
- Core validates the proposal against the registered params schema, records
  it as a durable workflow event (with digests), performs the brokered
  read/effect itself, and records the result event; the linkage
  `proposal event id -> operation -> result event id` is what later steps
  and audit reference — a runner cannot fabricate a result it was never
  handed;
- the next claim for that workflow delivers the validated result; adapter
  version and operation digests are pinned into every such event so a later
  adapter update cannot silently reinterpret recorded history.

---

## 4. Roles and Vocabulary

### 4.1 Buyer

A person or organization seeking goods. A buyer may be a consumer, retailer,
distributor, restaurant, school, hospital, or manufacturer buying inputs.

### 4.2 Supplier

A person or organization offering goods. A supplier may be a manufacturer,
distributor, wholesaler, retailer, farm, or cooperative.

### 4.3 Business Dina

A Dina whose acting identity represents an organization or independently
controlled business activity. It has its own DID, vaults, services, policies,
staff bindings, and audit history. A personal Dina may administer it but does
not silently become the business identity.

### 4.4 Commerce Pack

The shared release family containing:

- `@dina/commerce-protocol`;
- Buyer plugin manifest and runner;
- Supplier plugin manifest and runner;
- reference connectors;
- commerce AppView extension;
- conformance and end-to-end fixtures.

### 4.5 Catalog

A supplier-controlled collection of product variants. A catalog is not a
service listing and is not live inventory.

### 4.6 Catalog snapshot

An immutable, content-bound publication of catalog data at one point in time.
Its signed pointer, digest, generation time, and expiry allow AppViews and
buyers to identify exactly which data was indexed.

### 4.7 Offer summary

Optional public or semi-public information used for candidate discovery, such
as indicative price, minimum quantity, broad fulfilment region, and lead-time
class. It is not a contractual quote.

### 4.8 Quote

A private, audience-bound, expiring supplier response containing current
commercial terms for a specific request.

### 4.9 Order request

The buyer's signed, approved proposal to purchase exact lines under exact
terms. It may be a legally meaningful commercial act; the approval UI must say
so without pretending Dina determines jurisdiction-specific enforceability.

### 4.10 Order acknowledgement

The supplier's acceptance, rejection, or counterproposal. Silence is not
acceptance.

---

## 5. High-Level Architecture

```text
                         PUBLIC RECORD SPACE
             service profiles | catalog pointers | reviews
                               |
                               v
                     +--------------------+
                     | Service + Commerce |
                     | AppView(s)         |
                     +--------------------+
                         candidate refs
                               |
                               v
+------------------+      encrypted D2D      +------------------+
| Buyer's Dina     | <---------------------> | Supplier's Dina  |
|                  |      over MsgBox         |                  |
| Core             |                          | Core             |
| Buyer plugin     |                          | Supplier plugin  |
| Private context  |                          | Catalog adapter  |
| Approval policy  |                          | ERP/inventory    |
+------------------+                          +------------------+
       |                                              |
       v                                              v
 buyer approval card                         supplier approval/policy
       |                                              |
       +------------- durable order workflow --------+
```

Either Dina may run:

- entirely on mobile when availability permits;
- on a self-hosted Home Node;
- in the generic managed Dina runtime;
- in customer-controlled infrastructure;
- with a vendor-hosted runner paired to its own Core.

Execution location does not alter identity, schema, authority, or workflow
semantics.

---

## 6. Package and Plugin Topology

```text
packages/commerce-protocol/
  product.ts
  catalog.ts
  quote.ts
  order.ts
  units.ts
  canonical.ts
  schemas.ts
  conformance/

packages/commerce-projections/
  commands/
  views/
  card-models/

packages/commerce-core-adapter/
  host-operations/
  validation/
  publication/
  reconciliation/

plugins/commerce-buyer/
  manifest/
  runner/
  ranking/
  cards/
  settings/

plugins/commerce-supplier/
  manifest/
  runner/
  catalog/
  quote/
  order/
  cards/
  settings/

packages/commerce-connectors/
  csv/
  spreadsheet/
  generic-rest/
  erp-specific/

appview/src/commerce/
  ingest/
  validation/
  index/
  search/
```

The paths are target ownership boundaries, not a command to create these exact
directories before implementation evidence supports them.

`commerce-projections` is optional as a physical package but mandatory as a
boundary: user commands and read models must be platform-neutral. Mobile and
web render the same Core-owned projections and CardSpec payloads. They must
not independently calculate totals, decide approval, merge order state, or
implement catalog/quote orchestration.

### 6.1 Shared protocol package rules

`@dina/commerce-protocol` must be:

- dependency-light and runtime-neutral;
- free of React, Node, Expo, Fastify, database, and LLM imports;
- canonicalization-first;
- usable by plugins, Core validators, AppView, SDKs, and third-party providers;
- backed by frozen conformance vectors for hashes, units, money, and line-item
  identity.

The Buyer and Supplier implementations must import the same validators. Each
side defining an approximately equivalent quote schema is forbidden.

### 6.2 Why two manifests

The role manifests differ materially:

| Buyer                          | Supplier                                  |
| ------------------------------ | ----------------------------------------- |
| Discovers suppliers            | Publishes a supplier listing              |
| Sends quote requests           | Answers quote requests                    |
| Reads buyer-scoped preferences | Reads supplier catalog and pricing scopes |
| Ranks returned offers          | Produces an audience-bound offer          |
| Proposes an order              | Accepts/rejects/counters an order         |
| Tracks purchases               | Publishes fulfilment status               |

A combined manifest would consent every buyer installation to supplier-side
provider, catalog, inventory, and order permissions. That violates least
privilege. A distributor installs both manifests as two independent installs.

### 6.3 Execution mode

Both reference role plugins are **runner plugins**.

They require deterministic business logic, external data adapters, and
effectful workflow participation. Interpreted mode is deliberately vault-blind
and is not the correct mechanism for procurement.

Small suppliers still get a no-code experience. The managed Supplier runner
can read a CSV, spreadsheet, or managed catalog store selected during setup.
No-code UX does not require interpreted execution.

### 6.4 Multi-install

One Dina may legitimately install Supplier twice for independently managed
businesses or catalogs. Plugin identity remains `(publisherDid, plugin_id)`;
each installation gets a unique `install_id`, lane, grants, config revision,
runtime instance, and label. The service listing binds an exact install, never
"the Supplier plugin" by name.

### 6.5 Connector packaging and consent

A single Supplier release must not contain dormant authority for every ERP,
spreadsheet, database, and commerce platform. The reference packaging is:

- the base no-code Supplier uses CSV upload or the managed catalog store
  through typed Core operations and declares no unrelated external domain;
- a networked backend ships as a connector-specific Supplier runner release or
  separately administrator-installed trusted connector adapter;
- each release declares only the domains, credential resources, and operations
  needed by that backend;
- selecting a different backend that widens those fields is a new install or
  re-consent event, never an ordinary config edit;
- the public service and Business DID remain stable when the implementation is
  deliberately rebound after successful verification.

This remains one Commerce Pack in the marketplace. The user chooses "Sell,"
then chooses a data source; the installer selects the narrow implementation
and shows its actual permissions. Pack branding does not collapse consent.

Generic plugin-to-plugin composition is not required for the first pilot.
Later connector plugins may be introduced only after Dina has a typed,
claim-bound composition contract; one plugin directly invoking another by
local URL or shared database is forbidden.

### 6.6 Plugins are the reference path, not a protocol monopoly

An existing supplier platform may implement the same service capabilities,
catalog proof, quote, and order contracts directly without installing Dina's
reference Supplier plugin. It still needs a valid provider identity, service
publication, schema compatibility, transport authentication, authorization,
idempotency, and conformance evidence.

The buyer must observe the same wire behavior whether the supplier is backed
by:

- the no-code managed Supplier runner;
- a self-hosted Supplier runner;
- a connector-specific runner;
- a third-party service implementation.

The plugin is how Dina makes correct implementation easy. It is not a tollgate
in the open service protocol.

---

## 7. Identity and Organizational Authority

### 7.1 Business identity

The default commercial actor is a Business Dina with `entity_type='org'` or an
equivalent future organization principal. Its DID is distinct from staff and
plugin runtime DIDs.

```text
business DID       owns catalog, services, quotes, and order commitments
staff DID/device   may administer or approve within assigned authority
plugin instance    executes one installed capability lane
connector identity authenticates to an external ERP or inventory system
```

These identities must never be collapsed into one string.

### 7.2 Acting-for chain

An order proposal must resolve and pin:

- authenticated staff/device principal;
- Buyer plugin instance;
- acting-for Business DID;
- authority-domain or policy revision;
- selected service and supplier DID;
- quote and order payload digests.

Caller-supplied body fields do not establish any of those identities.

### 7.3 Staff authority

The target supports:

- owner-only approval;
- buyer role with a spend ceiling;
- category buyer authority;
- branch or location authority;
- second-person or quorum approval;
- supplier-side sales approval;
- time-bounded delegated authority.

The first pilot may use one owner approver, but the wire and persistence
contracts must not encode "one phone equals the organization."

### 7.4 Store and branch modeling

A store is not automatically a Dina.

- One company may have one Business Dina and many store/location resources.
- A franchise with independent authority may have its own Business Dina.
- A listing may cover one location, several locations, or a delivery region.
- Location-scoped staff grants cannot authorize another branch.

---

## 8. Plugin Manifest Shape

The following snippets are abbreviated, non-installable extracts. Required
fields such as complete `display_name`, `params_schema`, `result_schema`,
runtime evidence, and compatibility declarations must be present in a real
release. The authoritative generic fields remain those in
`packages/protocol/src/plugins/types.ts` and `PLUGIN_ARCHITECTURE.md`.

### 8.1 Buyer manifest

```jsonc
{
  "$type": "com.dinakernel.plugin.release",
  "plugin_id": "com.dinakernel.commerce.buyer",
  "version": "0.1.0",
  "display_name": "Commerce Buyer",
  "execution": { "mode": "runner", "runtime": { "...": "..." } },
  "capabilities": [
    {
      "id": "com.dinakernel.commerce.buyer.find",
      "display_name": "Find products",
      "interaction": "query",
      "action_class": "read",
      "privacy_class": "personal",
      "kinds": ["tool"],
      "effects": { "idempotency": "supported" },
      "data_scope": {
        "categories": ["commerce_preferences", "business_locations"],
        "max_context_items": 10,
      },
    },
    {
      "id": "com.dinakernel.commerce.buyer.compare",
      "display_name": "Compare offers",
      "interaction": "query",
      "action_class": "read",
      "privacy_class": "personal",
      "kinds": ["tool"],
      "effects": { "idempotency": "supported" },
    },
    {
      "id": "com.dinakernel.commerce.buyer.submit_order",
      "display_name": "Submit order",
      "interaction": "query",
      "action_class": "write",
      "privacy_class": "sensitive",
      "kinds": ["tool"],
      "effects": { "idempotency": "unsupported" },
    },
  ],
}
```

`effects.idempotency` is not finalized by this example. It may become
`supported` only when the actual supplier order endpoint and retention window
prove that the same key reaches the real effect boundary.

### 8.2 Supplier manifest

```jsonc
{
  "$type": "com.dinakernel.plugin.release",
  "plugin_id": "com.dinakernel.commerce.supplier",
  "version": "0.1.0",
  "display_name": "Commerce Supplier",
  "execution": { "mode": "runner", "runtime": { "...": "..." } },
  "capabilities": [
    {
      "id": "com.dinakernel.commerce.catalog_search",
      "display_name": "Search catalog",
      "interaction": "query",
      "action_class": "read",
      "privacy_class": "public",
      "kinds": ["provider"],
      "effects": { "idempotency": "supported" },
    },
    {
      "id": "com.dinakernel.commerce.request_quote",
      "display_name": "Request quote",
      "interaction": "query",
      "action_class": "quote",
      "privacy_class": "personal",
      "kinds": ["provider"],
      "effects": { "idempotency": "supported" },
    },
    {
      "id": "com.dinakernel.commerce.submit_order",
      "display_name": "Submit order",
      "interaction": "query",
      "action_class": "write",
      "privacy_class": "sensitive",
      "kinds": ["provider"],
      "effects": { "idempotency": "unsupported" },
    },
    {
      "id": "com.dinakernel.commerce.order_status",
      "display_name": "Check order status",
      "interaction": "query",
      "action_class": "read",
      "privacy_class": "personal",
      "kinds": ["provider"],
      "effects": { "idempotency": "supported" },
    },
  ],
}
```

The namespaced commerce capabilities are initially reached by exact provider
reference, not generic custom-capability intent routing. After real use proves
stable semantics, suitable capabilities may be promoted into Dina's official
capability catalog through its additive governance process.

### 8.3 Secret configuration

`config_schema` is for non-secret settings only:

- default currency;
- preferred units;
- ranking weights;
- catalog refresh cadence;
- public regions;
- display labels.

ERP tokens, database credentials, spreadsheet credentials, signing material,
and supplier API secrets must use a Core-owned credential or secret broker.
They never appear in manifest config, logs, workflow payloads, or AppView
records.

The preferred reference path is a Core-owned connector broker that performs a
typed outbound operation without revealing a long-lived credential to the
runner. If an external connector cannot work that way, the owner must consent
to a narrowly scoped credential lease bound to tenant, install, resource,
operation, and expiry. A generic secret read API is forbidden.

---

## 9. Commerce Data Model

The TypeScript below specifies semantic requirements, not final wire spelling.
Every wire type requires size bounds, canonical serialization, schema
versioning, and conformance vectors before lexicon freeze.

### 9.0 Region and delivery projection

```ts
interface RegionRef {
  scheme: 'country' | 'admin_area' | 'postal_area' | 'geohash' | 'custom';
  value: string;
  issuer_did?: string; // required for custom
}

interface DeliveryProjection {
  region: RegionRef;
  locality?: string;
  postal_code?: string;
  address_lines?: string[];
  recipient_name?: string;
  recipient_phone?: string;
  projection_digest: string;
}
```

The projection contains only fields required at the current stage. Public
search normally receives `region` only. A live quote may receive locality or
postal area when necessary. Exact address and recipient fields are private,
encrypted D2D fields. They are disclosed for an order, or for a live quote
whose pricing genuinely requires the exact destination — in both cases only
under owner policy, with approval where policy requires it. Public search
never receives them. This is the single disclosure rule; sections 13.5 and
14.1 apply it, they do not extend it. An unexplained buyer-local address ID
is not a valid delivery instruction.

`projection_digest` is the domain-separated canonical digest of the
projection's present fields, excluding `projection_digest` itself. Each
disclosure stage recomputes it over exactly the fields that stage disclosed,
so widening the projection between quote and order produces a different
digest. `request_digest` and `order_digest` bind the stage-specific projection
digest they embed; the approval binding in section 15.2 therefore pins the
order-stage destination exactly, and a destination change after approval is
a new proposal.

### 9.1 Money

```ts
interface Money {
  currency: string; // ISO 4217 uppercase code
  minor_units: string; // canonical base-10 integer string, no float
}
```

Floating point is forbidden for money. Currency conversion is a separate,
evidence-bearing operation; it is never implicit.

Money used for a price or total is non-negative. Discounts are represented by
an explicitly typed adjustment, not by silently permitting negative prices.
Every arithmetic operation defines scale and rounding; implicit locale or
language-runtime rounding is forbidden.

The v1 arithmetic contract is fixed so two conforming implementations cannot
compute different totals from the same quote:

- one currency per quote and per order; mixed-currency documents are invalid
  in v1, and conversion is a separate evidence-bearing operation;
- every `Quantity.value` uses the declared decimal scale of its `unit_code`
  from the versioned unit vocabulary; a value exceeding that scale is
  invalid, not rounded;
- a line subtotal is computed exactly as `unit_price x (quantity /
  price_basis)` in rational arithmetic, then rounded ONCE to minor units
  using round-half-even; if `quantity / price_basis` is not exact under the
  declared unit conversion, the quote line is INVALID — there is no
  alternate rounding rule in v1, so a supplier must quote a price basis
  that divides the offered quantity exactly (per-unit pricing always
  does);
- the total is the plain integer sum of line subtotals and charges in minor
  units — no re-rounding, no floating point at any step;
- magnitude bounds (maximum minor units, maximum quantity scale) are part of
  the schema, and overflow is a validation failure, never wraparound.

Golden vectors in section 25.1 pin each of these behaviors.

### 9.2 Quantity and unit

```ts
interface Quantity {
  value: string; // canonical decimal string
  unit_code: string; // versioned closed vocabulary or qualified custom id
}
```

Pack, case, pallet, kilogram, litre, and individual-unit relationships must be
explicit. "100" without a unit is invalid.

### 9.3 Product reference

```ts
interface ProductRef {
  scheme: 'gtin' | 'manufacturer_sku' | 'dina_subject' | 'custom';
  value: string;
  issuer_did?: string; // required for manufacturer_sku/custom
  variant_digest?: string;
}
```

Identity precedence:

1. Verified global trade identifier where present.
2. Manufacturer DID plus manufacturer SKU.
3. Existing Dina subject identifier.
4. Qualified custom identifier with issuer DID.

Names are labels, never identity. Different pack sizes are different variants.
An equivalence or substitution claim is evidence, not identity merging.

An identifier is still a signed assertion by its issuer. A syntactically valid
GTIN or manufacturer SKU does not by itself prove trademark ownership,
authenticity, or authorization to sell.

### 9.4 Transaction identity versus reputation identity

Exact identity and evidence aggregation solve different problems.

For transactions, these remain distinct:

```text
500 ml pouch
1 litre pouch
1 litre carton
new formulation under the same label
supplier A's offer
supplier B's offer
production batch or lot
```

They may have different price, stock, packaging, tax, shelf life, fulfilment,
or legal meaning. Dina must never silently substitute or merge them in an
order.

For reputation and discovery, Dina maintains a relationship graph around those
exact nodes:

```text
manufacturer / operator DID
  -> brand or product line
    -> product family
      -> formulation/version
        -> exact packaging/size variant
          -> batch/lot
            -> supplier-specific offer and fulfilment
```

Provisional relationship claim shape:

```ts
interface ProductRelationshipClaim {
  claim_id: string;
  subject: ProductRef;
  relationship:
    | 'manufactured_by'
    | 'marketed_under'
    | 'variant_of'
    | 'packaging_variant_of'
    | 'same_formulation_as'
    | 'replaces'
    | 'sold_by';
  object: ProductRef | { did: string };
  issuer_did: string;
  effective_from?: string;
  effective_until?: string;
  evidence_refs?: string[];
}
```

The supplier may publish these claims, but does not make them true merely by
signing them. AppViews build a projection from multiple evidence sources:

- current and historical supplier catalog snapshots;
- stable global identifiers and manufacturer-scoped identifiers;
- manufacturer, brand, and operator identity records;
- signed relationship claims from manufacturers, suppliers, reviewers, or
  independent resolvers;
- formulation, ingredient, packaging, and variant evidence;
- review and outcome targets;
- explicit replacement or reformulation history.

Every projected edge retains source, issuer, time range, resolver version, and
confidence/evidence status. Conflicting edges coexist; an AppView does not
rewrite the underlying exact product records to make its interpretation look
authoritative.

This produces the anti-whitewashing rule:

> A new pack size, GTIN, SKU, listing, or catalog revision starts with no exact
> variant history, but inherits relevant family, formulation, manufacturer,
> brand, and seller priors with their provenance clearly shown.

Inheritance is dimension-specific. A leaking 500 ml pouch is evidence about
that packaging variant, not automatically about a carton. A complaint that the
milk tastes diluted may apply to the shared formulation. A spoiled delivery
may apply to a batch, seller, or fulfilment path. A company ignoring complaints
may apply to the operator or service, not every product formulation.

A genuine reformulation creates a new formulation node rather than deleting
history. Older evidence may receive lower temporal/relevance weight and be
labelled "previous formulation," but it remains inspectable. A supplier's
unsupported claim that the formulation changed is not sufficient to discard
negative evidence.

### 9.5 Catalog item

```ts
interface CatalogItem {
  product: ProductRef;
  supplier_did: string;
  catalog_id: string;
  item_revision: string;
  name: string;
  brand?: string;
  family_ref?: ProductRef;
  formulation_ref?: ProductRef;
  relationship_claim_refs?: string[];
  description?: string;
  category_ids: string[];
  pack: {
    sell_unit: Quantity;
    units_per_pack?: string;
  };
  identifiers?: ProductRef[]; // same issuer-binding rules as 9.3 — a scoped
  // scheme without issuer_did is invalid here too
  fulfilment_regions: RegionRef[];
  indicative_price?: Money;
  minimum_order?: Quantity;
  freshness: {
    generated_at: string;
    valid_until?: string;
  };
  attributes?: Record<string, string | number | boolean>;
}
```

`attributes` is bounded and category-governed. It cannot become an unbounded
dump of supplier-controlled prompt text.

`family_ref`, `formulation_ref`, and relationship references are supplier claims
for indexing and verification. They never authorize an order substitution or
force an AppView to accept the claimed grouping.

### 9.6 Search requirements

```ts
interface ProductSearchRequirements {
  query_text?: string;
  identifiers?: ProductRef[];
  category_ids?: string[];
  quantity?: Quantity;
  delivery_region?: RegionRef;
  required_by?: string;
  constraints?: {
    maximum_indicative_unit_price?: Money;
    allowed_brands?: string[];
    excluded_ingredients_or_attributes?: string[];
    minimum_shelf_life_days?: number;
  };
}
```

Exact address, buyer history, budget ledger, and staff identity do not belong
in public discovery requirements. The v1 DEFAULT builds search requirements
deterministically from closed fields only — identifiers, category IDs, and
governed attribute vocabulary — with NO free text, which is what makes the
privacy property enforceable. `query_text` is an owner-opt-in exception: it
must be length-bounded, produced by the Core projection path (never the raw
chat turn), pass the structured-identifier scrub (phones, emails, account
numbers, addresses), and appear in the owner-visible outbound-fields view.
The platform does NOT detect person names in free text; the honest
guarantee for `query_text` is "no structured identifiers, bounded, and
owner-visible" — owners who need stronger secrecy keep the closed-field
default.

### 9.7 Quote request

```ts
interface QuoteRequest {
  protocol_version: string;
  request_id: string;
  buyer_did: string;
  supplier_did: string;
  lines: Array<{
    line_id: string;
    product: ProductRef;
    requested_quantity: Quantity;
    acceptable_substitutions?: 'none' | 'equivalent' | 'supplier_may_propose';
  }>;
  delivery: {
    projection: DeliveryProjection;
    required_by?: string;
  };
  requested_terms?: {
    currency?: string;
    credit_days?: number;
  };
  issued_at: string;
  expires_at: string;
  idempotency_key: string;
  request_digest: string;
}
```

The authenticated D2D sender is authoritative for `buyer_did`. A mismatching
body value is rejected rather than trusted. The outer envelope recipient must
equal `supplier_did`. Where an organization is the buyer, its Core sends under
that Business DID; local staff authority is recorded in the private acting-for
receipt, not asserted to the supplier as an unauthenticated body field.

### 9.8 Signed quote

```ts
interface SignedQuote {
  protocol_version: string;
  quote_id: string;
  request_id: string;
  request_digest: string; // digest of the exact QuoteRequest answered
  buyer_did: string;
  supplier_did: string;
  quote_revision: string;
  previous_quote_digest?: string; // intra-quote_id chain: required after rev 1,
  // absent on rev 1 (9.8 CAS rule)
  replaces_quote_digest?: string; // cross-family lineage: set on rev 1 of a
  // counterproposal replacement (9.9)
  priced_delivery_projection_digest: string; // the projection this quote priced
  lines: Array<{
    line_id: string;
    requested_product: ProductRef;
    offered_product: ProductRef;
    quantity: Quantity;
    price_basis: Quantity;
    unit_price: Money;
    line_subtotal: Money;
    stock_status: 'available' | 'partial' | 'backorder' | 'unavailable';
    available_quantity?: Quantity;
    substitution_evidence?: string[];
  }>;
  charges: Array<{
    kind: 'tax' | 'delivery' | 'discount' | 'other';
    label: string;
    amount: Money;
    operation: 'add' | 'subtract';
  }>;
  total: Money;
  estimated_dispatch_at?: string;
  estimated_delivery_at?: string;
  payment_terms?: { credit_days?: number; text?: string };
  issued_at: string;
  valid_until: string;
  supplier_epoch: string; // canonical positive integer; restore fence (16.2)
  max_uses?: string; // canonical positive integer; default "1" (9.9)
  reservations?: Array<{
    line_id: string;
    quantity_reserved: Quantity;
    expires_at: string; // must not exceed valid_until; advisory in v1
  }>;
  catalog_snapshot_ref?: string;
  terms_digest: string;
  quote_digest: string;
}
```

The quote is audience-bound to `buyer_did`. Another buyer cannot replay it.
Every subtotal and total is recomputed by both sides from canonical money and
quantity values; transmitted totals are checked, not trusted. `price_basis`
makes "INR 500 per case" distinct from "INR 500 per item." Quantity divided
by price basis must be exact under the declared unit conversion, or the line
is invalid (the 9.1 arithmetic contract — no alternate rounding rule exists
in v1).

`quote_revision` is monotonic within `quote_id`. A changed commercial field
creates a new revision and `quote_digest`; an already approved digest never
silently follows the latest revision. Every revision after the first carries
`previous_quote_digest`. The chain is ENFORCED at the only place a valid quote
can be born: supplier Core stores the current head digest per `quote_id` and
refuses to authenticate a revision whose `previous_quote_digest` does not
equal that head (a compare-and-swap at signing time), so a conforming
supplier cannot emit two live successors of one revision. Buyer-side, the
chain is fork DETECTION: a revision that does not extend the revision the
buyer already holds is rejected as evidence of supplier fault. The
`reservations` field is part of the quote's canonical field set and is bound
by `quote_digest` like every other commercial field. Supersession is defined
by the supplier's own signing act, with no buyer-acknowledgement event: the
moment supplier Core signs revision N+1, revision N is superseded. An order
referencing a superseded (but unexpired) revision digest receives either an
acceptance — the supplier honoring the older terms — or a `rejected`
acknowledgement with reason `quote_superseded` and `current_quote_digest` set
to the head, so the buyer can re-approve against live terms (the 9.10
representation). An expired revision is rejected AT ADMISSION; replay of an
already-decided order returns the recorded acknowledgement regardless of
later expiry, per the 9.9 precedence.

Reservations are the canonical `reservations` field on the quote (per
`line_id`). In v1 a reservation is a supplier statement of intent, not a
platform-enforced hold; its expiry must not exceed `valid_until`.
Reservation enforcement semantics are Open Question 6 and out of v1 scope.

Buyer verification additionally requires: `request_digest` equals the digest
of the exact request the buyer retained for `request_id`, and
`priced_delivery_projection_digest` equals the projection digest the buyer sent
at quote stage. A quote failing either binding is rejected as answering a
different question.

### 9.9 Purchase-order proposal

```ts
interface PurchaseOrderProposal {
  protocol_version: string;
  purchase_order_id: string;
  buyer_did: string;
  supplier_did: string;
  quote_id: string;
  quote_digest: string;
  accepted_lines: Array<{
    line_id: string;
    product: ProductRef;
    quantity: Quantity;
  }>;
  delivery: DeliveryProjection;
  approved_total: Money;
  accepted_terms_digest: string;
  buyer_reference?: string;
  idempotency_key: string;
  submitted_at: string;
  order_digest: string;
}
```

The proposal references the exact quote digest shown on the approval card.
Changing a quantity, destination, product, price, or term invalidates the
approval and creates a new proposal.

**The order's delivery projection must extend the priced projection.** Every
field present in the projection the quote priced
(`priced_delivery_projection_digest`) must appear byte-identically in the
order's projection; only fields absent at quote stage (typically recipient
name, phone, exact address lines) may be added. The supplier revalidates
that the added fields do not change delivery pricing under its declared
basis — if they would, it counters rather than accepting. Any change to a
field that was present at quote stage requires a requote; the supplier
rejects such orders with a typed `projection_mismatch` error.

**Quote use is counted, atomic, and ordered AFTER replay lookup.** On order
arrival the supplier Core resolves in this precedence:

1. Look up the order-reference record by BOTH unique keys —
   `(buyer_did, purchase_order_id)` and `(buyer_did, idempotency_key)` (15.5).
   If either lookup hits a record whose other key or `order_digest` does not
   match the arriving proposal, return the typed conflict — BEFORE any
   quote-use check. If both match a `decided` record, return the recorded
   acknowledgement — a replay never re-runs quote-use checks. If both match
   a `reserved` record, return the typed `processing` response.
2. Only when neither key exists: in ONE atomic transaction,
   check-and-decrement the quote's remaining uses, create the `reserved`
   order-reference record, AND durably enqueue the decision work (the
   reserved record IS the recoverable work item) — before any approval
   dispatch or external effect. If uses are exhausted, the proposal is
   rejected `quote_consumed` AND that rejection is itself durably recorded:
   the same transaction creates a `decided` order-reference record (both
   keys) holding the signed rejection. An admission answer, once given, is
   frozen — if a competing provisional hold later refunds, a replay of the
   rejected proposal still returns the recorded `quote_consumed`
   acknowledgement, never a retroactive acceptance. A buyer who wants to
   use the freed capacity submits a new purchase order.
3. A `reserved` record tracks its EFFECT PHASE: it is created `pre_effect`,
   and the supplier durably writes `effect_started` BEFORE the first
   attempt to touch any external order boundary (ERP call, order-system
   write, irreversible side effect). The recovery rules differ by phase:
   - `pre_effect` records are safe to recover: a restart sweeper resumes
     them, and a bounded decision deadline converts stragglers to `decided`
     with a `rejected` acknowledgement (reason `decision_timeout`),
     refunding the use hold in the same transaction — reconciliation
     eventually returns `received_rejected`.
   - `effect_started` records are NEVER timed out, refunded, or blindly
     re-dispatched: the external order may exist. The record stays consumed
     while the supplier resolves the true outcome against its own external
     system; reconciliation meanwhile returns the signed
     `received_unresolved` outcome (12.7). Resolution produces the real
     acknowledgement (accepted, or rejected once non-execution is proven,
     which is also when the use hold refunds).

**Use holds commit or refund per terminal outcome.** The admission
decrement is a provisional hold: `accepted` COMMITS it; every `rejected`
outcome — `quote_superseded`, `projection_mismatch`, `decision_timeout`,
policy, or proven non-execution — REFUNDS it; `counterproposal` REFUNDS it
(the replacement is a new family). So rejecting an order against a stale
revision refunds the shared counter, and the buyer's re-approval against
`current_quote_digest` succeeds instead of dying `quote_consumed`. Every
terminal outcome writes its acknowledgement, the `decided` record state,
and the hold settlement (commit or refund) in ONE transaction — a crash
cannot separate the answer from its capacity effect, and every
acknowledgement, including rejections, is persisted in the order-reference
record for replay.

A quote's default `max_uses` is `"1"`; a quote may declare a bounded higher
value (canonical positive-integer string) for genuinely repeatable offers,
and `quote_consumed` means the counted uses are exhausted — not merely
"a second order arrived." Use counting is per `quote_id` across all its
revisions, and `max_uses` is therefore IMMUTABLE within a `quote_id`: every
revision must carry the value fixed at revision 1, a revision changing it
is invalid, and changing the use count requires a fresh `quote_id`.

A counterproposal's replacement quote MUST start a fresh `quote_id`. Its
first revision, like every first revision, carries NO
`previous_quote_digest` (that field is strictly the intra-`quote_id` CAS
chain); cross-family lineage is the dedicated `replaces_quote_digest` field,
set on the replacement's first revision to the countered quote's digest.
Consumption state never carries across `quote_id`s, so a countered family
cannot brick its replacement. This is the enforcement behind the replay
controls in section 20.5.

**V1 orders are all-or-none against the referenced quote.** `accepted_lines`
must equal the quote's full line set with the quoted quantities; ordering a
subset or a different quantity requires a requote. This removes an entire
class of ambiguity — how aggregate charges, discounts, and taxes reallocate
across a partial selection — from the wire contract. A future
line-separability extension needs the quote to declare separable lines and
an explicit charge-allocation rule per charge; until then, receivers reject
subset proposals as invalid rather than guessing an allocation.

### 9.10 Order acknowledgement

```ts
interface OrderAcknowledgementBase {
  protocol_version: string;
  acknowledgement_id: string;
  purchase_order_id: string;
  order_digest: string;
  buyer_did: string;
  supplier_did: string;
  issued_at: string;
  acknowledgement_digest: string;
}

type OrderAcknowledgement = OrderAcknowledgementBase &
  (
    | {
        kind: 'accepted';
        supplier_order_id: string;
        accepted_quote_digest: string;
        accepted_at: string;
      }
    | {
        kind: 'rejected';
        // Typed reasons include 'quote_consumed', 'quote_superseded',
        // 'quote_expired', 'projection_mismatch', 'decision_timeout'.
        reason_code?: string;
        // Set with reason 'quote_superseded': the current head so the buyer
        // can re-approve against live terms (9.8).
        current_quote_digest?: string;
      }
    | {
        kind: 'counterproposal';
        replacement_quote: SignedQuote;
      }
  );
```

### 9.11 Order status

```ts
interface CommerceOrderStatus {
  protocol_version: string;
  purchase_order_id: string;
  supplier_order_id?: string;
  buyer_did: string;
  supplier_did: string;
  sequence: string;
  previous_status_digest?: string;
  state:
    | 'submitted'
    | 'accepted'
    | 'rejected'
    | 'preparing'
    | 'partially_fulfilled'
    | 'dispatched'
    | 'delivered'
    | 'cancelled'
    | 'disputed';
  // REQUIRED when state is 'partially_fulfilled' or 'dispatched'; the wire
  // schema is a discriminated union enforcing that, not an optional field.
  lines?: Array<{ line_id: string; fulfilled_quantity: Quantity }>;
  // REQUIRED when state is 'delivered'; bounds delivered -> disputed (9.11).
  dispute_window_ends_at?: string;
  supplier_epoch: string; // canonical positive integer; restore fence (16.2)
  // Present only on the first status signed after a restore (16.2).
  restore_fence?: true;
  updated_at: string;
  evidence_refs?: string[];
  status_digest: string;
}
```

The legal transition graph is fixed:

```text
submitted -> accepted | rejected | cancelled
accepted -> preparing | dispatched | cancelled | disputed
preparing -> partially_fulfilled | dispatched | cancelled | disputed
partially_fulfilled -> partially_fulfilled | dispatched | cancelled | disputed
dispatched -> delivered | disputed
delivered -> disputed          (only until dispute_window_ends_at)

Absolutely terminal: rejected, cancelled, disputed.
delivered is terminal after dispute_window_ends_at elapses.
```

`submitted -> cancelled` is the buyer-cancellation-wins race outcome from
section 12.8. The `delivered` update carries a structured
`dispute_window_ends_at` timestamp inside the status payload (and therefore
inside `status_digest`); `delivered -> disputed` is legal only before that
digest-bound deadline.

Any other transition is invalid and rejected by the receiver. A
`counterproposal` acknowledgement maps to `rejected` for the referenced
`purchase_order_id`, with the replacement quote recorded alongside; accepting
a counter always creates a NEW purchase order with a new ID — an order never
mutates into different terms.

**Chain genesis is the acknowledgement.** `submitted` is a buyer-local
state; the supplier never signs it. The first supplier-signed status record
has `sequence: "0"`, no `previous_status_digest`, and a state determined by
the resolving event: an `accepted` acknowledgement yields genesis
`accepted`, a `rejected` acknowledgement yields terminal genesis
`rejected`, a buyer-cancellation-wins race yields terminal genesis
`cancelled`, and a `counterproposal` acknowledgement yields terminal
genesis `rejected` (12.6 — the replacement is a new quote family, and any
resulting order is a new chain). Receivers reject a genesis with any other
state, a non-zero first sequence, or a present predecessor digest.

`fulfilled_quantity` is CUMULATIVE per line: each update states the total
fulfilled so far, monotonically non-decreasing and never exceeding the
ordered quantity. A decrease or overshoot is an illegal update, rejected
like any other graph violation.

When `lines` is required it is a COMPLETE snapshot, never a sparse update:
every line of the order appears exactly once, keyed by the order's
`line_id`, with `fulfilled_quantity.unit` equal to that line's ordered unit.
An update that omits an order line, repeats a `line_id`, names a `line_id`
not in the order, or changes a line's unit is invalid and rejected like any
other graph violation. Two conforming receivers therefore derive identical
cumulative state from one signed status — there is no merge rule to
disagree over.

**The status chain has supplier-side CAS at signing, mirroring quotes.**
Supplier Core stores the status head (digest + sequence) per order and
refuses to authenticate an update whose `previous_status_digest` does not
equal the stored head or whose `sequence` is not head + 1. Concurrent
cancellation resolution, dispatch, and fulfilment updates serialize through
that head — a conforming supplier cannot emit two valid successors of one
status. Receiver-side chain checks remain fork DETECTION for a misbehaving
supplier. A terminal `CancellationResult` of kind `cancelled` must carry
`status_digest_at_resolution` equal to the head it ruled on, so the
cancellation is CAS-bound into the same chain.
Free-text status is display material only and cannot drive workflow
authority. `sequence` is a canonical non-negative integer string that
increases for one order; receivers reject rollback, duplicate sequence with
different digest, and a broken `previous_status_digest` chain.

### 9.12 Authentication, signatures, and digest domains

"Signed quote" means a payload authenticated by the supplier Core's signed
D2D envelope and retained with verification evidence. The Supplier plugin
produces an unsigned candidate result. It never receives the Business DID's
signing key and cannot make the candidate authoritative by adding its own
boolean or signature-looking field.

On receipt, Core verifies at least:

- outer sender and recipient against body `supplier_did` and `buyer_did`;
- message family, protocol version, audience, expiry, and replay state;
- pinned service URI, capability schema, and plugin execution receipt;
- canonical payload digest and envelope signature.

Each digest has a domain separator and a specified field set. A digest field
is excluded from its own input. Envelope signatures, transport metadata, and
display-only text are also excluded unless the protocol explicitly includes
them. `projection_digest`, `request_digest`, `quote_digest`, `terms_digest`,
`order_digest`, `acknowledgement_digest`, `status_digest`,
`cancellation_digest`, `result_digest`, and `epoch_digest` (the
CommerceEpochRecord domain — 16.2) require independent golden vectors;
they are not interchangeable hashes over an arbitrary JSON object.

### 9.13 Protocol version negotiation

`protocol_version` is `MAJOR.MINOR`. The rules for rolling upgrades:

- a receiver rejects an unknown MAJOR with a typed error listing its
  supported versions; it never best-effort-parses across majors;
- MINOR is strictly additive (new optional fields only); unknown fields
  within a supported major follow the schema's declared unknown-field rule;
- a supplier's service listing advertises its supported version set, and
  each capability's pinned schema hash corresponds to exactly one version —
  version and schema hash cannot disagree;
- one conversation pins one version: the quote chain and any order built on
  it use the version of the originating request; a counterproposal cannot
  silently upgrade the conversation;
- version withdrawal and plugin updates DRAIN rather than break: the
  supplier stops accepting NEW conversations on the withdrawn version
  immediately, while quotes already issued stay verifiable from receipts and
  orders referencing them are accepted or countered within their validity
  window by the CURRENT runtime. The mechanism is explicit, because
  provider bindings pin one manifest CID and the claim guard rejects stale
  CIDs: a same-major plugin update performs an ATOMIC REBIND of the service
  listing's install binding to the new manifest CID (the deliberate
  rebinding event of section 6.5 — the public service and Business DID stay
  stable). Tasks already created under the old CID complete against their
  pinned schemas, which Core retains until drain completes; new dispatches
  — including in-flight conversations' NEXT messages (an order against an
  earlier quote, a status query) — route to the rebound install, and
  same-major payload compatibility (additive minors) is what makes that
  routing sound for accepted, rejected, and countered continuations alike.
  Because the claim guard admits only the install's CURRENT manifest CID,
  drain requires an explicit platform mechanism: Core keeps a bounded
  DRAIN-AUTHORIZATION table of `(install_id, previous CID)` pairs whose
  already-created tasks the claim guard also admits until their drain
  deadline; this is required platform work alongside the provider bridge
  (11.2a, section 23). A MAJOR bump ends in-flight NEGOTIATION with a typed
  unsupported-version error that tells the buyer to requote — but it never
  strands an accepted commitment: `order_status`, `order_reconcile`, and
  `cancel_order` MUST remain served for orders created under the previous
  major until those orders reach a terminal state. That continuity is an
  EXECUTABLE contract, not a receipt lookup: the supplier retains, for
  every major with non-terminal orders, that major's LIFECYCLE HANDLER SET
  — the versioned request/result schemas for those three capabilities and
  their handlers, including the cancellation path's order state machine and
  external effect-adapter bindings (a cancel is a decision plus a possible
  external action, which receipts alone cannot execute). The retained
  handlers read the order-reference and receipt stores (15.5, 16.2), which
  do not depend on the withdrawn quote machinery, and requests to them are
  parsed under the OLD major's schemas — the unsupported-version rejection
  applies to negotiation capabilities
  (`com.dinakernel.commerce.catalog_search`,
  `com.dinakernel.commerce.request_quote`,
  `com.dinakernel.commerce.submit_order`) only, never to the lifecycle
  three (`com.dinakernel.commerce.order_status`,
  `com.dinakernel.commerce.order_reconcile`,
  `com.dinakernel.commerce.cancel_order`) for a prior-major order. The
  ingress path is defined, not implied: the service listing keeps SERVING
  (without advertising) each retained major's lifecycle capabilities with
  their pinned schema hashes, and routing is pinned by the ORDER — a
  lifecycle request names a `purchase_order_id`, Core reads that order's
  pinned major from the order-reference record (15.5), and dispatches to
  that major's retained handler set; the current negotiation manifest is
  never consulted. On the claim-guard side the drain-authorization table
  extends to LIFECYCLE-CONTINUITY entries `(install_id, prior CID,
  lifecycle capability)` that admit NEW task claims — not only
  already-created tasks — when the task is bound to a non-terminal
  prior-major order. Retained lifecycle handler sets and their continuity
  entries are required platform/pack work (section 23) and are released
  per major once its last order is terminal. The document does not promise cross-major
  quote/negotiation completion, because the platform cannot deliver it.

---

## 10. Catalog Publication and Discovery

### 10.1 Why service profiles are insufficient

Service profiles advertise what a Dina can do. They are not a scalable SKU
index. One service listing per product would create excessive records, weak
identity, noisy discovery, and expensive updates.

The supplier instead publishes:

1. one or more service listings backed by the exact Supplier plugin install;
2. a stable catalog declaration;
3. immutable catalog snapshots referenced by that declaration.

### 10.2 Two-record catalog model

The target mirrors the plugin identity/release principle:

- a stable mutable catalog pointer identifies the catalog and current
  snapshot;
- an immutable snapshot record uses a content-derived rkey and binds metadata
  and payload digest; a verifier recomputes the binding so an in-place
  overwrite or mismatched pointer fails;
- the pointer names supplier DID, catalog ID, snapshot rkey, record CID or
  equivalent content commitment, protocol version, publication time, a
  monotonic `snapshotSequence`, and the previous snapshot's digest;
- pointer publication is compare-and-swap on the previous sequence: a
  publisher racing itself cannot fork the chain, and AppView applies
  snapshots in sequence order, treating a gap or rollback as a publication
  fault rather than silently indexing it;
- v1 snapshots are full-state (a snapshot fully replaces its predecessor's
  current view); withdrawal is an explicit tombstone publication carrying
  the next sequence; delta snapshots are a later, additive extension and
  "incremental refresh" in this document means republishing bounded full
  snapshots on change, not deltas;
- catalog payload pages are bounded, canonical, and digest-verified;
- old snapshots may be retained for audit but are not queryable as current;
- deletion or withdrawal is explicit and propagated to AppView.

Provisional record names:

```text
com.dinakernel.commerce.catalog
com.dinakernel.commerce.catalogSnapshot
```

These names are not frozen by this document.

ATProto does not guarantee permanent record history. A supplier SHOULD retain
snapshots while an unexpired quote or configured commercial-retention window
can reference them, but a private quote/order receipt must remain verifiable
without fetching an old public catalog. The receipt therefore preserves the
exact product, price, terms, snapshot commitment, and envelope evidence used at
the time; public snapshot retention is supporting evidence, not the sole copy.

### 10.3 Snapshot payload options

Small catalogs may use ATProto records or blobs. Large catalogs may use an
HTTPS-served, content-addressed feed whose digest is pinned by the supplier's
repo record. The trust invariant is the same:

```text
supplier repo proof
  -> current snapshot pointer
  -> immutable snapshot metadata
  -> canonical payload digest/root
  -> bounded catalog pages
```

The feed host is transport, not authority. A modified page fails digest
verification.

AppView fetchers treat the feed URL as hostile input: HTTPS only, bounded
redirects, DNS re-resolution checks, private/link-local/metadata-address
denial, strict byte/time/page caps, content-type validation, decompression
limits, and no ambient cloud credentials. This closes the catalog-feed SSRF
and decompression-bomb path.

### 10.4 Inventory and pricing freshness

Catalog snapshots should carry relatively stable discovery data. Fast-changing
inventory and customer-specific price remain live service results.

AppView may index:

- indicative public price;
- broad stock class such as normally stocked or made to order;
- snapshot generation and expiry;
- service health and last successful refresh.

AppView must not present those fields as a current contractual offer.

### 10.5 Search result

The commerce AppView returns bounded candidate references:

```ts
interface CommerceSearchCandidate {
  supplier_did: string;
  serviceUri: string;
  serviceRkey: string;
  product: ProductRef;
  catalog_snapshot_ref: string;
  relationshipEvidenceRefs?: string[];
  matchedFields: string[];
  indicative_price?: Money;
  fulfilment_regions: RegionRef[];
  generated_at: string;
  valid_until?: string;
  retrievalScore: number;
}
```

`retrievalScore` is discovery evidence, not permission and not the final buyer
ranking.

### 10.6 Multiple AppViews

The protocol permits multiple catalog AppViews. A buyer may choose or combine
indexes. Every result carries enough source and snapshot evidence to identify
where it came from and to verify the supplier live before commitment.

### 10.7 Product relationship projection

Catalog search stores exact variants and offers as separate indexed documents.
The relationship graph is a second projection over them, not a destructive
deduplication pass.

An AppView may use AI to suggest likely family, formulation, replacement, or
duplicate relationships from descriptions and attributes. Those suggestions
must remain labelled, versioned inferences until supported by stronger
evidence. An LLM similarity score alone cannot:

- merge two product identities;
- authorize substitution;
- move or delete a review;
- erase a previous product lineage;
- make standing from one node count as exact-variant standing on another.

Search can use lower-confidence semantic relationships to improve recall, but
transaction and reputation calculations use only edges meeting their separate
evidence thresholds. The threshold for showing "possibly related" is lower
than the threshold for inherited standing, which is lower than the threshold
for order substitution.

Plural AppViews may disagree about a relationship. Dina preserves the exact
variant results and exposes material grouping disagreement instead of silently
choosing whichever merge produces the highest score.

---

## 11. Capability Surface

### 11.1 Existing capabilities are NOT reused in v1

Earlier drafts assumed `price_check` and `order_status` could be reused.
Code inspection contradicts that: the official `price_check` schema uses a
floating-point price and permissive additional properties, and
`order_status` has no pinned params/result schemas at all. Both violate
this design's deterministic Money, canonical-identity, and pinned-schema
requirements, and changing the official capabilities' existing semantics
is forbidden by the additive promotion rule.

Commerce v1 therefore defines its OWN namespaced capabilities for every
commerce interaction, including order status. Logistics capabilities may
be referenced for display-only enrichment, never as commercial authority.
Promotion of commerce capabilities into the official catalog (11.3) is
the later, evidence-gated path to shared IDs.

### 11.2 Proposed commerce capabilities

Initial capability surface:

| Capability                               | Class | Discovery                        | Purpose                                                 |
| ---------------------------------------- | ----- | -------------------------------- | ------------------------------------------------------- |
| `com.dinakernel.commerce.catalog_search` | read  | exact supplier/catalog reference | Search one supplier's current catalog                   |
| `com.dinakernel.commerce.request_quote`  | quote | exact supplier reference         | Obtain current private terms                            |
| `com.dinakernel.commerce.submit_order`   | write | never generic intent routing     | Submit an approved order request                        |
| `com.dinakernel.commerce.cancel_order`   | write | known supplier/order only        | Request cancellation (contract in 12.8)                 |
| `com.dinakernel.commerce.order_status`   | read  | known supplier/order only        | Structured commerce order status (9.11)                 |
| `com.dinakernel.commerce.order_reconcile`| read  | known supplier/order only        | Resolve `outcome_unknown` submissions (12.7)            |

The shared commerce AppView can discover the first supplier reference without
making custom capabilities generically intent-routable. The reference client
then invokes the exact published capability and pinned schema.

**Order-scoped capabilities are subject-authorized, enforced by Core.**
"Known supplier/order only" in the table is discovery guidance, not the
control. For `order_status`, `order_reconcile`, and `cancel_order`, supplier
Core verifies BEFORE any runner dispatch that the authenticated caller DID
equals the referenced order's `buyer_did` (or an explicitly recorded
delegate from order time). Any other caller receives a non-disclosing
rejection that does not reveal whether the order exists. Namespaced
capabilities do not inherit the official catalog's subject-authorization
flag machinery, so this check is part of the commerce adapter's validation
contract and its conformance tests.

### 11.2a Provider-kind execution bridge (required platform work)

The Supplier capabilities above are `provider` kind, and the shipping plugin
execution path installs and dispatches only `kind: tool` capabilities today
(`install_service` and the claim guard both enforce `tool`). Provider-kind
plugin capabilities are currently manifest vocabulary, not an executable
lane. Before any Supplier flow works, the platform must add the
provider-ingress bridge:

1. An inbound service query arrives over D2D and passes the existing
   receive-pipeline checks (sender, service URI, listing state, schema hash,
   rate limit, access policy).
2. Core resolves the service binding to the exact `(install_id,
   manifest CID, capability id)` recorded at listing publication. A listing
   that names a paused, revoked, or missing install answers with a typed
   unavailable error, never a stale cache.
3. Core creates a plugin task on that install's `plugin:<install_id>` lane
   with the same claim-token, lease, retry, and schema discipline as tool
   tasks, carrying the validated request payload and the minimum projection.
4. The runner completes the claim with a typed candidate result; Core
   validates it against the pinned result schema and sends the D2D response
   as the Business DID.

The bridge is generic platform work (any provider-kind plugin needs it), is
listed as a gap in section 23, and is a Phase 1 exit dependency.

### 11.3 Promotion to official catalog

A capability may become official only after pilot evidence proves:

- stable semantics across multiple independent providers;
- stable params and result schemas;
- clear action and privacy class;
- clear public exposure and subject-authorization rules;
- deterministic card fallback;
- interoperable failure codes;
- acceptable abuse and rate-limit behavior.

Promotion is additive. Existing custom IDs become aliases or remain supported;
they are never silently reinterpreted.

---

## 12. Core Flows

### 12.1 Supplier setup

1. Owner creates or selects the Business Dina.
2. Owner installs Supplier from a verified release.
3. Consent shows provider, network, data, and effect scopes per capability.
4. Runner instance pairs under role `plugin` for that exact install.
5. Owner selects a catalog source: CSV, spreadsheet, managed catalog store, or
   external system.
6. Secret credentials are stored through the credential broker.
7. Supplier imports and validates catalog data locally.
8. Owner reviews public fields, regions, freshness, and indicative-price
   policy.
9. Supplier runner returns a canonical publication candidate to Core.
10. Core independently validates its schema, digest, public-field policy,
    install authority, and current owner consent. The PRIMARY leakage
    control is structural: public fields use closed, category-governed
    vocabularies, and free-text public fields are few, bounded, and
    enumerated. On top of that, validation runs value-level scanning with
    the existing structured-identifier PII patterns (phone, email, account
    and ID number shapes) plus a secret-shaped-token detector
    (high-entropy strings, known credential prefixes) — the token detector
    is REQUIRED commerce work (section 23), not an existing facility. This
    layer is honest defense-in-depth: it catches identifier and credential
    shapes, and it does NOT promise person-name detection; the closed
    schema is what keeps prose out of public fields.
11. Core publishes the service listing and catalog pointer as the Business
    DID. The plugin never signs or writes the repo record directly. The
    owner's publication review binds the digest of the exact canonical
    snapshot bytes: what the owner approved is byte-identical to what is
    published, and a changed snapshot is a new review.
12. AppView verifies and indexes the snapshot.

### 12.2 Buyer setup

1. Owner installs Buyer from the same verified Commerce Pack publisher.
2. Consent selects permitted business locations, preference categories, and
   maximum context projection.
3. Owner chooses ranking priorities and approval policy.
4. Core pairs the Buyer runner to the exact install lane.
5. No supplier publication or inventory authority is granted.

### 12.3 Search and quote

1. Buyer asks in natural language.
2. An LLM or deterministic form extracts provisional requirements.
3. Dina shows or confirms uncertain quantity, unit, date, or location fields.
4. Core creates a bounded Buyer-plugin task with a schema-pinned projection.
5. Buyer plugin returns normalized search requirements to a typed Core host
   operation.
6. Core queries the selected commerce AppView(s) using only the public search
   projection and verifies returned source evidence.
7. Buyer plugin applies hard local filters to the verified candidates before
   any supplier contact.
8. Core sends quote requests to a bounded top-N set of suppliers.
9. Each Supplier Core verifies service URI, listing state, schema hash, sender,
   rate limit, and access policy.
10. Supplier runner obtains current terms from its selected data source and
    returns an unsigned candidate quote.
11. Supplier Core validates, authenticates, and sends the private quote.
12. Buyer Core validates audience, identity, expiry, schema, and arithmetic.
13. Buyer plugin compares valid quotes and produces a ranked explanation.

### 12.4 Purchase

1. Buyer selects an offer or asks Dina to select under policy.
2. Core creates a canonical order proposal from the exact quote.
3. Current grants and organization policy are evaluated.
4. If approval is required, the card shows the exact supplier, products,
   quantities, delivery destination projection, total, terms, and expiry.
5. Approval binds the canonical order hash.
6. Core revalidates quote expiry, supplier identity, service route, policy,
   and grants immediately before dispatch.
7. Core creates the durable order workflow and sends the order request.
8. Supplier Core deduplicates on the buyer order/idempotency key.
9. Supplier applies its own policy and approval requirements.
10. Supplier returns accepted, rejected, or counterproposal.
11. Both sides persist the acknowledgement and expose the same reference IDs.

### 12.5 Reorder while the owner sleeps

The managed or self-hosted Buyer Dina may search, collect quotes, and prepare a
proposal while the owner is offline.

It may submit automatically only when an active constrained grant covers:

- acting Business DID;
- buyer plugin install and capability;
- supplier allowlist;
- product/category constraints;
- branch/location;
- quantity and spend ceilings;
- price-variance ceiling;
- time window and aggregate usage count;
- current policy revision.

Absent that exact authority, the proposal waits. Availability never becomes
authorization.

### 12.6 Counterproposal

A supplier counterproposal is a new quote with a new digest. It invalidates the
old approval. The UI must never present "supplier changed the price" and then
reuse the previous approval.

### 12.7 Ambiguous outcomes and reconciliation

If an order request may have reached the supplier but the acknowledgement is
lost, the buyer-side workflow parks in `outcome_unknown`. The buyer never
blindly creates a second order.

Reconciliation is a dedicated read capability,
`com.dinakernel.commerce.order_reconcile`, so the ambiguity is resolvable by
contract rather than by guesswork:

```ts
interface OrderReconcileRequest {
  protocol_version: string;
  purchase_order_id: string;
  order_digest: string;
  idempotency_key: string; // the original submission key
  // Buyer-held supplier-signed evidence, presented when the supplier may
  // have lost state to a restore (16.2). The supplier verifies its OWN
  // signatures on these before adopting anything from them.
  held_acknowledgement?: OrderAcknowledgement;
  held_status_receipts?: CommerceOrderStatus[];
}

type OrderReconcileResult =
  | { outcome: 'received_accepted';
      acknowledgement: OrderAcknowledgement & { kind: 'accepted' } }
  | { outcome: 'received_rejected';
      acknowledgement: OrderAcknowledgement & { kind: 'rejected' } }
  | { outcome: 'received_countered';
      acknowledgement: OrderAcknowledgement & { kind: 'counterproposal' } }
  | { outcome: 'received_processing'; retry_after_seconds: number }
  | { outcome: 'received_unresolved'; retry_after_seconds: number }
  | { outcome: 'never_received' };
```

`received_processing` means the decision has not yet reached the external
boundary (`pre_effect`); `received_unresolved` means the effect MAY have
fired and the supplier is reconciling against its external system
(`effect_started` — 9.9). Both loop with bounded re-poll; only
`received_unresolved` signals that resubmission would risk duplication even
after a long wait, and it always terminates in a real acknowledgement once
the supplier resolves the external outcome.

Each decision outcome is narrowed to its matching acknowledgement kind — a
`received_accepted` carrying a rejection payload is schema-invalid, not
merely surprising.

The union is exhaustive over the acknowledgement kinds: a lost
counterproposal is recoverable, and every `received_*` decision outcome
CARRIES the recorded signed acknowledgement — a bare claim without the
evidence payload is invalid. The supplier answers from its durable
order-reference record (15.5). `never_received` is the only outcome that
authorizes resubmission, and only of the byte-identical proposal under the
same `idempotency_key`. It is legal ONLY when the buyer presented no
supplier-signed evidence: a supplier that cannot find the order but is
handed a `held_acknowledgement` bearing its own valid signature must
RE-ADOPT the order — recreate the `decided` order-reference record from
the verified evidence and answer with the matching `received_*` outcome —
because answering `never_received` against its own signature would invite
a duplicate order (the restore-recovery path of 16.2). `received_processing` leaves the buyer in
`submitted_unconfirmed` with a bounded re-poll after `retry_after_seconds`.
The buyer-side order state machine is therefore:
`submitted_unconfirmed -> (ack | reconcile) -> accepted | rejected |
countered | never_received`, with `received_processing` AND
`received_unresolved` each looping in place
(`outcome_unknown -> received_unresolved -> outcome_unknown` is an explicit
transition: re-poll after `retry_after_seconds`, persisted across buyer
restart, never authorizing resubmission no matter how many iterations or
how much time passes) and `outcome_unknown` as the durable parked form of
`submitted_unconfirmed`. The `received_unresolved` loop has no buyer-side
timeout that converts it to a terminal state — only the supplier's real
acknowledgement exits it.

### 12.8 Cancellation contract

Cancellation is a new effectful request. It does not rewrite history or
assume the supplier can undo fulfilment already started.

```ts
interface CancellationRequest {
  protocol_version: string;
  cancellation_id: string;
  purchase_order_id: string;
  order_digest: string;
  reason_code?: string;
  idempotency_key: string;
  issued_at: string;
  cancellation_digest: string;
}
```

The supplier resolves cancellation against acceptance and dispatch
atomically inside its order state machine — exactly one of them wins — and
answers with a typed, supplier-authenticated result:

```ts
interface CancellationResult {
  protocol_version: string;
  cancellation_id: string;
  purchase_order_id: string;
  result:
    | 'cancelled'
    | 'refused_already_dispatched'
    | 'refused_policy'
    | 'pending_review';
  resolved_at: string;
  status_digest_at_resolution?: string; // the order-status head this ruled on
  result_digest: string;
}
```

`pending_review` must terminate in one of the other results; the terminal
result is a later `CancellationResult` carrying the same `cancellation_id`
(that correlation, not a new request, closes the review). Silence is not
cancellation. The request is idempotent on `cancellation_id` (a repeat
returns the recorded result), and a cancellation for an unknown or
digest-mismatched order is rejected without disclosing order existence to
unauthorized callers. `cancellation_digest` and `result_digest` join the
digest-domain rules and golden-vector requirements of section 9.12.
Buyer-side, cancellation is an effectful action: its approval (or covering
standing grant) binds `cancellation_digest`, exactly as order approval binds
`order_digest` (15.2).

---

## 13. Ranking and Private Context

### 13.1 Composition rule

```text
public discovery finds candidates
private live queries obtain current terms
local deterministic ranking selects fit
human policy authorizes commitment
```

### 13.2 Hard filters before scoring

Examples:

- product or substitution eligibility;
- requested quantity and available quantity;
- delivery region;
- required-by deadline;
- maximum total or unit price;
- approved supplier policy;
- legal, dietary, storage, or shelf-life constraint;
- currency and unit compatibility.

A candidate failing a hard constraint is excluded, not merely assigned a low
score.

### 13.3 Deterministic score

The initial ranking function may combine normalized components:

```text
landed cost
delivery fit
supplier preference
private fulfilment history
public trust evidence
credit terms
stock confidence
quote freshness
substitution penalty
```

Weights belong to the buyer. Paid supplier fields are not inputs.

The score implementation must publish:

- version;
- normalized component values;
- weights used;
- missing-data treatment;
- deterministic tie behavior.

### 13.4 LLM boundary

An LLM may:

- parse "100 cases of 200 ml juice for Kochi by Friday";
- identify missing information;
- explain why one valid quote ranked above another;
- summarize non-binding supplier text.
- propose product-family, formulation, packaging, or review-dimension links for
  evidence-backed resolution.

An LLM may not:

- perform money arithmetic used for approval;
- silently infer a missing unit or pack conversion;
- treat a description as identity;
- invent stock, tax, lead time, or terms;
- choose a different order payload after approval;
- turn provider text into instructions.
- silently merge product identities, authorize substitutions, or erase
  inherited evidence.

### 13.5 Context projection

Buyer plugin receives only first-party projected fields necessary for the
invocation. Examples:

- approximate delivery region for public discovery;
- exact destination reference only for live quotes that require it;
- selected supplier preferences;
- bounded private outcome summaries;
- spend ceiling or policy result, not an entire finance vault;
- category constraints relevant to the requested products.

Raw vault rows, unrelated contacts, full order history, and identity keys never
enter the plugin payload.

### 13.6 Hierarchical product evidence composition

The ranking projection keeps evidence layers separate:

```text
exact variant evidence
same formulation evidence
product-family evidence
brand/manufacturer evidence
seller and fulfilment evidence
offer-specific price/terms evidence
```

The exact variant receives the strongest product-specific weight. Broader
evidence contributes only where its dimension is relevant. Counts from
different levels are not added together and displayed as if every review were
about the exact SKU.

For example, Dina may present:

```text
Exact 1 litre carton: 3 reviews
Same formulation/product family: 84 reviews
Manufacturer: 1,240 evidence events
This supplier's fulfilment: 112 outcomes
```

A new variant therefore has an honest state:

```text
No exact-variant history yet.
Inherited evidence exists for this formulation, family, manufacturer, and
seller.
```

The score implementation publishes the edge set and evidence levels it used.
Users can inspect why a review or prior was inherited. Disputed or
low-confidence links cannot silently dominate a recommendation.

---

## 14. Privacy and Disclosure

### 14.1 Progressive disclosure

| Stage                | Supplier receives                                                                    |
| -------------------- | ------------------------------------------------------------------------------------ |
| Public search        | No buyer DID or exact address from the buyer's local search where avoidable          |
| Quote request        | Buyer DID, requested lines, approximate or required delivery region, requested terms |
| Exact delivery quote | Exact destination only when needed and approved by policy                            |
| Order                | Exact approved delivery and commercial payload                                       |
| Public outcome       | Only owner-selected summary; never automatic exact price/quantity disclosure         |

### 14.2 Price confidentiality

Customer-specific pricing, discounts, credit terms, and quotes are private D2D
records. AppView indexes only fields explicitly published as public discovery
data.

A private quote is confidential, not anonymous. The supplier necessarily sees
the authenticated buyer DID and can correlate repeated requests from that DID.
The UI and consent copy must not imply that D2D signing hides the requester.
If relationship unlinkability is later required, it needs a separately
designed pairwise-identity or credential protocol; stripping the DID from the
body does not provide it.

### 14.3 Competitor and probing resistance

Suppliers may require:

- authenticated requester DID;
- invitation or existing relationship;
- rate limits;
- quote reservation;
- broad location before exact pricing;
- manual review for unusual volumes.

Discovery does not imply entitlement to every private price list.

### 14.4 Reviews and outcomes

Public evidence may cover quality, timeliness, accuracy, responsiveness, and
whether terms held up. Exact commercial terms remain private unless the owner
deliberately publishes them.

Private buyer history may carry more local weight than public review volume.

The original signed review remains the primary evidence. Dina or an AppView may
derive a review-dimension projection such as:

- formulation, taste, ingredients, or product quality;
- packaging, size, leakage, or usability;
- batch freshness or safety;
- seller availability, fulfilment, or delivery;
- price and whether quoted terms held;
- customer service or complaint handling.

Derived dimensions retain the extractor/version, confidence, source review,
target node, and relationship path. They do not modify the signed review.
Reviewer-confirmed structured scope carries more weight than an unconfirmed
model extraction. Opaque AI classification alone must not create a large
public standing penalty.

The UI distinguishes:

- reviews written directly about this exact variant;
- relevant reviews inherited from the same formulation or family;
- manufacturer or brand history;
- seller/fulfilment history;
- disputed or uncertain relationships.

---

## 15. Authority, Approvals, and Effects

### 15.1 Action classification

| Operation             | Class   | Default                                     |
| --------------------- | ------- | ------------------------------------------- |
| Search catalog        | read    | allowed under install scope                 |
| Request quote         | quote   | allowed or policy-limited                   |
| Submit purchase order | write   | approval required without constrained grant |
| Accept supplier order | write   | supplier policy or approval                 |
| Cancel order          | write   | approval required unless constrained        |
| Pay invoice           | payment | out of scope and prohibited in v1           |

### 15.2 Approval payload

Buyer approval must bind at least:

- acting business;
- approving principal and authority domain;
- supplier identity and service URI;
- product references and displayed labels;
- quantities and units;
- line prices, charges, currency, and total;
- delivery destination projection;
- quote ID, digest, revision, and expiry;
- terms digest;
- execution and idempotency identifiers;
- plugin install, capability, manifest CID, scope hash, and config revision.

### 15.2b Supplier-side approval payload

Supplier acceptance is an effect with the same discipline. When supplier
policy requires human approval for accepting or countering an order, that
approval binds at least:

- acting supplier Business DID;
- approving principal and authority domain;
- buyer DID;
- `purchase_order_id` and `order_digest`;
- the quote digest being accepted, or the full replacement quote digest for
  a counter;
- the resulting acknowledgement kind;
- Supplier plugin install, capability, manifest CID, and config revision;
- supplier policy revision.

Auto-acceptance under supplier policy records the same payload against the
policy revision instead of a principal.

A cancellation RESOLUTION (approved or auto-policy) records its own receipt
binding, in addition to the base supplier payload: `cancellation_id`,
`cancellation_digest`, the result kind, the status head digest it ruled on
(`status_digest_at_resolution`), and the emitted `result_digest`. Buyer-side,
the cancellation request's approval binds `cancellation_digest` (12.8).

### 15.3 Standing grants

Standing grants are optional constraints, not a global "auto-buy" switch.
Possible predicates include:

- supplier DID allowlist;
- product/category allowlist;
- per-order and rolling-period spend caps;
- quantity caps;
- maximum price variance from a reference;
- branch/location restriction;
- delivery deadline bounds;
- maximum executions;
- expiry;
- approver authority domain.

If the current grant substrate cannot express a required predicate, the action
requires approval. The plugin does not interpret prose into authority.

### 15.4 Supplier authority

Buyer approval cannot force a supplier to accept. Supplier policy may:

- auto-accept a valid quote while stock reservation remains active;
- require sales approval;
- reject expired or over-capacity orders;
- counter with a new quote;
- defer to an external order-management system.

### 15.5 Idempotency

Quote requests should be safely idempotent. Order submission is considered
non-retryable until the final supplier effect boundary proves durable
idempotency using the same key and retention window.

The order idempotency contract is explicit:

- order identity is `(buyer_did, purchase_order_id)`; the buyer never reuses a
  `purchase_order_id`;
- the supplier Core maintains a DURABLE order-reference record keyed by
  `(buyer_did, purchase_order_id)` storing `order_digest`, `idempotency_key`, the
  record state (`reserved` until the decision is durably recorded, then
  `decided`) with its effect phase (`pre_effect` / `effect_started` — 9.9),
  the resulting acknowledgement, and any external system reference;
- BOTH identities are unique per buyer: `(buyer_did, purchase_order_id)` and
  `(buyer_did, idempotency_key)`. An `idempotency_key` arriving with a
  different `purchase_order_id` than it was first recorded under is a typed
  conflict — keys cannot alias across orders;
- same key with the same `order_digest` while `decided`: return the recorded
  acknowledgement, perform no second effect;
- same key with the same `order_digest` while still `reserved`: return a
  typed `processing` response with a retry-after; never a second effect,
  never a fabricated acknowledgement;
- same key with a DIFFERENT `order_digest`: typed conflict error — never a
  second order, never silent adoption of the new payload;
- the record is written before the external effect is attempted, and the
  `effect_started` phase is durably written before the effect itself, so a
  crash can never leave an executed effect behind a record that still looks
  safe to time out (9.9); the record survives restart; its retention window
  is at least the quote validity plus the reconciliation window plus the
  configured commercial-retention period;
- the current generic workflow uniqueness guarantee covers only non-terminal
  tasks, so this order-reference store is REQUIRED commerce work (section
  23), not something the existing task table already provides.

No layer may declare idempotency merely because Dina deduplicates its own task
row. The real external order system must deduplicate the effect; until a
connector proves that with the same key and retention window, automatic
resubmission stays disabled and ambiguity resolves through 12.7.

---

## 16. Data Ownership and Lifecycle

### 16.1 Canonical ownership

| Data                              | Canonical owner/location                               |
| --------------------------------- | ------------------------------------------------------ |
| Public service listing            | Supplier Business DID repo                             |
| Catalog pointer/snapshot proof    | Supplier Business DID repo                             |
| Catalog source                    | Supplier-selected source or tenant-owned managed store |
| AppView index                     | Rebuildable public projection                          |
| Private quote                     | Buyer and supplier durable private receipts            |
| Approval                          | Authorizing Core workflow/approval store               |
| Order request and acknowledgement | Durable workflow receipts on both Dinas                |
| External ERP order                | External system, referenced by immutable receipt       |
| Plugin operational cache          | Per-install state, disposable/rebuildable              |

### 16.2 Plugin state is not business ownership

A per-install plugin vault or runner database may hold caches, cursor state,
and temporary reservations. It must not be the only non-exportable copy of the
business catalog or order history.

**Durable commerce receipts are a Core-owned store, not workflow rows.** The
generic `workflow_tasks`/`workflow_events` tables are classified volatile and
are explicitly EXCLUDED from `.dina` archive export today, so commercial
receipts must not live only there — otherwise quotes, orders,
acknowledgements, and reconciliation evidence vanish on backup/restore or
uninstall, violating FR-B11/FR-S11 and the memo's receipt-retention rule.
Required commerce work (section 23): a per-Business-Dina receipt store
holding the canonical quote chain, order proposal, acknowledgement, status
chain, cancellation, and reconciliation records with their verification
evidence, included in `.dina` export/import, retained per policy across
plugin pause, revoke, and uninstall. Workflow rows remain the execution
engine; the receipt store is the durable commercial memory.

The exported durable state also includes the OPERATIONAL commerce tables
the contracts depend on: quote-use counters, quote heads, status heads, and
order-reference records (both `reserved` and `decided`, with both unique
keys, with effect phases). Restore reconstructs them BEFORE the supplier
resumes answering; a restored node that cannot reconstruct them fails
closed for admissions rather than re-serving quotes with reset counters or
re-signing forked heads.

Reconstructing tables does not defeat a STALE backup: counters and heads
from before the last order look valid and would authorize duplicate
admission or forked signatures. The fence is the **restore epoch**, and it
is executable, not prose:

```ts
interface CommerceEpochRecord {
  protocol_version: string;
  business_did: string;
  epoch: string; // canonical positive-integer string, "1"-based
  previous_epoch_digest?: string; // required after epoch "1"; chains records
  reason: 'initial' | 'restore';
  activated_at: string;
  epoch_digest: string; // own digest domain (9.12), golden vector (25.1)
}
```

The record lives in the supplier's OWN repo at a fixed collection and rkey
(`com.dinakernel.commerce.epoch`, rkey `self`) — outside every `.dina`
backup, so a restore cannot roll it back. Activation is CAS at the PDS:
publishing epoch N+1 swaps against the live record's CID, so concurrent
restores of the same identity serialize — the loser re-reads and
re-increments. A restored node MUST, before signing any quote or status:
fetch the live epoch record (the live record is authoritative over
anything in the archive), publish its increment via CAS, and only then
resume commerce signing; a node that cannot reach its repo fails closed
for commerce signing. Signing nodes also re-verify the live epoch on a
bounded interval, so a forgotten pre-restore node converges; the hard
enforcement is counterparty-side regardless.

`supplier_epoch` is a REQUIRED field of `SignedQuote` and
`CommerceOrderStatus`, covered by `quote_digest`/`status_digest` like every
other canonical field. Counterparty verification: track the highest epoch
seen per supplier DID; reject any newly signed record whose epoch is BELOW
that watermark (a delayed write from a superseded pre-restore node, or
rollback) as supplier fault; a higher epoch is accepted and raises the
watermark.

**Status-chain takeover at a higher epoch.** A restored supplier's store
may be behind signatures the buyer already holds, and the strict
predecessor rule (9.11) would otherwise make any post-restore successor
invalid. The first status signed for a non-terminal order after a restore
therefore carries `restore_fence: true` at the new epoch, with
`previous_status_digest` set to the supplier's best-known head. The buyer
accepts a fence record when its claimed predecessor is EITHER the buyer's
current head (nothing was lost) OR a strict ancestor of it (post-backup
signatures were lost). In the ancestor case the buyer's retained signed
statuses stay authoritative for what they attest — a valid signature
cannot be un-signed by restoring — and the buyer presents them
(`held_status_receipts` / `held_acknowledgement` on `order_reconcile`, 12.7)
so the supplier can verify its own signatures, fast-forward its store, and
sign a corrected successor at the new epoch. A fence whose predecessor is
neither the head nor an ancestor is a fork, rejected as supplier fault. A
non-fence status may never skip the buyer's head. Orders created entirely
after the backup (absent from the restored store) come back the same way:
the buyer's held acknowledgement re-adopts them (12.7's re-adoption rule)
instead of falling through to `never_received`.

On restore the supplier additionally voids all pre-backup unexpired quotes
— admission against one returns `quote_superseded` with a freshly signed
head at the new epoch; capacity is never resurrected from a backup — and
resumes each non-terminal order chain only after reconciling it against
its receipts, held-evidence submissions, and external system, recording a
restore-fence event in the receipt store. The epoch record, watermark
checks, takeover rules, and restore reconciliation are required commerce
work (section 23).

The reference managed catalog store must support:

- complete export in the canonical Commerce Pack format;
- import without changing business DID;
- tenant-scoped encryption;
- versioned snapshots;
- deletion and retention controls;
- no cross-tenant query surface.

### 16.3 Pause

Pausing a plugin:

- stops new dispatch and provider answers;
- preserves install configuration and business data;
- pauses or withdraws affected service listings;
- does not delete quote/order receipts;
- surfaces pending and possibly ambiguous workflows.

### 16.4 Uninstall

Uninstall:

1. stops new tasks;
2. fences the runner instance;
3. resolves or marks active effectful tasks honestly;
4. revokes plugin grants and device authority;
5. unbinds or pauses backed service capabilities;
6. offers export of plugin-managed business data;
7. offers purge of disposable plugin cache and plugin-provenance data;
8. retains required approval, order, and audit receipts under policy.

### 16.5 Update

Manifest CID, behavior hash, schemas, network domains, issuer, execution mode,
or data scope changes follow the generic plugin update and re-consent rules.
An update cannot silently widen from catalog read to order submission.

---

## 17. Managed Runtime and Scale

Commerce depends on the generic managed Dina runtime but does not define it.
The following requirements are vertical integration constraints.

### 17.1 Tenant isolation

Each Business Dina has an isolated Core authority domain, encrypted storage,
identity binding, grants, workflows, service config, and audit history.
The current Home Node Lite single-writer model remains authoritative per
tenant.

### 17.2 Shared components

These may be shared across tenants:

- control-plane metadata;
- commerce AppView and search index;
- MsgBox infrastructure;
- stateless Brain/reasoning workers;
- plugin package cache;
- process supervision;
- billing and metering;
- encrypted backup service.

Shared workers receive bounded tenant jobs. They never receive a reusable
tenant master key or unscoped database handle.

### 17.3 Hot and cold cells

The target runtime keeps active business cells warm and seals idle cells.
Incoming messages, scheduled work, approvals, or catalog refreshes wake the
correct cell. High-volume tenants can move to dedicated workers without a
protocol change.

### 17.4 Hosted plugin runner

A vendor-hosted Buyer or Supplier runner may multiplex many installations only
if every claim is bound to:

- tenant;
- install ID;
- paired plugin instance identity/certificate;
- exact plugin lane;
- capability and manifest CID;
- claim token and context ticket;
- authority snapshot.

A vendor-wide identity alone cannot claim any tenant's task.

### 17.5 Cost behavior

The vertical should minimize LLM and idle-runtime cost:

- AppView performs shared structured retrieval;
- quote and order payloads are structured;
- comparison arithmetic is deterministic;
- LLM use is limited to parsing and explanation;
- idle tenant cells can sleep;
- catalog refreshes are incremental;
- top-N quote fan-out is bounded;
- large suppliers use their existing systems as the data plane.

AI credits can cover variable reasoning cost. Managed availability, storage,
backup, and request capacity require a base service allowance or subscription;
credits alone do not remove fixed hosting costs.

---

## 18. User Experience

### 18.1 Commerce Pack installation

The marketplace presents one pack with two choices:

```text
What do you want this Dina to do?

[ Buy from suppliers ]
Search, compare quotes and prepare orders.

[ Sell to buyers ]
Publish a catalog, answer quotes and manage orders.

[ Both ]
Install both as separate permissions.
```

"Both" creates two installs/consent decisions, not one superset install.

### 18.2 Buyer settings

- business or personal acting identity;
- locations the plugin may use;
- preferred and blocked suppliers;
- ranking priorities;
- allowed product categories;
- quote fan-out ceiling;
- approval policy summary;
- currency and unit preferences;
- public/private review settings.

### 18.3 Supplier settings

- acting Business Dina;
- catalog source and refresh health;
- public regions;
- indicative-price policy;
- quote access policy;
- response policy per capability;
- customer-specific pricing source;
- order acceptance policy;
- service listing state;
- connector health and credential status.

### 18.4 Comparison card

The result must remain useful on the generic CardSpec fallback. A future
comparison block may enhance it, but the baseline renders:

- requested item and quantity;
- valid candidate count;
- recommended supplier;
- total landed cost;
- delivery estimate;
- important terms;
- confidence/freshness;
- reasons for ranking;
- alternative offers;
- missing or incomparable fields;
- "Review order" rather than "Buy now."

### 18.5 Approval card

The card is Dina-generated from canonical fields. Supplier or plugin prose is
quoted and visually attributed. It offers:

- approve once;
- deny;
- modify, which creates a new proposal;
- create a constrained grant where policy supports it;
- inspect quote and supplier evidence.

### 18.6 Supplier inbox

Supplier operators see:

- quote requests needing review;
- orders awaiting acceptance;
- counterproposal controls;
- connector failures;
- stale catalog warnings;
- ambiguous external-order outcomes;
- private decision/audit history.

---

## 19. Failure Semantics

| Failure                                   | Required behavior                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| AppView unavailable                       | Use valid cache if policy allows; otherwise explain discovery unavailable                 |
| Catalog stale                             | Show timestamp; do not present as live stock/price                                        |
| Supplier offline                          | Queue within bounded TTL or report unavailable; do not fabricate quote                    |
| Quote expired                             | Requote; old approval cannot submit                                                       |
| Schema mismatch                           | Reject exact provider result and surface incompatibility                                  |
| Partial quotes                            | Compare only explicitly available lines and identify missing lines                        |
| Currency/unit mismatch                    | Mark incomparable until normalized with evidence                                          |
| Approval provider offline                 | Keep pending or expire; never auto-approve                                                |
| Order send timeout before possible effect | Retry only under proven idempotency                                                       |
| Timeout after possible effect             | `outcome_unknown`, reconcile by stable IDs                                                |
| Supplier counterproposal                  | New quote and new approval                                                                |
| Plugin paused/revoked                     | Fence claims, pause listing, preserve receipts                                            |
| Connector unavailable                     | Typed supplier failure; do not answer from stale data unless policy permits and labels it |

---

## 20. Threat Model

### 20.1 Catalog poisoning

**Attack:** supplier publishes malformed fields, prompt injection, misleading
units, or extreme payloads.

**Controls:** schema and size caps, closed/category-governed attributes,
canonical units, text treated as untrusted display content, digest verification,
AppView ingest validation, rate limits, and no supplier text in system prompts.

### 20.2 Product identity collision

**Attack:** supplier uses another product's label or SKU to inherit search and
review evidence.

**Controls:** identifier-first resolution, issuer DID binding for scoped IDs,
variant digests, no name-based merge, relationship-edge provenance, and
explicit substitution evidence.

### 20.3 Reputation whitewashing by variant churn

**Attack:** a company introduces a new pack size, SKU, GTIN, listing, brand
label, or claimed formulation whenever the previous product accumulates poor
reviews, so every new identifier appears to have a clean reputation.

**Controls:** exact transaction identity plus hierarchical evidence, historical
catalog snapshots, signed lineage claims, independent relationship resolvers,
dimension-specific inheritance, manufacturer/seller priors, temporal
reformulation history, and an explicit "new exact variant with inherited
history" presentation.

Residual risk is honest: a deliberately new company/DID and unrelated-looking
brand can sometimes evade automated linkage. Dina should surface suspected
relationships with provenance, not claim certainty or secretly blacklist an
entity from model similarity alone.

### 20.4 Price bait-and-switch

**Attack:** public low price attracts the buyer; order carries higher terms.

**Controls:** public price labeled indicative, private quote digest, exact
approval binding, expiry, arithmetic recomputation, and outcome evidence.

### 20.5 Quote replay

**Attack:** another buyer or a later order reuses favorable terms.

**Controls:** buyer/supplier audience binding, request and quote IDs, expiry,
revision, order reference to exact quote digest, and supplier revalidation.

### 20.6 Duplicate purchase

**Attack/failure:** retry creates two external orders.

**Controls:** stable buyer purchase-order ID, Core idempotency reservation,
supplier deduplication at the true effect boundary, claim tokens, no unsafe
automatic retry, and `outcome_unknown` reconciliation.

### 20.7 Approval bait-and-switch

**Attack:** plugin changes quantity, destination, product, or price after
approval.

**Controls:** canonical proposal hash, exact quote digest, revalidation before
dispatch, single-use execution authority, and modified proposal requiring new
approval.

### 20.8 Cross-tenant access

**Attack:** hosted runner uses one tenant's catalog, credential, quote, or
grant for another.

**Controls:** tenant/install-scoped claims, per-install runtime certificate,
tenant-scoped repositories and credentials, non-disclosing authorization
checks, isolation tests, and audit receipts.

### 20.9 Location leakage

**Attack:** discovery fans exact store location to many suppliers.

**Controls:** progressive location disclosure, bounded top-N quote fan-out,
exact address references only when required, and owner-visible outbound fields.

### 20.10 Competitor scraping

**Attack:** competitor repeatedly requests quotes to reconstruct private price
books.

**Controls:** authenticated DIDs, access policy, rate limits, relationship or
invite requirements, anomaly logs, reservations, and optional review.

### 20.11 Paid ranking or platform capture

**Attack:** supplier pays platform/operator to rank above better offers.

**Controls:** no paid-weight field, buyer-owned weights, inspectable score
components, source evidence, plural AppViews, and public/private outcome input
that is distinct from advertising.

### 20.12 Malicious plugin update

**Attack:** update widens context, network, or effect authority.

**Controls:** immutable release CID, verified publisher identity, behavior and
scope hashes, re-consent, advisories, pause/revoke, and exact manifest pin in
every task.

### 20.13 External connector compromise

**Attack:** ERP credential or supplier API returns forged or malicious data.

**Controls:** credential broker, audience/resource binding, schema validation,
source provenance, connector health, least privilege, secret rotation, and
Core validation before external results become Dina effects.

### 20.14 Commercial spam and Sybil suppliers

**Attack:** cheap identities flood catalog search.

**Controls:** AppView quotas, identity age and evidence, signed catalogs,
buyer allowlists, relationship preferences, review/outcome evidence, and
retrieval diversity limits. Identity cost alone is not treated as sufficient
Sybil resistance.

### 20.15 Malicious or captured AppView

**Attack:** an index omits competitors, returns stale snapshots, or biases
candidate retrieval while still returning structurally valid records.

**Controls:** source and snapshot evidence on every result, buyer-visible index
choice, plural AppViews, deterministic local hard filters/ranking, result-set
diversity, and comparison diagnostics. Reproducible record verification proves
that an indexed record is authentic; it does not prove that the index returned
every eligible record.

### 20.16 Catalog feed SSRF and resource exhaustion

**Attack:** a catalog URL targets private infrastructure, cloud metadata, an
infinite redirect, compressed bomb, or oversized page graph.

**Controls:** the fetch restrictions in section 10.3, per-supplier budgets,
bounded concurrency, sandboxed parsing, and quarantine rather than retry loops.

### 20.17 Quote fan-out amplification

**Attack:** a requester causes Dina or AppView to contact thousands of
suppliers, leaking demand and consuming network/LLM resources.

**Controls:** hard top-N ceilings, per-request and per-DID budgets,
deterministic candidate narrowing before D2D, no recursive discovery, and
owner-visible fan-out policy.

### 20.18 Buyer abuse and non-genuine orders

**Attack:** a buyer floods suppliers with quotes or signed orders they cannot
or do not intend to honour.

**Controls:** authenticated identity, supplier access/rate policy, quote and
order quotas, optional relationship or deposit requirements outside v1,
buyer outcome evidence, and supplier-side approval. Dina identity proves the
sender; it does not prove creditworthiness or legal capacity.

### 20.19 Arithmetic and unit exploitation

**Attack:** overflow, negative adjustment, ambiguous price basis, malicious
rounding, or incompatible pack conversion changes the approved total.

**Controls:** canonical integer/decimal libraries, bounded precision and
magnitude, explicit adjustment operation, declared price basis, conversion
evidence, golden vectors, and recomputation on both sides and immediately
before approval/dispatch.

### 20.20 Runner exfiltration

**Attack:** a valid but malicious Buyer or Supplier runner sends projected
context to an undeclared backend.

**Controls:** minimal per-task projection, no vault pull API, Core-brokered Dina
network operations, consented network-domain disclosure, host-level egress
enforcement where deployment supports it, plugin advisories, and revocation.
For an opaque hosted runner, declared domains are evidence and consent copy,
not cryptographic proof of runtime behaviour; sensitive projection must assume
the runner can leak everything it receives.

---

## 21. Functional Requirements

### Buyer

- **FR-B1:** Ask for products in natural language or structured form.
- **FR-B2:** Confirm ambiguous quantity, unit, location, and deadline fields.
- **FR-B3:** Search signed public catalogs without disclosing full private
  buyer context.
- **FR-B4:** Request private live quotes from a bounded candidate set.
- **FR-B5:** Validate quote identity, audience, schema, arithmetic, freshness,
  and completeness.
- **FR-B6:** Compare offers deterministically using owner-selected policy.
- **FR-B7:** Explain ranking and missing data.
- **FR-B8:** Submit an exact approved order or a policy-covered order.
- **FR-B9:** Reconcile ambiguous order submission without blind duplication.
- **FR-B10:** Track accepted orders and fulfilment.
- **FR-B11:** Export quotes, orders, and decision receipts.
- **FR-B12:** Pause or uninstall Buyer without losing business records.
- **FR-B13:** Distinguish exact-variant reviews from inherited formulation,
  family, manufacturer, seller, and offer evidence.
- **FR-B14:** Explain every inherited reputation input through a visible
  relationship path and evidence source.

### Supplier

- **FR-S1:** Install Supplier independently of Buyer.
- **FR-S2:** Import catalog data from supported sources.
- **FR-S3:** Validate identifiers, variants, units, and public fields before
  publication.
- **FR-S4:** Publish one or more service listings backed by exact plugin
  installs, never one listing per SKU.
- **FR-S5:** Publish signed, content-bound catalog snapshots.
- **FR-S6:** Answer quote requests from current authorized data.
- **FR-S7:** Apply customer-specific terms without publishing them.
- **FR-S8:** Accept, reject, or counter an order under supplier policy.
- **FR-S9:** Deduplicate order submissions at the real effect boundary.
- **FR-S10:** Publish structured order and fulfilment status.
- **FR-S11:** Export catalog and transaction records.
- **FR-S12:** Pause listings and revoke plugin authority immediately.
- **FR-S13:** Publish product family, formulation, packaging, replacement, and
  manufacturer relationships as signed claims without making them
  automatically authoritative.

### AppView

- **FR-A1:** Verify supplier repo proof and snapshot digest/root.
- **FR-A2:** Enforce record, page, item, field, and refresh caps.
- **FR-A3:** Index exact product variants without name-based identity merging
  while maintaining a separate evidence-backed relationship projection.
- **FR-A4:** Search by identifier, category, text, and broad fulfilment region.
- **FR-A5:** Return bounded source and freshness evidence.
- **FR-A6:** Remove or mark withdrawn/expired snapshots predictably.
- **FR-A7:** Never claim live stock, private price, or buyer authorization.
- **FR-A8:** Preserve source, issuer, time, confidence/evidence status, and
  disagreement for projected product relationships.
- **FR-A9:** Compose review and outcome evidence by relevant dimension without
  presenting inherited evidence as exact-variant evidence.
- **FR-A10:** Carry relevant standing across identifier/packaging churn while
  preserving genuine reformulation and packaging distinctions.

### Platform

- **FR-P1:** Keep Buyer and Supplier as separate installs and consent records.
- **FR-P2:** Bind service capability to exact Supplier install and manifest CID.
- **FR-P3:** Project context per capability and task, not per runner union.
- **FR-P4:** Keep secrets out of plugin config and task payloads.
- **FR-P5:** Bind approval and execution to one canonical order payload.
- **FR-P6:** Preserve `outcome_unknown` for ambiguous effectful execution.
- **FR-P7:** Support personal, self-hosted, managed, and customer-hosted Dinas
  without wire differences.
- **FR-P8:** Preserve export and identity portability across hosting changes.
- **FR-P9:** Perform AppView search, D2D send, repo publication, signing, and
  credential use through typed Core operations rather than plugin-held Dina
  authority.
- **FR-P10:** Expose one platform-neutral command/projection contract to mobile
  and web clients.
- **FR-P11:** Keep exact product identity immutable for transaction authority;
  relationship projections may influence discovery and standing but never
  rewrite an approved line item.

---

## 22. Non-Functional Requirements

### Security

- No cross-tenant object existence disclosure.
- No plugin access to identity or PDS signing keys.
- No secret fields in manifest/config schema.
- All effectful actions claim-bound and payload-bound.
- Locked or disallowed vaults absent from context projection.
- All public and private text rendered as untrusted content.
- Runner network access never substitutes for Core signing, D2D, publication,
  approval, or credential authority.
- AI-proposed product or review relationships never become silent identity
  merges or transaction substitutions.

### Reliability

- At-least-once transport with logical deduplication.
- Durable quote/order workflow before acknowledgement.
- No automatic retry after an ambiguous external effect without provider
  idempotency evidence.
- Restart-safe approvals, claims, receipts, and catalog cursors.
- Bounded dead-letter and reconciliation paths.

### Scale

- No service listing per SKU.
- Incremental catalog refresh.
- Bounded catalog pages and quote fan-out.
- Tenant partitioning by Business DID/install.
- Search index rebuildable from verified public records and snapshots.
- Product relationship projection rebuildable with versioned resolver output
  and retained source provenance.
- Hot/cold managed runtime cells.

### Portability

- Canonical export for catalog, quote, order, and receipt data.
- Plugin and managed-runtime changes do not change Business DID.
- AppView is replaceable.
- Connector replacement does not change capability semantics.

### Observability

- PII-safe health and latency metrics.
- Tenant-private decision logs.
- Catalog refresh and staleness diagnostics.
- Quote fan-out, response, failure, and reconciliation metrics.
- No raw quote, address, product request, DID, or credential in shared logs.

---

## 23. Current Implementation Mapping and Gaps

| Concern                        | Existing foundation                                                           | Required commerce work                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Plugin identity/release        | `packages/protocol/src/plugins`, plugin registries and grants                 | Publish two manifests and complete production installer journey                          |
| Runner lane                    | `plugin:<install_id>`, workflow claim guard and token discipline — the shipping install/dispatch path executes `kind: tool` ONLY; provider-kind capabilities are manifest vocabulary, not yet installable or executable | Provider-ingress bridge (11.2a) plus Buyer/Supplier runners and SDK workflow |
| Provider binding               | Existing service `mcpServer`/runner binding; service bindings do not yet record a plugin install or manifest CID | Bind listing capability to exact `(install_id, manifest CID, capability)` at publication |
| Service visibility             | `public`, `unlisted`, `known_only`; listing state and surface                 | Commerce defaults and supplier setup UX                                                  |
| Service schemas                | Pinned schema hash and response validation                                    | Commerce protocol schemas and vectors                                                    |
| Existing commerce capabilities | `price_check` (floating-point price, permissive schema) and `order_status` (no pinned schemas) — NOT reusable under this design's deterministic contracts (11.1) | Full namespaced commerce capability set including commerce order_status and order_reconcile |
| Durable workflows              | workflow tasks, claims, leases, events, approvals, `outcome_unknown`; task uniqueness covers non-terminal tasks only, and workflow tables are excluded from `.dina` archives | Quote/order envelopes, durable order-reference/idempotency store with effect phases (15.5, 9.9), Core-owned exportable receipt store (16.2), reconciliation UX |
| Version drain and continuity   | Claim guard admits only the install's current manifest CID; no drain or cross-major machinery exists | Drain-authorization table plus lifecycle-continuity claim entries (9.13); order-major-pinned lifecycle ingress; retained per-major handler sets for `order_status`/`order_reconcile`/`cancel_order` until prior-major orders are terminal |
| Restore fencing                | `.dina` export/import exists; no rollback detection | CAS-published CommerceEpochRecord, `supplier_epoch` watermark verification, `restore_fence` status takeover with held-evidence fast-forward, pre-backup quote voiding, per-order restore reconciliation (16.2) |
| Approval UI                    | Existing service/plugin approval direction                                    | Exact commerce order and counterproposal cards                                           |
| CardSpec                       | Safe generic result cards                                                     | Comparison fallback now; additive comparison block later                                 |
| AppView                        | Service profile discovery and official capability search                      | Catalog declarations, snapshots, ingest, index, search                                   |
| Product/reputation resolution  | PeerLens subject and AppView evidence foundations                             | Exact variant index, product relationship projection, review dimensions, resolver UX     |
| Identity                       | DID spine and `entity_type` storage hook                                      | Full organization/staff acting-for and authority-domain UX                               |
| Managed Home Node              | Single-tenant Home Node Lite and shared runtime packages                      | Generic multi-tenant control plane, tenant-cell lifecycle, hosted runner binding         |
| Catalog storage                | None specialized                                                              | Canonical source adapters and tenant-owned managed store                                 |
| Credential boundary            | Existing/planned Core credential boundaries                                   | Connector secret enrollment and scoped use                                               |
| Publication leakage gate       | Structured-identifier PII patterns exist; NO secret-shaped-token detector, NO person-name detection | Secret-token detector; closed public-field vocabularies as the primary control (12.1)    |
| Typed commerce host operations | Generic plugin task/result envelope and existing Core service/AppView clients | Bounded AppView search, D2D send, publication-candidate, and connector-broker operations |
| Shared client projections      | CardSpec and shared Home Node thin-client direction                           | Commerce commands/read models consumed identically by mobile and web                     |

The commerce pack must not claim production readiness merely because workflow
and plugin repository tests pass. The acceptance journey in section 25 is the
minimum end-to-end claim.

---

## 24. Delivery Phases

### Phase 0: Freeze the protocol spine

- Finalize product, unit, money, catalog, quote, and order canonicalization.
- Add golden hash and arithmetic vectors.
- Finalize capability IDs and promotion posture.
- Define catalog declaration/snapshot records and proof verification.
- Define product relationship claims, evidence thresholds, review dimensions,
  and exact-versus-inherited display semantics.
- Define legal order-state transitions and error codes.
- Define quote and order retention/idempotency windows.

Exit: independent TypeScript fixtures produce byte-identical hashes and reject
the same malformed cases.

### Phase 1: Closed pilot, no public catalog AppView dependency

- Verified direct install of Buyer and Supplier.
- Supplier CSV import and local catalog search.
- Known supplier reference shared by link/invite.
- Private quote request and structured response.
- Deterministic comparison.
- Buyer approval and signed order request.
- Supplier accept/reject.
- Order-status query.

Target: 3-5 suppliers, 5-15 buyers, one region, one or two categories.

Exit: a real buyer requests goods, receives at least two live quotes, approves
one exact order, and both Dinas retain matching receipts across restart.

### Phase 2: Public catalog discovery

- Catalog pointer and immutable snapshot publication.
- Commerce AppView ingest and search.
- Freshness, withdrawal, and incremental refresh.
- Product identity and variant resolution.
- Evidence-backed product family/formulation/packaging projection without
  destructive identity merge.
- Bounded top-N quote fan-out.

Exit: a buyer with no prior supplier reference discovers and successfully
quotes a live supplier from proof-bound catalog data.

### Phase 3: Managed business runtime

- Generic hosted Business Dina tenant cells.
- Hosted Buyer/Supplier runner instances with per-install binding.
- Encrypted managed catalog store and export.
- Staff approval roles and tenant-private logs.
- Metering, quotas, backup, recovery, and hot/cold lifecycle.

Exit: owner phone may sleep while read/quote work continues; effectful work
waits or executes only under exact standing authority.

### Phase 4: External systems

- Spreadsheet and generic REST connectors.
- One real ERP/inventory connector.
- Credential broker and rotation UX.
- End-to-end idempotency evidence at order boundary.
- Fulfilment updates and reconciliation.

Exit: an accepted Dina order appears exactly once in the external system, or
an ambiguous outcome is honestly reconciled.

### Phase 5: Trust and wider interoperability

- Commerce outcome prompts and Ranked Reviews integration.
- Reviewer-confirmed evidence scope and dimension UX.
- Plural product relationship resolvers and disagreement display.
- Additional AppViews and cross-index evidence.
- Third-party Commerce Pack implementations using the conformance kit.
- Optional standard-capability promotion based on evidence.

---

## 25. Conformance and Testing

### 25.1 Protocol vectors

- money canonicalization and overflow boundaries;
- line-subtotal rounding (single round-half-even, exact-ratio price basis,
  integer total summation — the 9.1 contract);
- decimal quantity normalization;
- unit and pack conversion;
- product-ref normalization;
- product-relationship claim canonicalization and temporal validity;
- delivery-projection digest across disclosure stages;
- catalog snapshot digest/root;
- request digest;
- quote digest (including reservation fields);
- terms digest;
- order proposal digest;
- acknowledgement digest;
- status digest and status chain;
- cancellation request and result digests;
- commerce epoch record digest and epoch chain (16.2);
- line subtotal and total recomputation;
- substitution and variant mismatch;
- exact-variant identity preserved across relationship projection;
- schema-version and unknown-field behavior.

### 25.2 Plugin security tests

- Buyer cannot claim Supplier lane or capability.
- Supplier cannot read buyer context outside one quote task.
- Two installs of the same plugin remain isolated.
- Vendor-wide hosted identity cannot claim tenant work.
- Manifest update widening scope requires re-consent.
- Revoked install cannot claim, complete, notify, or publish.
- Params carrying sensitive text escalate according to generic plugin rules.
- Secrets never enter config snapshots, logs, or AppView.
- Reference Buyer cannot call AppView or send D2D except through the typed Core
  host operation.
- An extension operation not declared in the invoking capability's
  `host_operations` list is denied before validation.
- Widening `host_operations` changes the scope hash and forces re-consent.
- Mobile and web issue the same commerce commands and receive equivalent
  projections for the same repository state.

### 25.3 Commerce workflow tests

- Duplicate quote request returns one logical quote/revision behavior.
- Quote to buyer A is rejected when used by buyer B.
- Expired quote cannot create an order.
- Changed quantity invalidates approval.
- Counterproposal requires new approval.
- Duplicate order submission reaches the supplier effect once where proven
  idempotent.
- Same order key with a different payload digest returns a typed conflict,
  never a second order.
- Subset or changed-quantity proposals against a quote are rejected
  (all-or-none rule).
- Timeout after possible effect becomes `outcome_unknown`.
- Only `never_received` permits byte-identical resubmission.
- Cancellation races acceptance/dispatch atomically; a repeat cancellation
  returns the recorded result.
- Reconciliation links the external order without rewriting history.
- Quote revision chains reject forks and unchained revisions (supplier-side
  CAS at signing; buyer-side detection).
- A consumed quote cannot authorize a second order (`quote_consumed`);
  concurrent admissions against a multi-use quote decrement exactly once
  per order.
- Replay lookup precedes consumption: a decided replay returns the recorded
  acknowledgement even after quote expiry or supersession.
- An idempotency key reused under a different purchase-order ID returns a
  typed conflict — checked before any use-count decrement.
- A crashed `pre_effect` reservation recovers: the sweeper resumes it or
  the decision deadline converts it to `rejected(decision_timeout)` with
  the use hold refunded; reconciliation never loops on
  `received_processing` past the deadline.
- An `effect_started` reservation is never timed out, refunded, or
  re-dispatched: recovery leaves it consumed, reconciliation returns
  `received_unresolved`, and only the supplier's external resolution
  produces the terminal acknowledgement (refund only on proven
  non-execution).
- Use holds settle per terminal outcome: `accepted` commits;
  `rejected` (every reason) and `counterproposal` refund; rejecting an
  order against a stale revision then re-approving against
  `current_quote_digest` succeeds under default `max_uses` — the stale
  rejection does not consume the shared counter.
- `quote_superseded` rejection carries `current_quote_digest`; a changed
  `max_uses` between revisions is invalid.
- Status genesis: sequence "0", no predecessor, state matching the
  resolving acknowledgement; any other genesis is rejected.
- Cumulative `fulfilled_quantity` regression or overshoot is rejected.
- `lines` is a complete snapshot: an update omitting an order line,
  repeating a `line_id`, naming an unknown `line_id`, or changing a line's
  unit is rejected.
- Cancellation-resolution receipts bind cancellation_id, cancellation_digest,
  result kind, status head, and result_digest.
- Restore without operational tables (use counters, heads, order
  references) fails closed for admissions.
- Restore from a STALE backup is fenced: the restore epoch increments via
  PDS CAS, pre-backup unexpired quotes are voided (admission returns
  `quote_superseded` with a fresh head at the new epoch, never resurrected
  capacity), and a counterparty rejects any newly signed quote or status
  below its epoch watermark.
- Concurrent restores serialize through the epoch record's CAS; the loser
  re-reads and re-increments.
- A delayed write from a superseded pre-restore node (old epoch) is
  rejected by the counterparty watermark.
- Status takeover: a `restore_fence` successor whose predecessor equals the
  buyer's head, or is a strict ancestor of it, is accepted; buyer-held
  receipts fast-forward the supplier via `held_status_receipts` and a
  corrected successor follows; a fence predecessor that is neither is
  rejected as a fork; a NON-fence status may never skip the buyer's head.
- An order absent from the restored store is re-adopted from a verified
  `held_acknowledgement` instead of answering `never_received`;
  `never_received` requires the absence of supplier-signed evidence.
- A rejected admission (`quote_consumed`) is durably recorded: replay
  returns the identical rejection even after a competing hold refunds.
- Terminal-outcome atomicity: acknowledgement, `decided` state, and hold
  settlement land in one transaction across a crash boundary.
- The `received_unresolved` loop persists across buyer restart, re-polls
  on `retry_after_seconds`, never times out buyer-side into a terminal
  state, and never authorizes resubmission.
- Closed-field search default emits no free text; opt-in `query_text` is
  bounded, scrubbed, and owner-visible.
- An order whose delivery projection changes a priced field is rejected
  `projection_mismatch`.
- Pricing-neutral quote-stage-absent additions (recipient name/phone) are
  accepted; a quote-stage-absent addition that changes delivery pricing
  under the supplier's declared basis produces a counterproposal, not an
  acceptance.
- `order_reconcile` covers all six result variants, including the
  `received_processing` re-poll loop, the `received_unresolved`
  effect-ambiguity loop, and the kind-narrowed acknowledgement payloads.
- Order-scoped capabilities reject a caller who is not the order's buyer,
  without disclosing order existence.
- Status updates violating the legal transition graph are rejected;
  `delivered -> disputed` succeeds only within the dispute window.
- Snapshot pointer publication rejects sequence gaps, rollback, and
  non-CAS forks.
- Version withdrawal drains: new conversations rejected, in-flight
  same-major orders complete; cross-major NEGOTIATION (`catalog_search`,
  `request_quote`, `submit_order`) returns the typed unsupported-version
  error.
- Prior-major lifecycle continuity: `order_status`, `order_reconcile`, and
  `cancel_order` for a non-terminal prior-major order route by the order's
  pinned major to the retained handler set (a lifecycle-continuity claim
  admits the NEW task under the prior CID), are parsed under the old
  major's schemas, and are served — including an executed cancellation —
  until the order is terminal.
- Publication-leakage gate blocks structured identifiers and secret-shaped
  tokens in public fields.
- Provider-binding dispatch: a listing bound to a paused/revoked/missing
  install answers typed-unavailable and never dispatches.
- Receipts survive backup, restore, and plugin uninstall (receipt store, not
  workflow rows).
- Buyer and supplier restarts preserve matching receipts.
- Cancellation does not claim to undo an already executed effect.

### 25.4 AppView tests

- Forged snapshot pointer or payload digest is rejected.
- Oversized/deep/high-cardinality catalog is bounded.
- Product names do not merge identities.
- Scoped manufacturer SKU requires issuer DID.
- Expired/withdrawn snapshots leave normal search.
- Public index never stores private quote fields.
- Search returns exact service/snapshot references and bounded candidates.
- Paid or arbitrary supplier fields cannot affect rank.
- A new pack size/SKU does not reset relevant family or manufacturer evidence.
- A packaging complaint does not become formulation evidence without support.
- A formulation complaint can apply across pack sizes linked to that
  formulation while remaining labelled inherited evidence.
- Genuine reformulation creates a new node and retains inspectable prior
  history with lower relevance rather than deletion.
- Conflicting lineage claims remain separate with provenance.
- LLM-proposed similarity alone cannot merge identities, move reviews, or
  authorize substitution.
- Changing an AppView resolver version produces reproducible projection
  changes and never mutates source records.

### 25.5 Managed-runtime tests

- Two tenants with identical local IDs cannot cross-read.
- Shard restart preserves inbox/outbox and workflow state.
- Cold wake processes one request once.
- Old runtime is fenced after tenant reassignment.
- Hosted runner claim requires tenant/install binding.
- Backup/restore preserves business DID and decrypts only with correct
  authority.
- Owner offline never changes approval policy.

### 25.6 Manual acceptance journey

The first production claim requires a real end-to-end run:

1. Create Supplier Business Dina.
2. Install Supplier from a verified release.
3. Import a real small catalog.
4. Publish a supplier listing and catalog snapshot.
5. Create Buyer Dina separately.
6. Install Buyer with only buyer permissions.
7. Ask for a product using quantity, location, and deadline.
8. Discover at least two suppliers.
9. Receive private structured quotes.
10. Verify deterministic recommendation and evidence.
11. Approve one exact purchase order.
12. Accept it on Supplier Dina.
13. Restart both sides.
14. Verify matching order state and receipts.
15. Revoke Supplier plugin and prove it cannot answer or complete further work.

---

## 26. Non-Goals

- Turning Dina into a centralized marketplace.
- One service listing per product.
- Payment, escrow, lending, or settlement in v1.
- Replacing ERP, POS, warehouse, accounting, or logistics systems.
- Letting an LLM make unverified commercial calculations.
- Inferring organization authority from a contact label.
- Making public catalog presence equivalent to supplier verification.
- Guaranteeing legal enforceability in every jurisdiction.
- Hiding managed-hosting custody realities.
- Supporting every FMCG category before a narrow pilot works.
- Putting commerce fields into generic Core workflow tables.
- Making the reference plugins mandatory for third-party providers that
  implement the same protocol directly.

---

## 27. Open Questions

1. Final commerce capability names and which, if any, enter the official
   catalog before pilot evidence.
2. Exact catalog snapshot transport for small and large catalogs: AT blobs,
   external content-addressed pages, or both.
3. Product category vocabulary and governance without recreating a universal
   product taxonomy inside Dina.
4. Unit vocabulary, pack conversion evidence, and locale display.
5. Whether public indicative price is permitted by default or opt-in only.
6. Quote reservation semantics: does quoting reserve stock, and for how long?
7. Legal presentation of purchase-order commitment across jurisdictions.
8. Minimum organization/staff authority model needed for the first pilot.
9. Managed catalog-store encryption and export contract.
10. Exact quote fan-out ceiling and anti-probing policy.
11. How supplier-specific credit eligibility is represented without leaking
    sensitive commercial information.
12. Whether fulfilment updates reuse existing logistics capabilities or need a
    commerce-specific state projection.
13. Review/outcome fields safe enough for public publication.
14. Catalog AppView ranking composition and plural-index merge behavior.
15. Whether substitutions are supplier assertions, third-party equivalence
    records, or both.
16. How tax evidence and currency conversion providers are selected and
    pinned.
17. Which connector ships first after CSV based on pilot demand.
18. Whether product relationships need a new public lexicon record or begin as
    catalog-contained claims plus AppView projections.
19. Evidence thresholds for search recall, inherited standing, and transaction
    substitution; these must be separate thresholds.
20. Review-dimension vocabulary and the point at which reviewer confirmation
    is required before public standing changes.
21. How brand sale, company acquisition, reformulation, relabelling, and
    private-label manufacturing affect inherited evidence.
22. Governance and challenge flow when plural AppViews disagree about product
    lineage.

---

## 28. Architecture Decision Summary

1. Dina remains the platform; commerce is a vertical pack.
2. Buyer and Supplier are separate runner plugins sharing one protocol.
3. Businesses can install either or both roles.
4. Products are catalog data, not service listings.
5. Public snapshots support discovery; private live quotes support decisions.
6. AppView retrieves candidates but has no transaction authority.
7. Core owns identity, context projection, policy, approval, signing, and
   durable effect lifecycle.
8. Plugins never hold Dina identity/recovery keys.
9. Quote and order payloads are typed, canonical, audience-bound, and
   digest-pinned.
10. Order approval binds the exact payload shown to the approver.
11. Deterministic code performs ranking and arithmetic; LLMs parse and explain.
12. `outcome_unknown` is preserved whenever an external order may have
    happened but cannot be proved.
13. Business data remains exportable and independent of one plugin install.
14. Managed hosting is a generic Dina runtime using isolated tenant authority.
15. The first validation target is a small real network, not a universal FMCG
    marketplace.
16. Exact variants remain distinct for transactions, while reputation uses a
    provenance-preserving product graph so ordinary SKU or packaging churn
    cannot reset relevant history.

---

## 29. One-Sentence Product Description

> Dina Commerce lets a person's or business's Dina discover suppliers,
> privately obtain current terms, compare them using the buyer's own context,
> and execute an exact approved order, while every supplier remains an
> independent Dina service on the wider open network.
