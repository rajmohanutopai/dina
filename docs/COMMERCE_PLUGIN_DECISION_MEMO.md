# Decision Memo: Commerce as a Dina Plugin Pack

**Status:** Proposed decision for independent review

**Date:** 2026-08-06

**Detailed design:** `COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md`

## 1. The Decision in One Paragraph

Dina should remain a general AI control plane and open service network. Retail
and procurement should be implemented as an optional **Commerce Pack**, not as
commerce-specific behavior inside Dina Core. The pack should contain separate
Buyer and Supplier runner plugins that share one commerce protocol. Products
should be published as catalog data, while live price checks, quotes, orders,
and status updates should use Dina Services and durable workflows. Dina Core
should continue to own identity, private-context projection, authorization,
approvals, signing, D2D transport, and effect safety.

## Decision History: How We Arrived Here

This proposal did not begin as a plan to build a commerce product. The decision
evolved through the following stages.

### Stage 1: The original problem was an always-available Dina

The starting question was operational:

> How can a person's or business's Dina continue to answer when the owner's
> phone or local Home Node is asleep or offline?

The original direction was a generic server-hosted Dina:

- mobile Dina and self-hosted Home Node remain valid options;
- customers that need continuous availability can run Dina on a server;
- Dina may eventually offer a managed version of the same runtime;
- each hosted Dina still keeps separate identity, encrypted storage, grants,
  workflows, plugins, credentials, and audit history;
- shared infrastructure may provide messaging, search, supervision, metering,
  and stateless reasoning;
- LLM cost can later use credits, while fixed hosting cost needs a separate
  allowance or subscription model.

At this stage there was no retail-specific architecture. The goal was a proper,
scalable, generic managed Home Node or Dina runtime.

### Stage 2: A retailer/manufacturer network supplied a concrete use case

The next discussion introduced a real business network:

- one participant knows manufacturers and retailers;
- manufacturers or other suppliers publish products, location, price, and
  availability;
- every retailer has its own Dina;
- retailer Dinas discover suppliers, request current information, compare
  alternatives, and eventually place orders;
- supplier Dinas need to answer even when the business owner is sleeping.

This use case made the server requirement concrete. An always-on Dina is not
only for personal reminders or agents; it can act as a continuously available
service provider for a business.

### Stage 3: We rejected turning Dina into a retail application

The immediate concern was strategic:

> Dina should support this use case, but Dina should not become only a retail
> or FMCG product.

That changed the framing. Commerce could not be implemented by adding retailer,
manufacturer, product, quote, and order branches throughout Dina Core and its
mobile screens.

The platform needed to remain useful for unrelated domains such as schools,
clinics, local services, personal agents, corporate agents, coordination, and
future developer-built extensions.

The generic managed runtime also had to remain generic. Commerce could justify
building it, but not own its architecture.

### Stage 4: We considered using Dina's plugin architecture

The next question was whether the retail behavior should be a plugin, since
Dina already has a generic plugin architecture under development.

The answer was broadly yes, with an important qualification:

- the commerce-specific schemas, calculations, connectors, cards, and
  workflows belong outside Core;
- Dina's existing identity, vault, Services, D2D, approval, workflow, review,
  and hosting primitives should be reused rather than rebuilt inside the
  plugin;
- Core must remain the authority for signing, approvals, context projection,
  transport, publication, and effect lifecycle;
- the plugin proposes and executes bounded domain work but does not become a
  second authority system.

This is where the concept became an optional **Commerce Pack built on Dina**,
instead of **Dina rebuilt as a commerce application**.

### Stage 5: We rejected Retailer and Manufacturer as plugin boundaries

The first intuitive plugin names were Retailer and Manufacturer. They were
rejected because they describe industries, not workflow authority:

- a distributor both buys and sells;
- a manufacturer buys raw material;
- a retailer can also supply another buyer;
- a school, restaurant, hospital, or person can buy;
- a farm, cooperative, wholesaler, or retailer can supply.

The more reusable split is therefore:

- **Buyer plugin** for discovery, quotes, comparison, and purchase proposals;
- **Supplier plugin** for catalogs, quotes, order acceptance, and status.

A Business Dina can install either or both under separate consent.

### Stage 6: We separated products from services

The next scalability question was whether every product should be published as
a Dina service.

That was rejected. A supplier with thousands of products should not create
thousands of service listings.

The resulting rule is:

> Products are catalog data. Actions a supplier's Dina can perform are
> services.

Public catalog snapshots support product discovery. A small set of service
capabilities handles live catalog search, private quotes, approved orders,
cancellation, and order status.

### Stage 7: We separated public discovery from private commercial truth

Public search is useful for finding candidate products and suppliers, but it
cannot safely carry every buyer's negotiated terms, exact location, current
stock, or legally meaningful order state.

The design therefore became two-stage:

1. A commerce AppView indexes supplier-signed public catalog snapshots.
2. Buyer and Supplier Dinas exchange current, audience-bound quotes and orders
   privately through Dina Services and D2D workflows.

The AppView finds candidates. The supplier Dina remains authoritative for live
terms and acceptance.

### Stage 8: We kept the protocol open beyond the reference plugins

Finally, the plugin was identified as the easiest product path, not a mandatory
gateway.

A small supplier can use Dina's managed no-code Supplier runner. A larger
supplier may use a self-hosted runner or ERP connector. An existing platform
may implement the same open catalog, quote, and order contracts directly.

The final architecture therefore has three layers:

1. **Dina platform:** generic identity, privacy, authority, transport,
   workflows, reviews, and hosting.
2. **Commerce protocol and reference pack:** Buyer/Supplier behavior,
   canonical schemas, deterministic comparison, cards, and connectors.
3. **Independent implementations:** external supplier systems that implement
   the same contracts without being forced to use Dina's reference plugin.

### What changed and what did not

What changed:

- a generic always-on server question gained a concrete commerce use case;
- the commerce behavior moved into a plugin pack;
- retailer/manufacturer roles became buyer/supplier roles;
- product discovery became a catalog/AppView concern;
- live terms and orders remained private service workflows.

What did not change:

- Dina remains a general platform;
- Core remains the authority boundary;
- each person or business controls its own Dina identity and policy;
- the managed runtime remains domain-neutral;
- Services, D2D, approvals, plugins, reviews, and private context continue to
  support many domains beyond commerce.

## 2. The Real-World Scenario

The motivating example is a business network containing manufacturers,
distributors, and retailers.

1. Suppliers publish the products they offer, their service capabilities, and
   the regions they serve.
2. A buyer asks their Dina for products using ordinary language.
3. The buyer's Dina searches relevant suppliers.
4. It privately requests current prices, stock, quantities, and delivery terms.
5. It compares valid offers using the buyer's own preferences and business
   context.
6. It prepares an order.
7. The buyer approves the exact order, unless a narrow standing policy already
   permits it.
8. The supplier accepts, rejects, or proposes different terms.

The Dina belonging to a manufacturer, distributor, or retailer may need to run
on a server so it can answer while its owner's phone is unavailable.

## 3. The Strategic Constraint

Dina must not become only a retail application.

Dina's general platform is intended to provide:

- identity;
- encrypted vaults and private context;
- agent and plugin safety;
- approvals and constrained grants;
- Dina-to-Dina communication;
- service publication and discovery;
- reviews and trust evidence;
- durable workflows;
- mobile, self-hosted, and managed operation.

Commerce should prove that these primitives can support a serious domain. It
should not redefine the platform around that domain.

The same platform should still support schools, clinics, local services,
personal agents, corporate agents, games, coordination, and future plugin
families.

## 4. Proposed Product Structure

### 4.1 One Commerce Pack

Users see one optional Commerce Pack in the Dina marketplace.

During setup they choose:

- **Buy from suppliers**
- **Sell to buyers**
- **Both**

Choosing both creates two separately authorized installations. It does not
create one plugin with every permission.

### 4.2 Buyer Plugin

The Buyer plugin can:

- turn a buying request into structured requirements;
- search proof-bound supplier catalogs;
- request live quotes from selected suppliers;
- normalize and compare valid offers;
- prepare an exact order proposal;
- track orders and purchase history.

It cannot publish a supplier catalog or accept customer orders unless the
Supplier plugin is separately installed.

### 4.3 Supplier Plugin

The Supplier plugin can:

- import or maintain a product catalog;
- publish supplier services and public catalog information;
- answer private quote requests;
- apply customer-specific terms;
- receive orders;
- accept, reject, or counter them;
- provide order and fulfilment status.

It cannot read buyer preferences or act as a buyer merely because it is
installed.

### 4.4 Optional Connectors

A supplier may keep its real data in:

- a CSV file;
- a spreadsheet;
- Dina's managed catalog store;
- an ERP or inventory system;
- a custom business API.

Networked connectors should be separately scoped. A single Supplier release
should not receive credentials or network permission for every possible ERP.

## 5. Why the Roles Are Buyer and Supplier

The plugins should not be named Retailer and Manufacturer.

Those labels do not describe authority accurately:

- a distributor buys and sells;
- a retailer may sell to another business;
- a manufacturer buys raw material;
- a restaurant, hospital, or school may be a buyer;
- a cooperative or farm may be a supplier.

Buyer and Supplier describe what the Dina is doing in a particular workflow.
The same Business Dina may install both.

## 6. The Important Data/Service Split

### Products are data

A supplier may have tens of thousands of products. Creating one Dina service
listing for every product would be expensive, noisy, difficult to update, and
hard to search.

The supplier should therefore publish a signed catalog snapshot containing
product and variant data.

### Commercial actions are services

The supplier publishes a small number of capabilities, such as:

- search this supplier's catalog;
- request a current quote;
- submit an approved order;
- cancel an order;
- check order status.

In short:

> Products are catalog data. Things a supplier's Dina can do are services.

## 7. Public Discovery Versus Private Transactions

The design deliberately separates two stages.

### Public discovery

A commerce AppView indexes signed catalog snapshots and returns candidate
products and suppliers.

Public discovery may contain:

- product identity and description;
- pack size;
- broad delivery region;
- indicative price, if the supplier chooses;
- catalog freshness;
- the supplier service reference.

It must not claim that public data is current contractual stock or pricing.

### Private transaction

The buyer then contacts a bounded number of supplier Dinas privately.

Private responses can contain:

- current stock;
- exact quantity;
- customer-specific price;
- discount and tax;
- delivery terms;
- credit terms;
- quote expiry;
- order acknowledgement.

The public index helps the buyer find candidates. The supplier's authenticated
Dina remains authoritative for the live quote and order.

## 8. Authority Boundary

The plugin performs domain work, but it does not become Dina's authority.

### Plugins may

- parse commerce requests;
- validate commerce schemas;
- normalize products and units;
- calculate and compare offers deterministically;
- propose catalog publications, quotes, and orders;
- talk to a separately consented business backend.

### Dina Core must retain

- identity and signing keys;
- vault access and private-context projection;
- plugin consent and grants;
- staff and organization authority;
- approval decisions;
- D2D sending;
- public repository publication;
- durable workflow state;
- idempotency and ambiguous-outcome handling;
- audit receipts.

The Supplier plugin, for example, can produce a candidate quote. Supplier Core
validates it and sends it as the supplier's authenticated response.

The plugin never receives the Business Dina's identity key.

## 9. Why Runner Plugins, Not Interpreted Plugins

Commerce needs:

- deterministic money and unit calculations;
- structured catalog processing;
- external business connectors;
- durable quote and order workflows;
- strict idempotency;
- reconciliation after uncertain external effects.

That is runner-plugin work. Dina's interpreted plugin mode is intentionally
more restricted and is not the correct execution model for procurement.

This does not require a complicated user experience. A small supplier can use
a managed Supplier runner and upload a CSV or spreadsheet without writing
code.

## 10. Why Dina Core Should Not Contain Commerce Logic

Adding products, quotes, taxes, orders, and supplier rules directly to Core
would cause several problems:

- every new industry would require another Core rewrite;
- mobile, web, and Home Node behavior could drift;
- security review of Core would expand with every vertical;
- organizations could not replace the reference commerce implementation;
- Dina would gradually become a centralized marketplace product.

Instead, Core should expose generic typed extension operations. The trusted
Commerce adapter validates commerce payloads, while generic Core still owns
authority and lifecycle.

Core should see:

> Run this validated extension operation for this install under this authority.

It should not contain logic such as:

> If this is a purchase order, use a special commerce branch.

## 11. Shared-Code Requirement

There must be one implementation of every important commerce rule.

Shared code should own:

- schemas;
- canonical hashes;
- money and quantity arithmetic;
- product identity;
- quote and order validation;
- legal order-state transitions;
- deterministic comparison;
- Core commands and read projections;
- conformance test vectors.

Mobile and web clients should send the same commands and render the same
Core-owned projections or CardSpec results. They must not independently decide
whether an order is approved, valid, current, or complete.

## 12. Managed Server Decision

Some business Dinas need to answer continuously. The solution should be a
generic managed Dina runtime, not a special retail server.

The managed runtime can host:

- a supplier Dina;
- a buyer Dina;
- a school Dina;
- a clinic Dina;
- a personal Dina;
- another plugin family.

Commerce adds a reason to build managed hosting, but it does not define the
hosting architecture.

Each hosted Dina still needs isolated:

- identity authority;
- encrypted storage;
- grants and approvals;
- workflows;
- plugin installations;
- credentials;
- private logs.

Shared infrastructure may provide search, messaging, supervision, metering,
backup, and stateless reasoning, but it must not collapse tenant authority.

## 13. Why Existing Supplier Systems Do Not Have to Use the Plugin

The reference Supplier plugin makes implementation easy for Dina users.

It should not become a protocol monopoly. An existing supplier system may
implement the same catalog, quote, order, identity, and service contracts
directly. Buyers should observe the same wire behavior regardless of whether
the supplier uses:

- Dina's managed Supplier plugin;
- a self-hosted Supplier plugin;
- an ERP-specific connector;
- a third-party compatible service.

The plugin is a reference implementation and product experience, not a toll
gate.

## 14. Alternatives Considered

### Alternative A: Put commerce directly in Dina Core

**Advantage:** fastest way to build one tightly integrated prototype.

**Why not selected:** makes Dina domain-specific, enlarges the authority core,
and does not scale to other verticals.

### Alternative B: Build one combined commerce plugin

**Advantage:** one installation and one code package.

**Why not selected:** a buyer would consent to supplier publication and order
acceptance permissions; a supplier would receive unnecessary buyer context.
This violates least privilege.

### Alternative C: Build Retailer and Manufacturer plugins

**Advantage:** familiar labels for the first business scenario.

**Why not selected:** real organizations frequently perform both roles, and
distributors do not fit either label cleanly.

### Alternative D: Publish every product as a Dina service

**Advantage:** reuses the existing Services directory without a new catalog
index.

**Why not selected:** service count, update volume, search quality, and product
identity become unmanageable at realistic catalog sizes.

### Alternative E: Build a separate centralized Dina marketplace

**Advantage:** operationally simpler search, ranking, accounts, and payments.

**Why not selected:** turns Dina into the marketplace owner and creates one
central authority over discovery and participation.

### Alternative F: Define only a protocol, with no reference plugins

**Advantage:** smallest Dina implementation and maximum theoretical openness.

**Why not selected:** adoption would require every small supplier and buyer to
build software before receiving value.

### Alternative G: Use only interpreted/no-code services

**Advantage:** very simple supplier onboarding.

**Why not selected:** insufficient for deterministic arithmetic, connectors,
effect idempotency, and durable order workflows. The no-code experience should
run on a managed deterministic runner instead.

## 15. Important Safety Decisions

- No payment rail in v1.
- An LLM may parse and explain, but it does not calculate authoritative totals.
- Public catalog price is indicative unless a private quote confirms it.
- Approval binds the exact supplier, items, quantities, destination, price,
  terms, quote digest, and plugin authority.
- A changed quote requires a new approval.
- Order retry is disabled unless the real supplier effect boundary proves
  durable idempotency.
- If an external order may have happened but Dina cannot prove the result, the
  state is `outcome_unknown`, not success or failure.
- A plugin cannot sign as the business or approve its own effect.
- Pausing or uninstalling a plugin cannot silently delete commercial receipts.

## 16. What Exists Today

Dina already has useful foundations:

- DID identity;
- Services publication and discovery;
- public, unlisted, and approved-only service visibility;
- D2D transport;
- service schema hashes and response validation;
- workflow tasks, claims, leases, and approvals;
- plugin protocol, persistence, grants, and runner execution substrate;
- CardSpec rendering;
- Ranked Reviews and AppView infrastructure;
- mobile and Home Node clients.

However, this commerce flow is not currently implemented end to end.

Important general plugin gaps still include:

- production plugin installation and consent UI;
- repository-proof verification journey;
- runner pairing orchestration;
- Core-owned context projection and dispatch production;
- complete approval/result UI;
- plugin SDK and developer workflow.

Commerce additionally needs:

- commerce schemas and conformance vectors;
- Buyer and Supplier runners;
- catalog snapshots and AppView indexing;
- typed Core extension operations;
- organization/staff authority;
- connector credential brokering;
- quote and order reconciliation UI;
- generic managed Dina hosting.

## 17. Recommended First Validation

Do not start with a universal FMCG marketplace.

Use a deliberately small pilot:

- 3-5 suppliers;
- 5-15 buyers;
- one geographical region;
- one or two product categories;
- CSV or managed catalog import;
- direct supplier references before public catalog search;
- quote request, comparison, approval, order, acknowledgement, and status.

The architecture is validated when:

1. a real buyer asks for goods;
2. at least two supplier Dinas return live structured quotes;
3. the buyer sees a deterministic comparison;
4. the buyer approves one exact order;
5. the supplier accepts it;
6. both Dinas preserve matching receipts across restart;
7. duplicate delivery or retry cannot create a second order;
8. revoking the Supplier plugin prevents further answers and completions.

## 18. Main Risks and Unresolved Decisions

The proposed boundary is clear, but these questions remain open:

1. Is a commerce AppView the right public catalog mechanism, or should catalog
   discovery use another open indexing standard?
2. What product identifier and category vocabularies should v1 support?
3. What minimum organization/staff authority model is required for the pilot?
4. Should quoting reserve stock, and how should reservation expiry work?
5. What exact order action is legally meaningful in the first jurisdiction?
6. How should managed tenant encryption, export, backup, and recovery work?
7. Which connector should follow CSV first?
8. How should plural AppViews merge or expose competing retrieval results?
9. Which commerce capabilities should eventually become official Dina
   capabilities rather than namespaced custom ones?
10. Is the trusted vertical-adapter seam sufficiently generic for other
    vertical packs without turning Core into a plugin-code host?

## 19. Questions for an Independent Architecture Reviewer

An independent reviewer should answer these rather than merely checking the
prose:

1. Is Commerce Pack the correct architectural seam, or should commerce live
   elsewhere?
2. Are Buyer and Supplier the right least-privilege split?
3. Does separating catalog data from service capabilities scale correctly?
4. Is the public-catalog/private-quote split sound?
5. Does the design keep Dina Core generic in practice, not only in wording?
6. Is the trusted Core adapter a safe extension mechanism, or does it create a
   second plugin system?
7. Can third-party supplier implementations interoperate without adopting
   Dina's reference plugin?
8. Are organization identity and staff authority underspecified?
9. Are approval, idempotency, and `outcome_unknown` boundaries sufficient for
   real orders?
10. Is the managed-runtime direction scalable and economically plausible?
11. Which requirements are unnecessary for the first pilot?
12. Which missing requirement would cause a later architectural rewrite?
13. Is there a simpler design that preserves openness, safety, and platform
    neutrality?

## 20. Suggested Review Prompt

The following can be given to another AI together with this memo and, if
needed, the detailed design:

> Review this decision as a skeptical distributed-systems, marketplace, plugin
> security, and B2B procurement architect. Do not assume the recommendation is
> correct. Identify architectural contradictions, unnecessary machinery,
> missing authority or data-lifecycle boundaries, scalability failures, and
> alternatives that would be materially simpler. Separate launch blockers
> from later hardening. Conclude with: accept, accept with changes, or reject,
> and explain the smallest architecture you would implement for the pilot.

## 21. Decision Summary

The proposed decision is:

> Keep Dina general. Build commerce as an optional pack with separate Buyer and
> Supplier runner plugins, a shared open protocol, proof-bound catalog
> discovery, private service-based quotes and orders, deterministic comparison,
> and Core-owned identity and approval authority. Use commerce to validate
> Dina's platform, not to redefine Dina as a retail marketplace.
