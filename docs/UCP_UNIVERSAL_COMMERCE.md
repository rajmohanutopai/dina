# UCP (Universal Commerce Protocol) and Dina

**Status:** Assessment and design. Nothing is built. No UCP code exists in the repo.
**Date:** 2026-09-27.
**Spec pin:** UCP **v2026-08-25** (latest release). Google's live checkout still targets **v2026-04-08**; a buyer adapter must speak both (§6.9).
**Related:** `docs/AP2_AGENT_PAYMENTS.md` (UCP's payment-mandate extension), `docs/A2A_IMPLEMENTATION_PLAN.md` (UCP has an A2A binding), `docs/COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md` (Dina's own commerce protocol), `docs/TRADE_FIRST_STRATEGY.md`, `docs/JIFFY_MERCHANT_INTEGRATION_PLAN.md`, `packages/commerce-protocol/docs/conformance.md`.

---

## 1. Summary

UCP is a standard way for a shopping agent (UCP calls it the **Platform**) to find a merchant (the **Business**), browse its catalog, build a cart, check out and follow the order. Google announced it at NRF on 2026-01-11 with Shopify, Etsy, Wayfair, Target and Walmart. Amazon, Microsoft, Meta, Salesforce and Stripe have since joined its council. Google's AI Mode and Gemini run checkout on it.

Dina could speak UCP in two directions:

| Direction | Who benefits | Fit | Recommendation |
|---|---|---|---|
| **Dina as Platform** (a person's Dina shops at UCP merchants) | Consumer Dina | Good. UCP's default ending, handing checkout to "a trusted and deterministic UI for the user to review … and place the order", is Cart Handover by another name. | **Build, in phases (§8).** Start with read-only catalog search, then carts that end in a hand-off. |
| **Dina as Business** (a Dina supplier sells through UCP) | A Dina supplier selling to consumers | Weak for trade-first. UCP has no quote, no negotiation, no purchase order, no invoice, no tax ID, and credit terms need a funding instrument. Google's surfaces need Merchant Center, Google Pay and a waitlist. | **Wait** for a supplier that sells to consumers and asks for it. A connector-backed merchant (the Jiffy pattern) is the likely first case. |

UCP adds nothing to trade between Dina nodes. That trade already has signed quotes, orders, negotiation, delivery and payment notes over the sealed relay. UCP would connect Dina to the rest of online retail; Dina's own trade protocol stays as it is.

Things to weigh:

- **Governance is Google's.** Google and Shopify hold the only permanent council seats, and Google holds the proxy vote for every open seat until December 2028. Google holds the domain and requires its own contributor licence. There is no neutral foundation.
- **It changes fast.** v2026-08-25 broke many fields (fulfilment, buyer consent, payment extensions renamed, signing keys moved to `keys[]`). Google production lags a release behind.
- **It needs a public web presence.** A Platform must publish a profile at a stable public HTTPS URL. To receive order updates it must also expose a public webhook. A phone-only Dina has neither (§6.3).

---

## 2. UCP in one page

### 2.1 Roles

**Platform** (the agent or app; UCP's examples include "B2B Procurement Systems"), **Business** (normally the merchant of record; examples include "Suppliers, Distributors"), **Credential Provider** (wallets, identity providers), **Payment Service Provider**. Roles "are defined by direction of capability flow" and apply to consumer, business and agent-to-agent commerce alike.

### 2.2 Services, capabilities, extensions

- A **service** is a vertical's API surface, e.g. `dev.ucp.shopping`. Each has **transport bindings**: REST (OpenAPI 3), MCP (OpenRPC), A2A (Agent Card), embedded (OpenRPC).
- A **capability** is a feature within it, named `{reverse-domain}.{service}.{capability}` and pointing at a JSON Schema. `dev.ucp.*` is reserved for the UCP council; vendors use their own domain. The schema URL's host must match the name's domain ("provenance, not trust").
- An **extension** is a capability that `extends` another and composes with `allOf`.

Standard capabilities on main:

| Kind | Names |
|---|---|
| Shopping | `dev.ucp.shopping.catalog.search`, `.catalog.lookup`, `.cart`, `.checkout`, `.order`, `.permalink` |
| Shopping extensions | `dev.ucp.shopping.fulfillment`, `.discount`, `.buyer_consent` |
| Common | `dev.ucp.common.identity_linking`, `.location.search`, `.location.lookup`, `.loyalty` |
| Payment extensions | `dev.ucp.common.payment.ap2_mandate`, `.terms`, `.split_payments`, `.authentication` (3-D Secure) |

### 2.3 Discovery and negotiation

- A Business serves its profile at **`/.well-known/ucp`**: `ucp.version`, `ucp.services`, `ucp.payment_handlers` (both registries required, may be empty), optional `capabilities`, `supported_versions`, and a top-level `keys[]` JWK set.
- A Platform publishes its own profile at any HTTPS URL and names it on every request: `UCP-Agent: profile="https://…"` (MCP: `meta["ucp-agent"].profile`).
- The Business fetches the Platform profile, intersects capabilities (highest shared version, drop orphaned extensions) and reports the result in every response. Errors: `invalid_profile_url`, `profile_unreachable`, `profile_malformed`, `version_unsupported`, `capabilities_incompatible`.
- Profile hosting rules: HTTPS, no redirects, `Cache-Control: public, max-age>=60`, no per-session data, fetchers refuse private and loopback addresses.
- UCP calls this "permissionless onboarding": any Platform with a profile can talk to any Business. Businesses "should" still keep a list of approved Platforms.

### 2.4 Checkout

`dev.ucp.shopping.checkout`. REST: `POST /checkout-sessions`, `GET` and `PUT /checkout-sessions/{id}`, `POST …/{id}/complete`, `POST …/{id}/cancel`. MCP: `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout`.

- Required fields: `ucp, id, line_items, status, currency, totals, links`. `payment` is optional until **complete**, where it is required. Amounts are integer minor units. `buyer` is `first_name, last_name, email, phone_number` only.
- `status`: `incomplete` → `requires_escalation` (hand to the person via `continue_url`) → `ready_for_complete` → `complete_in_progress` → `completed` (carries `order.id`, `order.permalink_url`); `canceled` from anywhere.
- **"The checkout has to be finalized manually by the user through a trusted UI unless the AP2 Mandates extension is supported."**
- The Business must send a confirmation email and its checkout logic must be deterministic.

### 2.5 Catalog, cart, order

- **Catalog:** `POST /catalog/search`, `/catalog/lookup`, `/catalog/product` (MCP `search_catalog`, `lookup_catalog`, `get_product`). Products, variants, prices, `quantity_unit` in UN/CEFACT Rec 20 codes (`C62` = each, `KGM`, `LTR` …). Answers "are not transactional commitments — checkout is authoritative". No bulk feed.
- **Cart:** `/carts` create, get, update, cancel; converts to a checkout by `cart_id`.
- **Order:** pull with `GET /orders/{id}`; push with an **order-event webhook** POSTed to the Platform's `webhook_url` (signed; full order each time; the Business must send "order created" and retry). MCP has no push. Orders carry fulfilment events and `adjustments` (refund, return, credit, dispute, cancellation). There is no returns capability and no order editing.

### 2.6 Identity linking

OAuth 2.0 authorization code with PKCE (S256), discovered through RFC 9728 and RFC 8414 metadata. On-device agents are public clients (no secret). Access is public, agent-authenticated, or user-authenticated. An accelerated flow exchanges a token (RFC 8693) for a JWT grant (RFC 7523). The Platform must revoke tokens (RFC 7009) when the person unlinks.

### 2.7 Payments

A **payment handler** (e.g. `com.google.pay`, `dev.shopify.shop_pay`) is a specification written by a credential provider. The Business configures it; the Platform runs it to get an opaque credential; the Business charges through its own processor. "UCP defines the shared declaration structure but currently no concrete handler." The Business is always merchant of record. `dev.ucp.common.payment.terms` can express "Net-30 alongside pay-now", but the funding instrument "is charged once for each of that term's schedules", and a Platform must not assume a deferred payment can be managed through UCP. AP2 mandates are an optional extension (see the AP2 doc).

### 2.8 Security

- Platform authentication: API key, OAuth client credentials, mTLS, or **RFC 9421 HTTP Message Signatures** (the only one that allows permissionless onboarding). The authenticated identity must match `UCP-Agent`.
- Signatures: **ES256 verification is mandatory**; ES384 and Ed25519 optional. Keys are JWKs in the profile's `keys[]`. Body digest is RFC 9530 `Content-Digest` over raw bytes.
- Idempotency is the replay defence: keys of at least 128 bits, stored at least 24 hours, same body → cached response, different body → 409; if storage fails, 503.
- Webhooks must be signed by the Business with a profile key.

### 2.9 Transports

- **REST**: JSON, TLS 1.3, headers `UCP-Agent`, `Idempotency-Key`, `Signature-Input`/`Signature`/`Content-Digest`.
- **MCP**: 13 tools, 1:1 with capabilities; `complete_checkout` and `cancel_checkout` need `meta["idempotency-key"]`; Streamable HTTP so signatures apply.
- **A2A**: checkout only. Extension URI `https://ucp.dev/{version}/specification/reference`; DataPart keys `a2a.ucp.checkout`, `a2a.ucp.checkout.payment`, `a2a.ucp.checkout.signals`. It uses the A2A v0.3 header `X-A2A-Extensions`, which a strict A2A v1.0 peer may ignore (A2A v1.0 renamed it `A2A-Extensions`).

---

## 3. UCP and Dina's commerce protocol side by side

| Concern | UCP | Dina (`@dina/commerce-protocol`) |
|---|---|---|
| Parties | Platform ↔ Business over HTTPS | Buyer node ↔ supplier node over the sealed relay (D2D `service.query`) |
| Identity | Domain + profile `keys[]` (JWK) | `did:plc` + Ed25519 root key; D2D envelopes signed and sealed |
| Discovery | `/.well-known/ucp` per origin; no directory | `com.dinakernel.service.profile` records on the PDS, indexed by AppView; trust-ranked by PeerLens |
| Catalog | Live `catalog.search` / `lookup` | Published `CatalogSnapshot` / `CatalogPointer`; AppView `searchCatalog` |
| Price | The Business's checkout totals | `SignedQuote` answering a `QuoteRequest`, with revisions and counter-offers |
| Negotiation | None (proposals #738, #845 open) | `CounterOffer`, floors, tenders, `QuoteOutcomeNotice` |
| Commitment | `complete_checkout` | `PurchaseOrderProposal` → `OrderAcknowledgement` |
| Order status | Order snapshot + signed webhook | `CommerceOrderStatus` chain |
| Fulfilment | Order `fulfillment.events` | `DeliveryNote` / `DeliveryReceipt`; connector `fulfilment_evidence` |
| Payment | Handler credential charged by the Business | Outside Dina; `PaymentNote` / `PaymentAcknowledgement` record it (khata) |
| Credit terms | `payment.terms`, but instrument-funded | `payment_terms.credit_days`, `due_basis`; dues derived |
| Hand-off to the person | `requires_escalation` + `continue_url` | `checkout_handoff` attachment → owner card → open URL |
| Money shape | Integer minor units | String minor units |
| Units | UN/CEFACT Rec 20 (`C62`, `KGM`, `LTR`, …) | Closed vocabulary `each`, `case`, `pallet`, `g`, `kg`, `ml`, `l` |
| Tax | Not modelled (payer tax ID is issue #742) | Tax registrations in `trade_identity.ts`; India pack GSTIN check |
| Signing | RFC 9421 request signatures; detached JWS (ES256) for AP2 | SHA-256 domain digests; Ed25519 envelope signature |
| Replay | `Idempotency-Key` | `idempotency_key` in records; supplier admission replays by order id |

The shapes line up well at the edges (catalog, order status, hand-off) and diverge in the middle: UCP prices at the merchant's word inside a session; Dina prices by a signed quote that can be negotiated and is committed by a separate order.

---

## 4. Dina as Platform: the design

### 4.1 Where the code lives

Core "never calls external APIs" in the ordinary sense, and Brain "holds no keys". UCP needs both: HTTP calls to merchants, and requests signed with the node's key. Dina already has the pattern: commerce connectors call outside systems through a **host-injected transport under a network policy** (`apps/home-node-lite/core-server/src/commerce/connector_transport.ts`, `packages/core/src/commerce/catalog_feed_policy.ts`, `fetchUnderPolicy` in `catalog_ingest.ts`). The UCP client follows it:

| Piece | Lives in | Why |
|---|---|---|
| UCP wire types, validators, capability intersection, Rec 20 ↔ Dina unit map | New pure package **`@dina/ucp`** (zero runtime deps, like `@dina/commerce-protocol`) | Reusable by server, phone and AppView; testable with frozen vectors |
| Profile, keys, RFC 9421 signing, idempotency keys, checkout state, stored orders | **Core** (`packages/core/src/commerce/ucp/*`) with a host transport | Keys and money-adjacent state stay in compiled code |
| HTTP transport with SSRF, TLS and no-redirect policy | Host (`core-server`, mobile) | Same policy object as the connectors |
| Search, compare, build a cart, explain | **Brain** tools calling Core routes | Brain reasons; it never signs and never completes |
| Review and hand-off | A **Core-minted** card type (added to `CORE_MINTED_PAYLOAD_TYPES`) | Brain can neither create nor decide it |

### 4.2 Keys and the Platform profile

- One **P-256 key** at `m/9999'/5'/{generation}'` (the AP2 doc §6.1 defines it). ES256 is the only algorithm every Business must verify, so Ed25519 alone would not do.
- The Platform profile is a small public JSON: `ucp.version`, `services` (the transports Dina speaks), `capabilities` (what Dina supports, including `dev.ucp.shopping.order` with `config.webhook_url` when a webhook exists), `payment_handlers` (empty until AP2), and `keys[]`.
- It contains no personal data. It does identify one Dina to every merchant it talks to, so merchants can link its visits. §6.4 covers that.

### 4.3 Hosting the profile and the webhook

| Node | Profile | Order updates |
|---|---|---|
| Server Home Node with a public domain | Served by Core at a fixed path | Webhook to Core |
| Phone, or a server behind NAT | **Open question (§9).** Candidates: a static profile on a Dina-run HTTPS host keyed by DID, with the profile URL listed in the DID document so a host cannot swap keys unnoticed; or the person's own domain. | **Pull.** Poll `GET /orders/{id}` while an order is open. No public endpoint needed. |

Recommend pull for every node in the first phases. Webhooks through a relay would make order contents visible to the relay (TLS ends there), which the sealed-relay design avoids everywhere else.

### 4.4 Flow: search to hand-off

1. **Find merchants.** UCP has no directory. Sources: merchants the person names; merchants in PeerLens (AppView could index UCP profiles the way the A2A plan's directory indexes Agent Cards, §8 phase 5); merchants reached through links. Dina fetches `/.well-known/ucp` under the network policy, validates it, and caches it as the rules allow.
2. **Search.** Brain calls `catalog.search` / `lookup` through Core. Results are "not transactional commitments". Brain ranks by PeerLens trust, not by the merchant's own words (Verified Truth), and builds the usual comparison card.
3. **Cart and checkout.** When the person picks items, Core creates a cart or checkout session, signed, with an `Idempotency-Key` it stores. `buyer` fields are filled only from what the person approved for this merchant, through the egress gate (§6.4).
4. **Review.** Core raises a Core-minted card rendered from the merchant's checkout response: items, quantities, fulfilment choice, totals, policies (return, warranty), `expires_at`.
5. **Hand-off.** On yes, Dina opens the merchant's `continue_url` (the phone opens it; a server node sends it to the paired phone). The person pays on the merchant's page. **This is Cart Handover.**
6. **Follow.** Core polls the order by id until terminal and writes a purchase record to the vault. Delivery events appear in the person's timeline; nothing is pushed unless it matters (Silence First).

No step lets Brain sign, complete a checkout, or see a payment credential. `complete_checkout` is not called at all until AP2 is adopted (AP2 doc, D1).

### 4.5 Identity linking

Some merchants gate prices or checkout behind a linked account. Dina acts as a public OAuth client with PKCE. Tokens go in Core's credential store (`commerce_credentials`, released only through `useSecret`), never to Brain. Unlinking revokes the token (RFC 7009) and deletes it. The consent screen is the merchant's, opened on the phone.

### 4.6 What Dina refuses

- Any response that carries or asks for a raw card number.
- `complete_checkout` without AP2 (none in these phases).
- Merchants whose schema URLs fail the authority rule, whose profiles redirect, or who resolve to private addresses.
- Anything a merchant returns that would turn into an instruction to Brain: product text is data, scanned by the guard like any other outside text (the AP2 doc's "whisper" attack applies to catalogs as much as to payments).

---

## 5. Dina as Business: the design, when wanted

### 5.1 What it would take

- A public HTTPS origin the supplier controls, serving `/.well-known/ucp`, TLS 1.3, cache headers. That means a server Home Node or managed hosting; a phone cannot be a UCP Business.
- Catalog search and lookup answered from the supplier's published catalog.
- Checkout sessions answered by Dina's pricing: a checkout session maps onto a held quote; `complete_checkout` onto an order the supplier's runner accepts (`order_decision.ts`). Totals come from the supplier's signed quote arithmetic, so UCP totals and Dina totals cannot drift.
- Payment through the supplier's own processor. The connector pattern already exists: the checkout returns `requires_escalation` with the connector's checkout URL as `continue_url` (today's `checkout_handoff`), and the connector's `payment_evidence` settles it.
- Signed order webhooks from the order status chain, with retries.
- A confirmation email, which UCP requires and Dina cannot send itself: the connector sends it.
- For Google's surfaces: Merchant Center, a Google Pay-capable processor, and a place off the waitlist.

### 5.2 What does not fit

- **Quotes and negotiation.** UCP has no request-for-quote, no counter-offer, no quote revision. Watch #845 ("accepted commercial term handoff into cart/checkout") and #738 / PR #773 ("state-bound offer").
- **Credit and invoices.** Net-30 must be funded by an instrument charged per schedule; a khata-style running account has no place. Watch #641 (out-of-session settlement, `order.payment_status`).
- **Tax.** No GSTIN or payer tax ID (#742). No invoice document.
- **Units.** Rec 20 has no exact match for Dina's `case` and `pallet`, which need pack evidence to convert.

So the Business side suits a Dina supplier that sells finished goods to consumers at list price. It does not suit the distributor trade Dina is built around, until the proposals above land.

### 5.3 The likely first case

A supplier whose sales already run through a connector (the Jiffy integration: catalogue refresh, order export, checkout hand-off, payment evidence). The connector holds the processor account and sends the email; Dina supplies the catalog, the pricing, the order record and the trust profile. Neither side builds a web store.

---

## 6. Cross-cutting design points

### 6.1 Money and units

UCP amounts are integers; Dina's are strings. Convert at the adapter edge with exact integer checks, never floats. Map units through a table in `@dina/ucp`: `each`↔`C62`, `g`↔`GRM`, `kg`↔`KGM`, `ml`↔`MLT`, `l`↔`LTR`; refuse the rest.

### 6.2 Idempotency

Core generates a 128-bit key per mutating request, stores it with the request body hash before sending, and reuses it on retry. This is the same discipline as `PurchaseOrderProposal.idempotency_key` and the provider-ingress keys.

### 6.3 Public endpoints

Discussed in §4.3. The profile is the hard requirement; order webhooks are optional because pull works.

### 6.4 Privacy

- **What the merchant learns.** The Platform profile identifies one Dina across merchants. Options: one profile per node (simple, linkable) or a profile per merchant (unlinkable, more keys to host). Start with one and note the cost; revisit before a public launch.
- **Buyer fields.** Name, email and phone go only to a merchant the person is buying from, only after the review card, and through Core's egress gate. Search sends no buyer data.
- **Compared with shopping through Google.** When a person shops through Google AI Mode, Google keeps order data "indefinitely until the user explicitly requests deletion". Dina talking to the merchant directly keeps Google out of the loop.

### 6.5 Trust

UCP proves provenance, not trust. Merchant ranking, warnings and the review card's trust line come from PeerLens. A UCP merchant with no PeerLens record is shown as unverified.

### 6.6 Transport choice

Dina as Platform speaks **REST** first (every Business must offer a binding, and REST is the one Google's guides use), MCP second. The A2A binding covers checkout only and uses a header A2A v1.0 renamed; skip it until the A2A outbound lane exists (A2A plan).

### 6.7 Relation to AP2

Without AP2, UCP checkouts end in a hand-off. With AP2 (human present, wallet-signed), Dina could complete checkouts itself; that needs the owner decisions in the AP2 doc (D1).

### 6.8 Relation to A2A

Independent. UCP's A2A binding is one transport among four. The A2A directory (Lane 3) and a UCP merchant index could share AppView machinery.

### 6.9 Versions

A Platform declares one `ucp.version` and may list older ones in `supported_versions`. Speak **2026-08-25** and **2026-04-08** (Google's production), pin every schema by URL and hash, and treat an unknown version as `version_unsupported` with a fallback to `continue_url`.

---

## 7. India

- UCP's roadmap names India with no date. The spec has no UPI handler, no RuPay, no GST. A community `com.razorpay.upi` handler was proposed (issue #308) and never pushed; it describes UPI collect, which NPCI has been phasing out (unverified).
- Flipkart endorses UCP. On 2026-09-26 TechCrunch reported Google testing a Flipkart buy button in Gemini and AI Mode in India, with a Flipkart-branded checkout. Whether UCP powers it is unconfirmed.
- For Dina's trade-first users in India, UCP's gaps (quotes, credit, GST) are exactly the features they use daily. The Platform side still helps an Indian consumer buying from global merchants, with checkout handed to the merchant's page (where UPI or cards are taken).

---

## 8. Plan and size

Rough sizes, one engineer who knows the codebase, excluding review rounds.

| Phase | What | Depends on | Size |
|---|---|---|---|
| **1. Read** | `@dina/ucp` types, profile fetch and validation under the network policy, capability intersection, catalog search and lookup, Brain tool, comparison card with PeerLens trust. Public access only; no keys. | — | ~2 weeks |
| **2. Cart to hand-off** | P-256 key, Platform profile and its hosting (§4.3 decision), RFC 9421 signing, idempotency store, cart and checkout create/update, Core-minted review card, `continue_url` hand-off, egress-gated buyer fields. | Phase 1; hosting decision | ~3–4 weeks |
| **3. Orders** | Pull order status, purchase record in the vault, timeline entries; webhooks for server nodes with a public domain. | Phase 2 | ~1–2 weeks |
| **4. Linked accounts** | OAuth PKCE identity linking, token storage and revocation. | Phase 2 | ~1–2 weeks |
| **5. Merchant index** | AppView indexes UCP profiles of merchants people used, trust-ranked. | Phase 3; shares machinery with the A2A directory | ~2–3 weeks |
| **6. Complete in Dina** | AP2 human-present, wallet-signed (AP2 doc phase 3). | AP2 decisions | see AP2 doc |
| **B. Business side** | Public origin, catalog, checkout ↔ quote/order mapping, connector hand-off, signed webhooks, email via connector. | A supplier that asks; connector support | ~4–6 weeks |

Phase 1 is safe to start now: it is read-only, holds no keys, and sends no personal data.

---

## 9. Open questions

1. **Profile hosting for phones and NAT'd servers** (§4.3): a Dina-run host keyed by DID, the person's domain, or server nodes only.
2. **One profile or many** (§6.4): linkability against key and hosting cost.
3. **Merchant discovery**: is PeerLens-backed indexing of UCP merchants (phase 5) wanted, given it makes AppView a shopping directory?
4. **Business side trigger**: which supplier, which connector, which market.
5. **Governance risk**: how much to invest in a protocol whose council Google controls until 2028. Keeping `@dina/ucp` at the edge (no UCP shapes inside Core's commerce records) limits the cost of dropping it later.

---

## 10. Four Laws check

| Law | Effect |
|---|---|
| Silence First | Search and carts happen when asked. Order updates enter the timeline; only a failed or disputed order interrupts. |
| Verified Truth | Merchant order comes from PeerLens, never from the merchant's catalog text or placement. |
| Absolute Loyalty | Keys stay in Core. Buyer data reaches a merchant only after the person approves that purchase. Talking directly to merchants keeps a platform out of the middle. |
| Never Replace a Human | Unaffected. |
| Cart Handover | The design ends every checkout at the merchant's page until the owner decides otherwise (AP2 D1). |

---

## 11. Sources

- UCP spec repo, main `1b4e7bb` (2026-09-25) and release v2026-08-25: https://github.com/Universal-Commerce-Protocol/ucp — `docs/specification/overview/index.md`, `shopping/checkout/{index,rest,mcp,a2a}.md`, `shopping/catalog/*`, `shopping/order/index.md`, `common/identity-linking/index.md`, `payment/*`, `signatures.md`, `source/schemas/shopping/checkout.json`; rendered at https://ucp.dev/latest/specification/
- Governance: https://github.com/Universal-Commerce-Protocol/.github/blob/main/GOVERNANCE.md and `MAINTAINERS.md`
- Releases: https://github.com/Universal-Commerce-Protocol/ucp/releases
- Launch: https://blog.google/company-news/inside-google/message-ceo/nrf-2026-remarks/ ; https://shopify.engineering/UCP
- Google merchant guide and FAQ: https://developers.google.com/merchant/ucp ; https://developers.google.com/merchant/ucp/faq ; https://developers.google.com/merchant/ucp/implementation/2026-04-08/publish-profile
- Council expansion: https://thepaypers.com/payments/news/amazon-meta-microsoft-salesforce-and-stripe-join-the-universal-commerce-protocol-council
- Rollout: https://blog.google/products-and-platforms/products/shopping/shopping-updates-google-marketing-live/
- Flipkart test: https://techcrunch.com/2026/09/26/google-tests-buying-from-walmart-owned-flipkart-through-gemini-and-ai-mode-in-india/
- Senator Warren's letter: https://www.warren.senate.gov/newsroom/press-releases/warren-sounds-the-alarm-on-googles-new-ai-shopping-partnerships
- Open issues cited: #308, #641, #738, #742, #773, #845 on the UCP repo.
