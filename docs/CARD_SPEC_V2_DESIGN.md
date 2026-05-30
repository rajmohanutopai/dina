# CardSpec v2 Design

Long-term service result card architecture for Dina Services, marketplace
products, bookings, documents, approvals, and agentic workflows.

Important: because CardSpec v1 is still greenfield, this document should be
read as **future-compatible v1 requirements**, not as a plan to ship a breaking
`version: 2` envelope later. The first release should already contain the
compatibility rules that let this profile grow additively.

The central rule: **providers sell products and services, but Dina owns the UI
runtime and all trust/security/payment semantics.** Provider output is data.
Dina renders it through a fixed, validated vocabulary.

---

## 1. Executive Decisions

1. **No hard `version: 2` wire break.** V2 is an additive profile over the
   existing v1 envelope until explicit client capability negotiation exists.
   A v2 card still carries `version: 1` and a `blocks` array. New fields and
   block kinds are additive. Old clients drop unknown blocks and render the
   v1 fallback blocks.

2. **Every v2 card must contain a v1-safe fallback.** Producers must include
   enough v1-known blocks (`title`, `stat`, `keyValue`, `body`, `bar`, `map`,
   `link`) that an old client can show a useful answer even if it ignores all
   v2 blocks.

3. **Provider-specific presentation is via published templates, not runtime UI.**
   A provider may publish a `displayTemplate` with its capability schema.
   The requester side applies that template to the provider's structured result
   and then validates the resulting CardSpec. Providers do not send executable
   UI, HTML, React, Markdown-as-UI, or arbitrary component names.

4. **Runtime provider result is data only.** A service response should contain
   the validated capability result. It may optionally include a card only as a
   cache/hint, but the requester must treat it as untrusted and regenerate or
   revalidate it against the published template/result schema.

5. **Trust badges are Dina-owned.** Providers cannot create UI that looks like
   Dina verification, payment protection, official status, safety approval, or
   PeerLens trust. Provider statuses render as provider-attributed data, not as
   platform trust stamps.

6. **Commerce actions are never implicit.** Cards can show quotes, prices,
   inventory, and booking slots. They cannot auto-buy, auto-pay, auto-share
   private data, or silently invoke another service. Every action is an
   explicit user gesture and belongs to a small allowlist.

7. **Images are blob/proxy only.** No client-side arbitrary image URLs. Product
   and place photos use AT Proto blob CID + provider DID through a Dina image
   proxy, with metadata stripping, re-encoding, size/dimension caps, and a user
   setting.

8. **Sensitive domains are first-class.** Health, finance, legal, identity,
   home access, and child/school flows need provenance, expiry, warnings, and
   approval hooks. V2 includes blocks for documents, notices, decisions, and
   safe actions without granting providers control over the local vault.

---

## 2. Compatibility And Migration Contract

### 2.1 Wire Compatibility

Current v1 validators accept only `version: 1` and drop unknown block kinds.
That is good. V2 uses that behavior deliberately.

```json
{
  "version": 1,
  "profile": "dina.card.v2",
  "features": ["media", "table", "decision", "document"],
  "generatedAt": "2026-05-30T10:00:00Z",
  "expiresAt": "2026-05-30T10:15:00Z",
  "blocks": [
    {"kind": "title", "text": "Organic Bananas", "icon": "price"},
    {"kind": "stat", "value": "$0.79", "caption": "per lb"},
    {"kind": "keyValue", "label": "Status", "value": "In stock"},
    {"kind": "media", "did": "did:plc:seller", "cid": "bafy...", "alt": "Bananas"},
    {"kind": "action", "action": {"kind": "open_url", "url": "https://shop.example/item"}, "label": "View item"}
  ]
}
```

An old v1 client renders the first three known blocks and drops `media` and
`action`. A v2 client renders the richer card.

### 2.2 Major Version Rule

`version` is a breaking-change field, not a feature-version field.

- Additive block kind: keep `version: 1`.
- Additive optional top-level field: keep `version: 1`.
- Tightening validation in a way that drops previously accepted safe cards:
  allowed only if security-load-bearing.
- Reinterpreting an existing block field: forbidden.
- Removing an existing block: forbidden.
- `version: 2`: only after protocol-level client capability negotiation exists.

### 2.3 Producer Rule

Until all active clients support v2, every generated card must include a
`fallback` sequence using only v1-known blocks. Do not emit cards whose useful
content exists only in v2-only blocks.

---

## 3. Threat Model

Provider-controlled content may attempt to:

- execute code or markup,
- spoof Dina trust/payment/security UI,
- trick the user into opening a malicious destination,
- trigger payment or data sharing without consent,
- track the user via remote images or links,
- leak private data into a card or external URL,
- hide stale prices/availability,
- overload the renderer with huge payloads,
- impersonate a known provider or official institution,
- exploit LLM/template behavior to bypass safety rules.

V2 defenses:

- closed block vocabulary,
- strict validation and normalization,
- no eval/expression language,
- no remote code/HTML/webview,
- safe URL parser and host display,
- blob/proxy images only,
- Dina-owned trust surfaces,
- action allowlist with explicit user gesture,
- card/result/schema/template hashes for audit,
- size/time/count limits,
- stale/expiry rendering,
- fallback rendering for old clients.

---

## 4. Use-Case Coverage Matrix

| Domain | Example user request | Required card capabilities |
|---|---|---|
| Transit/travel | "When does bus 38 arrive?" | ETA stat, map, stale time, provider path |
| Appointment | "Is my dentist appointment confirmed?" | status, date/time, location, reschedule action |
| Products | "Find organic bananas near me" | product title, price, inventory, seller, image, item link |
| Marketplace seller | "Buy this from a local seller" | quote, seller trust, item details, checkout handoff |
| Restaurant/place | "Find a bakery open now" | ratings, hours, map, photos, contact |
| Home services | "Get a plumber quote" | quote line items, availability, provider trust, approve quote |
| Repair/diagnosis | "My AC is broken" | diagnostic summary, estimated cost, booking slots, document/photo refs |
| Delivery | "Where is my package?" | timeline, ETA, map, carrier, tracking link |
| Flight/hotel | "Check my flight" | timeline, delay badge, gate, reservation document |
| Finance | "What is my credit card bill?" | amount due, due date, document, sensitive notice, pay action gated |
| Insurance/tax | "Summarize this tax quote" | document summary, table, warnings, approval before sharing |
| Health | "Show lab result summary" | sensitive notice, document, doctor instructions, no unsafe trust claims |
| Education | "When is Emma's assignment due?" | due date, school/source, document, reminders |
| Legal/government | "Check visa status" | status, document, expiry, official-source warning |
| Media/events | "Find show tickets" | event details, seat/price list, venue map, checkout handoff |
| PeerLens/trust | "Is this seller trustworthy?" | Dina-owned trust score, reasons, review snippets, report action |
| Agent workflow | "Provider needs more info" | decision/clarification, required fields, approval/action path |
| IoT/home access | "Garage door status" | status, critical action requiring confirmation, audit trail |
| Communication | "Contact support" | provider identity, contact options, thread action |
| Documents | "Show receipt/invoice/ticket" | document block, line items, QR/barcode deferred, blob attachment |

Conclusion: v1 lookup cards are not enough. V2 needs commerce, documents,
decisions, tables, media, stale state, and safe actions.

---

## 5. Card Envelope

V2 keeps the v1 envelope but permits optional top-level metadata.

```ts
type CardSpecV2Compatible = {
  version: 1
  profile?: 'dina.card.v2'
  features?: string[]
  generatedAt?: string
  expiresAt?: string
  ttlSeconds?: number
  sourceLabel?: string
  provenance?: CardProvenance
  blocks: CardBlock[]
}
```

### 5.1 Provenance

```ts
type CardProvenance = {
  providerDid?: string
  providerName?: string
  capability?: string
  schemaHash?: string
  displayTemplateHash?: string
  resultHash?: string
  generatedBy?: 'deterministic_mapper' | 'provider_template' | 'local_llm'
}
```

Rules:

- Provenance is shown in the outer Dina handoff container when available.
- Provider-supplied provenance is advisory only; Dina fills authoritative
  provider DID/name/capability from the D2D workflow context.
- `resultHash` and `displayTemplateHash` are for audit/debug, not trust.

### 5.2 Staleness

- `generatedAt`: when the provider produced the result.
- `expiresAt`: hard expiry.
- `ttlSeconds`: fallback expiry relative to `generatedAt`.
- Renderer shows "as of" and dims/labels stale cards.
- Critical stale domains: price, stock, appointments, travel, finance, weather.

---

## 6. Trust Domains

There are two rendering trust modes.

### 6.1 Untrusted Provider Data Mode

Used for provider templates, service results, and local LLM summaries of
provider results.

Allowed:

- title, stat, keyValue, body, bar, rating, chips, list, table, timeline,
  map, link, media, document, status, notice.

Not allowed:

- trustBadge,
- paymentProtectionBadge,
- verifiedProviderBadge,
- approval result stamps,
- any UI that implies Dina/PeerLens/platform endorsement.

### 6.2 Trusted Dina UI Mode

Used only by Dina-owned systems: AppView/PeerLens trust, local security policy,
workflow approval status, payment/checkout state owned by Dina.

Allowed additional blocks:

- trustBadge,
- verificationSummary,
- approvalState,
- safetyNotice,
- paymentState.

The validator should default to untrusted mode. Trusted mode must be opt-in by
call site, not by card content.

---

## 7. V2 Block Vocabulary

### 7.1 Stable v1 Blocks

Keep existing semantics:

- `title`
- `section`
- `divider`
- `stat`
- `keyValue`
- `body` plain text only
- `badge` legacy, trusted-only for new producers
- `bar`
- `map`
- `link`

V2 producers should avoid provider-authored `badge`; use `status` or
`keyValue` instead.

### 7.2 New General Blocks

#### `status`

Provider-stated state without trust-stamp styling.

```ts
{ kind: 'status', label?: string, value: string, tone?: CardTone }
```

Examples: "In stock", "Confirmed", "Out for delivery", "Delayed".

#### `notice`

A bounded notice/warning. Trusted notices can use stronger styling; untrusted
notices are visibly provider-stated.

```ts
{ kind: 'notice', text: string, tone?: 'neutral'|'info'|'caution'|'critical', source?: 'provider'|'dina' }
```

#### `table`

Small data grid for invoices, comparisons, schedules, lab panels, line items.

```ts
{
  kind: 'table',
  columns: [{ key: string, label: string, align?: 'left'|'right'|'center' }],
  rows: Array<Record<string, string>>,
  caption?: string
}
```

Limits: max 5 columns, max 12 rows, strings capped. No nested cells, no rich
formatting, no row actions.

#### `list`

V2 formalizes list rows.

```ts
{
  kind: 'list',
  rows: [{ title: string, subtitle?: string, trailing?: string, tone?: CardTone }]
}
```

Max 20 rows.

#### `timeline`

```ts
{
  kind: 'timeline',
  steps: [{ label: string, state: 'done'|'active'|'upcoming'|'failed', time?: string }]
}
```

Max 10 steps.

#### `chips`

```ts
{ kind: 'chips', items: [{ text: string, tone?: CardTone }] }
```

Max 12 chips.

#### `rating`

```ts
{ kind: 'rating', value: number, scale?: 5|10|100, count?: number, label?: string }
```

Renderer normalizes to local visual style.

#### `chart`

Bounded mini chart for stock/weather/health trend. Optional/deferred renderer.

```ts
{
  kind: 'chart',
  chart: 'sparkline'|'bar',
  points: [{ x: string, y: number }],
  yLabel?: string,
  tone?: CardTone
}
```

Max 50 points. No arbitrary SVG/canvas commands.

### 7.3 Commerce Blocks

#### `money`

Canonical money display with currency, avoiding ambiguous free text.

```ts
{ kind: 'money', amountMinor: number, currency: string, label?: string, tone?: CardTone }
```

Rules: ISO 4217 currency, integer minor units, no provider-controlled currency
symbols as the source of truth.

#### `quote`

Summary of a quote/cart/invoice estimate.

```ts
{
  kind: 'quote',
  title?: string,
  currency: string,
  lineItems: [{ label: string, quantity?: string, amountMinor: number }],
  subtotalMinor?: number,
  taxMinor?: number,
  feesMinor?: number,
  totalMinor: number,
  validUntil?: string
}
```

Rules:

- Quote display is not payment.
- User must confirm before any checkout/contact action.
- Renderer shows validity/staleness.
- Max 20 line items.

#### `availability`

```ts
{ kind: 'availability', value: 'in_stock'|'limited'|'out_of_stock'|'preorder'|'unknown', label?: string }
```

Provider-stated. Not a trust signal.

### 7.4 Booking Blocks

#### `dateTime`

```ts
{ kind: 'dateTime', label: string, start: string, end?: string, timezone?: string }
```

Use ISO timestamps. Renderer localizes.

#### `slots`

```ts
{ kind: 'slots', label?: string, slots: [{ id?: string, start: string, end?: string, label?: string }] }
```

Display only unless paired with an explicit `action` block. Max 12 slots.

### 7.5 Document And Attachment Blocks

#### `document`

```ts
{
  kind: 'document',
  title: string,
  documentType: 'receipt'|'invoice'|'ticket'|'prescription'|'lab_report'|'contract'|'quote'|'other',
  did?: string,
  cid?: string,
  mimeType?: 'application/pdf'|'image/png'|'image/jpeg'|'text/plain',
  summary?: string,
  sensitive?: boolean
}
```

Rules:

- Blob CID only for inline/openable documents.
- No arbitrary remote document URL.
- Sensitive documents require local privacy handling.
- QR/barcode rendering is deferred and must be a separate safe block later.

#### `media`

```ts
{ kind: 'media', did: string, cid: string, alt: string, aspect?: '1:1'|'4:3'|'16:9' }
```

Rules:

- Blob CID + DID only.
- No provider image URLs.
- Render only through Dina image proxy.
- Alt required.
- User setting can disable images.

### 7.6 Safe Action Blocks

#### `action`

```ts
{
  kind: 'action',
  label: string,
  action: CardAction,
  tone?: CardTone,
  confirmation?: string
}
```

```ts
type CardAction =
  | { kind: 'open_url', url: string }
  | { kind: 'open_map', lat?: number, lng?: number, query?: string }
  | { kind: 'contact_provider', messageTemplate?: string }
  | { kind: 'request_approval', approvalKind: 'share_data'|'book_slot'|'accept_quote'|'unlock_persona', payloadRef?: string }
  | { kind: 'start_checkout', quoteRef: string }
```

V2 launch support:

- `open_url`: allowed with hardened URL validation and host display.
- `open_map`: allowed; renderer builds URL.
- `contact_provider`: allowed only after user confirmation.
- `request_approval`: Dina-owned flow only; provider cannot directly approve.
- `start_checkout`: deferred until safe checkout exists; old/new clients drop it.

No action may execute automatically. No action may carry vault data inline.

### 7.7 Decision / Clarification Blocks

#### `decision`

For provider asks and agent workflows.

```ts
{
  kind: 'decision',
  prompt: string,
  options: [{ id: string, label: string, tone?: CardTone, action?: CardAction }]
}
```

Rules:

- Max 4 options.
- Options are user gestures.
- If an option shares data/books/pays/unlocks, it must route through
  `request_approval` or another Dina-owned action.
- No arbitrary free-form form fields in v2. Use service follow-up messages or
  a future schema-driven form block.

### 7.8 Trusted Dina Blocks

Only trusted call sites can emit/render these.

#### `trustBadge`

```ts
{ kind: 'trustBadge', label: string, level: 'verified'|'trusted'|'caution'|'blocked'|'unknown', source: 'dina'|'peerlens' }
```

#### `verificationSummary`

```ts
{ kind: 'verificationSummary', score?: number, band?: 'high'|'medium'|'low'|'unknown', reasons?: string[] }
```

#### `approvalState`

```ts
{ kind: 'approvalState', state: 'pending'|'approved'|'denied'|'expired', label?: string }
```

Provider templates cannot produce these. The validator drops them unless
called in trusted mode.

---

## 8. Provider Display Template

A provider can publish a template with its service profile. The template is a
CardSpec skeleton with values bound from the provider result via JSON Pointer.

### 8.1 Template Shape

```json
{
  "templateVersion": 1,
  "fallbackBlocks": [
    { "kind": "title", "text": { "$ptr": "/product/name" }, "icon": "price" },
    { "kind": "stat", "value": { "$ptr": "/price/display" } },
    { "kind": "keyValue", "label": "Status", "value": { "$ptr": "/availability/label" } }
  ],
  "enhancedBlocks": [
    { "kind": "media", "did": { "$context": "providerDid" }, "cid": { "$ptr": "/image/cid" }, "alt": { "$ptr": "/image/alt" } },
    { "kind": "action", "label": "View item", "action": { "kind": "open_url", "url": { "$ptr": "/url" } } }
  ]
}
```

### 8.2 Template Rules

- JSON Pointer lookup only. No eval, no JS, no arithmetic, no conditionals in
  v2 launch.
- Missing/invalid pointer drops that field/block.
- Result values are converted to strings only through deterministic formatters.
- Repeaters are allowed only for array-to-list/table with hard caps.
- Template output is validated in untrusted mode.
- Template hash is stored with the service profile for audit/debug.
- Template is display only; it does not change param/result schema.

### 8.3 Who Applies The Template

Requester-side Brain applies the template after receiving and validating the
service result. Mobile should not execute provider templates directly unless it
has the same validator and no LLM/template network dependency.

---

## 9. LLM Role

LLM may produce CardSpec only as a local/requester-side presentation step.
It must:

- receive only the result fields needed for display,
- emit strict JSON CardSpec,
- pass through the same validator,
- run in untrusted mode unless the block is Dina-owned and built outside the
  LLM output,
- fall back to deterministic mapper if invalid.

LLM must not:

- generate executable UI,
- generate links from thin air,
- create trust/payment/security badges,
- decide approvals or payment execution,
- include locked-vault data unless the existing approval path allowed it.

---

## 10. URL, Map, Image, And Document Safety

### 10.1 URLs

Use a real parser, not regex. Accept only:

- absolute `https:` URLs,
- no username/password,
- no localhost/private IP/link-local/multicast hosts,
- no `.local`,
- standard port 443 or no port,
- normalized punycode/display host,
- max URL length.

Renderer always shows the destination host near the action label.

### 10.2 Maps

Maps are structured coordinates/query only. Client builds maps URL. Provider
never supplies a maps URL.

### 10.3 Images

Images are blob CID + DID only. Client uses Dina image proxy. No raw URL.

### 10.4 Documents

Documents are blob CID + DID only. Opening a sensitive document must respect
local privacy controls. Remote document URLs are links, not documents.

---

## 11. Rendering Rules

- Outer service path/handoff container remains Dina-owned.
- Result body renders CardSpec blocks.
- Unknown blocks are skipped.
- Empty after validation falls back to generic key-value result rendering.
- Provider name/DID/path metadata comes from the workflow, not from CardSpec.
- Trusted badges appear outside or above provider data and are visually distinct.
- Stale cards are dimmed and labeled.
- Dangerous/sensitive actions require explicit confirmation.
- Accessibility: all icons are decorative or have labels; images require alt;
  tables have headers; color is never the only signal.

---

## 12. Validation Limits

Suggested launch limits:

| Limit | Value |
|---|---:|
| Total serialized CardSpec | 32 KB |
| Blocks | 40 |
| Text field | 2,000 chars |
| Title/action label | 120 chars |
| List rows | 20 |
| Table rows | 12 |
| Table columns | 5 |
| Timeline steps | 10 |
| Chips | 12 |
| Chart points | 50 |
| Quote line items | 20 |
| Actions | 6 |
| Media blocks | 4 |
| Documents | 6 |

Validation should normalize/truncate safe text, but reject/drop fields that are
security-load-bearing: URLs, DIDs, CIDs, timestamps, money/currency, actions.

---

## 13. Storage And Audit

Persist:

- raw service result, if allowed by privacy policy,
- validated CardSpec,
- provider DID and capability,
- schema hash,
- display template hash,
- result hash,
- generatedAt/expiresAt,
- action taps/audit events.

Do not persist:

- unvalidated provider CardSpec hints as renderable UI,
- remote image/document bytes outside the proxy/cache policy,
- hidden action payloads with vault content.

---

## 14. Rollout Plan

### Phase 0: Clean V1

- Remove capability-specific mobile cards.
- Implement generic v1 renderer.
- Deterministic mapper emits v1-safe fallback blocks.
- Harden URL validation.
- Add card-level staleness metadata.

### Phase 1: V2-Compatible Parser

- Keep `version: 1`.
- Add top-level optional metadata preservation.
- Add block skipping for unknown kinds if not already present everywhere.
- Add trusted/untrusted validator mode.
- Add tests proving v2 cards degrade on v1 clients.

### Phase 2: Display Templates

- Add `displayTemplate` to service profile capability schema.
- AppView indexes/returns template and template hash.
- Requester Brain applies template to result.
- Validate output in untrusted mode.
- Fallback to deterministic mapper.

### Phase 3: Commerce/Booking/Documents

- Add `table`, `quote`, `money`, `dateTime`, `slots`, `document`, `decision`,
  `action` blocks.
- Only enable safe actions: `open_url`, `open_map`, confirmed
  `contact_provider`.
- Keep `start_checkout` disabled until checkout design exists.

### Phase 4: Media

- Build Dina image proxy.
- Enable `media` rendering for blob CID + DID.
- Add user setting and moderation/report path.

### Phase 5: Trusted Trust UI

- Add trusted blocks from AppView/PeerLens/local policy.
- Keep them impossible from provider templates/results.

---

## 15. Test Matrix

Compatibility:

- v2 card with v1 fallback renders on v1 validator.
- v2 card with only unknown blocks returns null; producer tests prevent this.
- Unknown top-level metadata does not break v1 render.
- Unknown block kinds are skipped, order of known blocks preserved.

Security:

- Raw HTML/Markdown/scripts never render.
- `http`, `javascript`, `data`, relative, credentialed, localhost, private IP,
  weird-port URLs are dropped.
- Provider trust badges are dropped in untrusted mode.
- Trusted blocks render only in trusted mode.
- Action does nothing without user tap.
- Payment/checkout actions are dropped until enabled.
- Map URL cannot be provider-supplied.
- Media/document URL cannot be provider-supplied.

Commerce:

- Quote totals render with ISO currency/minor units.
- Stale quote is labeled/dimmed.
- In-stock/provider status renders as provider-stated status, not trust badge.
- Link displays real host.

Templates:

- JSON pointer substitution works.
- Missing pointer drops block/field safely.
- Array repeaters obey caps.
- Template cannot create trusted blocks.
- Template output is idempotent after validation.

Privacy:

- Sensitive document card does not auto-open.
- Locked-vault data is not inserted without approval.
- LLM-generated cards do not include fields outside allowed result subset.

Accessibility:

- Media requires alt.
- Table headers exist.
- Tone/color has text labels.
- Action labels are descriptive and bounded.

---

## 16. Final Shape

V2 is not a new executable UI system. It is a larger, still-constrained data
language for service-result presentation.

The stable architecture is:

```text
Provider service profile
  -> result schema + optional displayTemplate

Provider service.response
  -> structured result only

Requester Brain
  -> validate result
  -> apply provider template or deterministic mapper or local LLM
  -> validate CardSpec in untrusted mode
  -> add Dina-owned trust/provenance/staleness

Mobile
  -> validate again
  -> render Dina-owned native blocks
  -> user-confirmed safe actions only
```

This lets any customer publish a product/service and get a custom card while
preserving the core security boundary: **remote parties describe data and
preferences; Dina decides what is safe to render and execute.**
