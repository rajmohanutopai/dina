# AP2 (Agent Payments Protocol) and Dina

**Status:** Assessment and design. Nothing is built. No AP2 code exists in the repo.
**Date:** 2026-09-27.
**Spec pin:** AP2 **v0.2.0** (tag of 2026-04-28; mandate `vct` strings end `.1`). For AP2 inside UCP, the UCP release **v2026-08-25** (`dev.ucp.common.payment.ap2_mandate`).
**Related:** `docs/UCP_UNIVERSAL_COMMERCE.md` (AP2 mostly arrives through UCP), `docs/A2A_GATEWAY_ARCHITECTURE.md`, `docs/A2A_IMPLEMENTATION_PLAN.md`, `docs/NEGOTIATION_PLAN.md` (item 10), `docs/TRADE_FIRST_STRATEGY.md` §4 (khata), `docs/JIFFY_MERCHANT_INTEGRATION_PLAN.md` (checkout hand-off), `docs/PLUGIN_ARCHITECTURE.md` (payment is BLOCKED at every ring).

---

## 1. Summary

AP2 is a way for an agent to prove to a merchant, a payment network and a bank that a person agreed to a purchase. It does not move money. It defines signed records, called mandates, that the parties check before a card network or bank moves money the ordinary way.

**Verdict: do not build AP2 now. Decide three questions first (§5), and build the two pieces that are useful either way (§9, phase 1) only when UCP work starts.**

Why not now:

- **The spec is unsettled.** Google gave AP2 to the FIDO Alliance on 2026-04-28. FIDO has formed working groups but published no draft. Nothing has merged to the AP2 repo since 2026-04-29. The core chaining format ("Delegate SD-JWT") is an individual IETF draft still being edited.
- **v0.2 threw away v0.1.** The Intent, Cart and Payment mandates most write-ups describe are gone. A design built on v0.1 would already be wrong.
- **No verified production use.** Many payment firms endorsed AP2. We found no primary source for a payment processor that accepts AP2 mandates in production. Claims that Stripe, Adyen or Checkout.com do so come only from vendor blogs.
- **Open security problems.** One user consent can be redeemed more than once, because no verifier must remember accepted mandates (AP2 issue #346). Withholding a disclosure switches a constraint off (#339, closed as intended behaviour). A September 2026 paper shows text in product descriptions steering agents into carts that pass every AP2 check.
- **It conflicts with a Dina law.** AP2's "human not present" mode is autonomous spending. That is item 10 of the negotiation plan, which the owner deferred because it conflicts with Cart Handover.

Why it still matters:

- AP2's threat model is Dina's. AP2 assumes "all LLMs and Agents MUST be considered potential attackers" and requires that all validation "MUST happen in deterministic code". Its Trusted Surface "MUST be non-agentic". Dina already splits an untrusted Brain from a Core that holds keys and decides in compiled code. Few products fit AP2's roles as naturally.
- It is the payment layer of UCP, which Google runs checkout on. A Dina that shops at UCP merchants without AP2 must hand every checkout to a web page. With AP2, the checkout can stay inside Dina and still be signed by the person.

---

## 2. AP2 v0.2 in one page

### 2.1 Roles

The spec names five roles (`docs/ap2/specification.md`):

| Role | Job |
|---|---|
| **Shopping Agent (SA)** | Finds products, builds the checkout, makes the purchase. Expected to be an LLM agent. |
| **Credential Provider (CP)** | Holds the payment credential (wallet, bank). Checks the agent may use it and scopes it to this purchase. |
| **Merchant (M)** | Offers and completes the checkout. Checks the agent was approved to buy these items. |
| **Merchant Payment Processor (MPP)** | Processes the payment. Checks the credential from the CP covers this checkout. |
| **Trusted Surface (TS)** | "A UI surface that is trusted to get informed user consent … before creating a user-signed Mandate." **Must be non-agentic.** |

The overview also names "Network and Issuer". One party may play several roles, and any role may hand its checks to someone else (a merchant to its payment provider, say).

### 2.2 Mandates

Every mandate is an **SD-JWT VC** (RFC 9901). Open and closed mandates are chained with **Delegate SD-JWT** (`draft-gco-oauth-delegate-sd-jwt`). There are two kinds, each open or closed:

| Mandate | `vct` | What it says | Key fields |
|---|---|---|---|
| Open Checkout | `mandate.checkout.open.1` | What the agent may buy | `constraints` (must include `checkout.line_items`; may include `checkout.allowed_merchants`), `cnf` (the agent's public key) |
| Closed Checkout | `mandate.checkout.1` | This checkout, from this merchant | `checkout_jwt` (the merchant-signed checkout), `checkout_hash` |
| Open Payment | `mandate.payment.open.1` | How much, how often, with what | `constraints` (must include `payment.reference` linking to the open checkout mandate; may include `payment.amount_range`, `payment.budget`, `payment.agent_recurrence`, `payment.allowed_payees`, `payment.allowed_payment_instruments`, `payment.allowed_pisps`, `payment.execution_date`), `cnf` |
| Closed Payment | `mandate.payment.1` | This payment | `transaction_id` (hash of `checkout_jwt`), `payee`, `payment_amount {amount (integer minor units), currency}`, `payment_instrument {id, type, description}`, optional `pisp`, `execution_date`, `risk_data` |

Verifiers must reject an unknown constraint type and must match the `vct` string exactly, suffix included.

**Receipts** finish the exchange. The merchant signs a Checkout Receipt (`status`, `reference` = hash of the closed mandate, `order_id`). The processor signs a Payment Receipt (`payment_id`, `psp_confirmation_id`, `network_confirmation_id`). Error codes: `invalid_credential`, `unresolved_constraint`, `invalid_mandate`, `mandates_not_supported`.

### 2.3 Two modes

**Human present.** The merchant returns a signed checkout. The agent builds mandate content. The Trusted Surface shows it, authenticates the person, and signs **closed** checkout and payment mandates. The CP checks the payment mandate and releases a one-purchase token. The merchant checks the checkout mandate and charges. Both sides send receipts. The spec admits this mode "can often be replaced with a traditional e-commerce journey".

**Human not present.** Ahead of time, the Trusted Surface signs **open** mandates that carry limits (merchants, items, amount range, budget, how often, which instruments, a date window, an expiry) and the agent's public key (`cnf`). Later, with nobody there, the agent signs **closed** mandates with its own key. Merchant and CP check the closed mandates against the open limits. Any verifier can pull the person back with `unresolved_constraint` or a 3-D Secure challenge.

Two rules matter for Dina: an agent "MUST NOT present any subsequent open … Mandates without receiving a rejection receipt from the previous one", and receipts "MUST be integrity protected from the Shopping Agent's LLM". **The spec defines no way to revoke a mandate** (issue #45, open since 2025-09).

### 2.4 Who vouches for the signer

Two trust models. Which one applies decides whether Dina can take part at all (§5.1):

- **User Credential.** A bank or network issues the person a Digital Payment Credential (`vct: com.emvco.dpc`) held in a wallet. The wallet is the Trusted Surface and signs over **OpenID4VP** (`transaction_data` of type `delegate`). The W3C Digital Credentials API is recommended. The Android sample uses Android Credential Manager.
- **Trusted Agent Provider.** The agent's company signs with its own backend key after its own Trusted Surface gets consent. Every merchant, CP and processor must decide to trust that company's key. "The Agent Provider MUST ensure that the Agent is not able to access the Agent Provider signing key."

The spec mentions passkeys and hardware keys as future options only.

### 2.5 Keys and formats

- Every example and the reference SDK use **ES256 (P-256)**. The SDK's JWK type allows only `kty: EC`, `crv: P-256`.
- The merchant's checkout JWT "MUST be signed using a digital signature scheme (e.g., ECDSA) and not a deterministic signature (e.g., Ed25519)". This rule is disputed (#268, raised by UCP's author).
- Parties must keep compact SD-JWTs with their disclosures to prove anything later.

### 2.6 Transport

v0.2 is transport-free: it "operates as a security feature within a Commerce Protocol" and names UCP as its intended host. It has no normative A2A or MCP binding any more. The v0.1 A2A extension (`https://github.com/google-agentic-commerce/ap2/tree/v0.1`) was removed. The v0.2 samples use a different URI (`https://github.com/google-agentic-commerce/ap2/v1`). **Treat any A2A carriage of AP2 as sample-grade, not spec.** In UCP, the checkout mandate travels in `ap2.checkout_mandate` and the payment mandate in `payment.instruments[*].credential.token` (§6.6).

### 2.7 Payment methods

`payment_instrument.type` is an open string. Examples in the spec: `card`, `dpc`, `UPI`. Samples: `card`, `x402` (USDC stablecoin). Push payments (bank transfer, UPI, Pix) appear through the `pisp` fields and a roadmap line only.

### 2.8 Disputes and liability

The four records (both mandates, both receipts) give "a non-repudiable picture of the transaction". AP2 assigns no liability. It supplies evidence for card networks, which "will define [their] own liability contracts". How evidence is retained and retrieved is out of scope.

---

## 3. What Dina has today

| Area | Today | Where |
|---|---|---|
| The law | "Dina Never Touches Money … she hands back control to you, the 'Cart Handover.' She is an advisor, not the decision maker." | `README.md` §Some principles |
| Enforcement | Agent `purchase`, `payment`, `transfer_money` are HIGH risk; untrusted agents are blocked from money actions; the plugin `payment` action is BLOCKED at every trust ring | `packages/core/src/gatekeeper/intent.ts` (`MONEY_ACTIONS`, `PLUGIN_ACTION_FLOORS.payment`) |
| Money code | None. No payment-processor SDK anywhere in core, protocol or commerce-protocol | — |
| Checkout hand-off | A supplier's connector attaches a `checkout_handoff` (https URL whose amount must equal the order's `approved_total`); Core raises an owner card; a yes only opens the URL on the phone | `packages/commerce-protocol/src/order_attachment.ts`; `packages/core/src/commerce/order_attachments.ts` (`ORDER_CHECKOUT_LINK_TYPE`) |
| Payment evidence | A connector attaches `payment_evidence` (`authorized|captured|refunded|failed`); an owner yes authors a khata `PaymentNote` | same; `trade_ledger_service.ts` `issuePaymentNote` |
| Payment records | `PaymentNote` asserts a payment happened (`method`: `cash|upi|cheque|transfer|other`, `external_ref` such as a UPI UTR); `PaymentAcknowledgement` answers it. Neither executes a payment | `packages/commerce-protocol/src/trade_documents.ts` |
| Rails | The India country pack reads UPI payment status (`upi-payment-status`, read only). No UPI intent or collect | `packages/core/src/commerce/country_rails.ts` |
| Human decides | Order approval binds everything the owner saw into a local digest; owner presence (passphrase, five minutes); clerks prove presence with a PIN, within a cap; over the cap the owner is asked | `approval_payload.ts`, `owner_presence.ts`, `staff_grants.ts`, `staff_escalation.ts` |
| Cards Brain cannot touch | Core-minted card types Brain may neither create nor decide | `packages/core/src/server/routes/workflow.ts` `CORE_MINTED_PAYLOAD_TYPES` |
| Keys | Ed25519 signing tree (`m/9999'/0'` root, `/1'` persona, `/3'` service, `/4'` namespace), secp256k1 PLC rotation (`/2'`). No P-256 | `packages/core/src/crypto/slip0010.ts` |
| Standards | AP2, UCP, x402, ONDC, Beckn: not implemented anywhere | — |

The trade Dina has built is business to business between Dina nodes. Payment happens outside Dina (UPI, bank transfer, cash) and the khata records it after the fact. **AP2 has nothing to add to that trade**: both sides already hold a signed order and a signed payment note, and nobody hands a card credential to anyone. AP2 matters only where Dina meets the card-and-wallet world: a person's Dina buying from a UCP merchant, or a Dina supplier selling to an outside agent.

---

## 4. How the roles map

### 4.1 Dina as the buyer's side

| AP2 role | Dina | Notes |
|---|---|---|
| Shopping Agent | **Brain** | Untrusted, as AP2 assumes. Proposes carts; never signs; never sees a credential. |
| Trusted Surface | **An owner card rendered from Core data, or the phone's wallet** | Must be non-agentic. A Core-minted card type renders fields Core took from the merchant-signed checkout, never Brain's words. See §5.1 for which surface signs. |
| Agent key (`cnf`) | **Core** (human-not-present only) | Would sign closed mandates in compiled code after checking them against the open limits. Only if item 10 is decided in favour (§5.2). |
| Credential Provider | **Not Dina** | The person's bank or wallet. Dina never holds a payment credential. |
| Merchant, Processor | Not Dina | The seller and its payment provider. |

### 4.2 Dina as the merchant's side

| AP2 role | Dina | Notes |
|---|---|---|
| Merchant | **A Dina supplier node** | Signs the checkout (ES256), verifies checkout mandates in Core, returns Checkout Receipts. |
| Merchant Payment Processor | **Not Dina** | The supplier's payment provider, reached through its connector (the Jiffy pattern). Dina never charges. |

The merchant side fits Cart Handover without strain: verifying a signed consent and handing the charge to the supplier's own processor moves no money through Dina.

---

## 5. Decisions the owner must make

### 5.1 D1 — May Dina carry a person's signed consent to pay?

Human-present AP2 has Dina assemble a checkout and payment mandate, get it signed, and send it on so a token is released and the merchant charges. The money moves between the person's bank and the merchant's processor. Dina never holds funds or a reusable credential. But Dina's message is what starts the charge. Today Cart Handover stops at "open this URL".

| Option | What it means | For | Against |
|---|---|---|---|
| **a. The wallet signs** *(recommended if D1 is yes)* | Dina builds the mandate content; the phone's wallet (holding a bank-issued Digital Payment Credential) shows it and signs over OpenID4VP. Dina forwards what the wallet signed. | The hand-over is literal: the person approves in the OS wallet, not in Dina. Verifiers already trust the issuer. Dina holds no payment key. | Needs banks to issue Digital Payment Credentials and the OS to expose them. We found no evidence of issuance in India. iOS support is unverified. |
| b. Dina signs as a Trusted Agent Provider | Core signs mandates with a Dina key after the owner confirms on a Core card. | Works without a wallet credential. | Every merchant, CP and processor must decide to trust each person's self-hosted node key. Nothing gives a self-hosted node that standing today. It also turns "Dina advises" into "Dina's key vouches for the payment". |
| c. No | Keep Cart Handover at "open this URL". UCP checkouts hand off through `continue_url`. | No change to the law. | Every UCP purchase leaves Dina for a web page. |

### 5.2 D2 — Autonomous spending (human not present)

This is item 10 of the negotiation plan, "approval within a spending limit", in AP2's form. **Recommendation: keep it deferred.** If the owner later wants it, AP2 gives the shape a principled version needs:

- Limits signed by the person in advance, not configured by an agent: merchants, items, a per-purchase range, a total budget, how often, an expiry.
- The agent key held by Core, never Brain, signing only after compiled checks against those limits.
- A running record of what each open mandate has spent, kept by Dina itself, since AP2 verifiers need not keep one (#346).
- A way to revoke, which AP2 lacks (#45). Dina would publish its own revocation list.
- A report to the person after every purchase (Silence First allows it: the person asked for autonomy and must hear what was done with it).

If D2 stays no, Dina rejects open-mandate flows outright and answers merchants that want one with `mandates_not_supported`.

### 5.3 D3 — Dina suppliers accepting AP2

A Dina supplier that sells through UCP would sign checkouts and verify checkout mandates. Charging stays with its processor. **Recommendation: yes, when a Dina supplier sells through UCP** (see the UCP doc). No law is strained.

---

## 6. Design, if adopted

### 6.1 A P-256 key

AP2 needs ES256. Dina's signing tree is Ed25519, and the spec forbids Ed25519 for the merchant's checkout signature. Add a **P-256 branch at `m/9999'/5'/{generation}'`**, derived with SLIP-0010 for the `nist256p1` curve (HMAC key "Nist256p1 seed"). `slip0010.ts` does Ed25519 and secp256k1 today; `@noble/curves` already ships P-256.

- Purpose 5 is unused (0 root, 1 persona, 2 PLC rotation, 3 service, 4 namespace).
- It stays in the signing tree, separate from the HKDF branch that makes vault keys, so the "two derivations, one seed" rule holds.
- One key serves AP2 merchant signatures, UCP request signatures (§ UCP doc) and, if D1(b) or D2 is chosen, mandate signing. Publish it as a JWK in the UCP profile `keys[]`.
- Add a frozen conformance vector for the derivation to `@dina/protocol`, beside the existing Ed25519 vectors.

### 6.2 Buyer, human present, wallet-signed (D1a)

1. **Brain** builds a cart with a UCP merchant (UCP doc §6) and receives the checkout with the merchant's `ap2.merchant_authorization` (a detached JWS over the JCS-canonical checkout).
2. **Core** verifies that signature against the merchant's key from its `/.well-known/ucp` profile. It rebuilds the totals from line items (as `verifyOrderAgainstQuote` does for Dina quotes) and refuses a mismatch.
3. **Core** builds the closed checkout and payment mandate content and raises a **Core-minted** card (new type, added to `CORE_MINTED_PAYLOAD_TYPES`). The card shows only fields Core took from the signed checkout: merchant, items, quantities, total, currency, instrument. Brain can neither create nor decide it.
4. The owner proves presence and taps Pay. On the phone, the app calls the OS digital-credential API with an OpenID4VP request whose `transaction_data` carries the mandate content. The wallet shows it again and signs. On a server Home Node, the card is answered on the paired phone, which does the same.
5. **Core** checks what came back matches what it built, byte for byte, then sends the checkout mandate to the merchant and the payment mandate to the CP (or inside the UCP instrument).
6. **Core** stores both mandates, both receipts and the disclosures (§6.4), and writes a purchase record to the vault.

No step gives Brain a key, a credential or the final word. If the wallet is not available, Dina falls back to the merchant's `continue_url`, which is today's Cart Handover.

### 6.3 Merchant (D3)

1. A buyer agent opens a UCP checkout with a Dina supplier that negotiated `dev.ucp.common.payment.ap2_mandate`.
2. **Core** signs every checkout response (`ap2.merchant_authorization`, ES256, key from §6.1).
3. On `complete_checkout`, **Core** verifies the checkout mandate: the chain, that the checkout inside matches the current one exactly, and every constraint. Unknown constraint types fail.
4. The payment mandate goes, unopened, to the supplier's processor through its connector. The connector's `payment_evidence` attachment reports the result, as it does for Jiffy today.
5. **Core** signs the Checkout Receipt and records the order through the existing supplier path (`order_decision.ts`).

### 6.4 Storage (identity.sqlite, a new appended migration)

| Table | Holds |
|---|---|
| `ap2_mandates` | Compact SD-JWT, disclosures, role (`buyer`/`merchant`), `vct`, open/closed, `checkout_hash`, linked mandate, created/expires |
| `ap2_receipts` | Signed receipt, `reference`, status, issuer, received at |
| `ap2_open_mandate_spend` | D2 only: per open mandate, spent amount and count, from receipts |
| `ap2_revocations` | D2 only: revoked open mandates, published and checked |

Evidence must stay recomputable for a dispute window (the network's, commonly 120 days for cards; to confirm per network). Mandates hold order details, never a card number: AP2 carries tokens, and Dina must refuse any field that looks like a raw PAN.

### 6.5 Libraries and vectors

- Needed: SD-JWT VC issue and verify, key-binding JWTs, and Delegate SD-JWT chains, all in TypeScript and able to run on Hermes. Candidates to evaluate: the OpenWallet Foundation's `sd-jwt-js` packages. Delegate SD-JWT is new enough that we should expect to write the chaining ourselves.
- AP2 ships no conformance vectors (#265, #303 open). We would write our own from the spec's examples and the reference SDK, and freeze them like the commerce vectors.

### 6.6 Where AP2 travels

Inside UCP. The checkout mandate goes in `ap2.checkout_mandate`, the payment mandate in `payment.instruments[*].credential.token`, the merchant signature in `ap2.merchant_authorization`. Errors: `mandate_required`, `agent_missing_key`, `mandate_invalid_signature`, `mandate_expired`, `mandate_scope_mismatch`, `merchant_authorization_invalid`, `merchant_authorization_missing`. Once negotiated, the UCP session is "Security Locked": completion without a mandate is refused.

UCP says to follow AP2 for signing rules, while AP2 signs a `checkout_jwt` and UCP signs the checkout JSON with a detached JWS. **Build to UCP's shape** (it is the one in use) and keep the AP2 SDK's shape behind a test.

### 6.7 Security

| Threat | Dina's answer |
|---|---|
| Product text steers the agent into a bad cart (the "whisper" paper) | The card renders merchant-signed fields, not Brain's summary. Guard scan runs on Brain's proposal. A cart whose items do not match what the person asked for is shown as such; the person, not Brain, decides. |
| One consent redeemed twice (#346) | Dina never re-presents a closed mandate. On the merchant side, Core keeps every accepted `checkout_hash` and refuses a repeat. |
| Disclosure withheld to dodge a constraint (#339) | Dina as merchant refuses a mandate whose constraints it cannot fully evaluate. |
| Agent key misuse (D2) | Core holds the key; signing follows compiled checks; spend is tracked from receipts; revocation list. |
| Credential leak | Dina holds no payment credential. Refuse PAN-shaped fields. Log metadata only, never mandate contents. |
| Key compromise | P-256 key rotates by generation, as the root key does. |

---

## 7. What AP2 does not cover

- **Trade between Dina nodes.** The khata chain already records orders, deliveries and payments with signed documents on both sides. AP2 adds nothing.
- **Quotes, negotiation, credit terms.** AP2 signs one checkout for one payment. A net-30 invoice or a revised quote has no place in it.
- **India's own agent-payment rails.** NPCI's agentic UPI work (Razorpay pilots on ChatGPT and Claude; "UPI Reserve Pay"; UPI Circle; a reported "Unified Agent Protocol") runs on NPCI's rails. No source we found links it to AP2. UPI appears in AP2 only as an example instrument type.

---

## 8. India

For the trade-first users (distributors, small manufacturers), AP2 is not relevant soon: they pay by UPI and bank transfer between known parties, and the khata records it. For a consumer in India, the likely autonomous-payment path is NPCI's (Reserve Pay limits enforced on the rail), not AP2. If D2 is ever decided in favour, NPCI's per-merchant limits would enforce spending on the rail and AP2-style limits would be Dina's own record; the two have no defined mapping. Watch NPCI, not FIDO, for India.

---

## 9. Plan and size

Sizes are rough, for one engineer who knows the codebase, and exclude review rounds.

| Phase | What | Depends on | Size |
|---|---|---|---|
| 0. Watch | Track the FIDO working groups, the AP2 repo, Mastercard's Verifiable Intent, and PSP documentation. Revisit when FIDO publishes a draft or a processor we can reach documents AP2 acceptance. | — | none |
| 1. Groundwork | P-256 branch (§6.1) with vectors; SD-JWT verify library and our own vectors (§6.5). Useful for UCP request signing regardless. | Starts with UCP work | ~1–2 weeks |
| 2. Merchant side (D3) | Sign checkouts, verify checkout mandates, receipts, storage, connector hand-off of the payment mandate. | UCP merchant lane; a connector that can pass a mandate to a processor | ~2–3 weeks |
| 3. Buyer, human present (D1a) | Core-minted card, OpenID4VP to the phone wallet, evidence store, fallback to `continue_url`. | UCP buyer lane; D1 = yes; a wallet with a Digital Payment Credential in a market we serve | ~3–4 weeks, plus device testing |
| 4. Buyer, human not present (D2) | Open mandates, Core agent key, spend tracking, revocation, post-purchase reports. | D2 = yes | ~3–4 weeks |

Do phase 1 only alongside UCP. Do not start 2–4 until phase 0's trigger fires.

---

## 10. Four Laws check

| Law | Effect |
|---|---|
| Silence First | Human-present purchases are asked for. D2 purchases must report after the fact; that is solicited (the person set it up), not engagement. |
| Verified Truth | Merchant ranking stays PeerLens. AP2 proves consent, not quality. |
| Absolute Loyalty | Keys stay with the person: the wallet (D1a) or Core (D2), never Brain, never a Dina company key. D1(b) would put a Dina-held key between the person and the bank; that is why it is not recommended. |
| Never Replace a Human | Unaffected. |
| Cart Handover | D1(a) keeps the hand-over literal. D1(b) and D2 change it, and need an explicit owner decision. |

---

## 11. Open questions

1. D1, D2, D3 above.
2. Which market first? Card wallets with Digital Payment Credentials are a US and EU story today. India would need NPCI's path.
3. Does iOS expose issued payment credentials to apps through a Digital Credentials API? Unverified.
4. Will FIDO keep v0.2's shapes? Unknown. Pin `vct` suffixes and expect change.
5. Dispute-evidence retention period per network: to confirm before phase 2.

---

## 12. Sources

- AP2 repo, tag v0.2.0 and main (`e1ea56d`, 2026-04-29): https://github.com/google-agentic-commerce/AP2 — `docs/ap2/specification.md`, `agent_authorization.md`, `flows.md`, `security_and_privacy_considerations.md`, `implementation_considerations.md`, `code/sdk/schemas/ap2/*.json`, `CONTRIBUTING.md`, `CHANGELOG.md`.
- AP2 v0.1 spec (superseded): https://github.com/google-agentic-commerce/AP2/blob/v0.1.0/docs/specification.md
- Google, AP2 to FIDO (2026-04-28): https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/
- FIDO Alliance working groups: https://fidoalliance.org/fido-alliance-to-develop-standards-for-trusted-ai-agent-interactions/
- Delegate SD-JWT draft: https://github.com/GarethCOliver/gco-delegate-sd-jwt
- Mastercard Verifiable Intent 0.1-draft: https://verifiableintent.dev/spec/
- Launch endorsers: https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
- Open issues cited: #45, #265, #268, #303, #339, #346 on the AP2 repo.
- Louck, Dvir, Stulman, "Signing the Transaction but Not the Decision: Whisper Attacks and a Binding Defense for AP2", arXiv 2609.11757 (2026-09-10).
- UCP AP2 extension: https://github.com/Universal-Commerce-Protocol/ucp/blob/main/docs/specification/payment/extensions/ap2-mandates.md
- Razorpay and NPCI agentic payments: https://razorpay.com/blog/agentic-payments-and-npci/
