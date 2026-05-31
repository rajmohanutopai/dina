# Service-result cards — CardSpec design

How any provider's reply renders as a rich, safe display card — without
shipping per-capability UI code, and without trusting provider-authored
markup, URLs, images, or trust claims.

> Compatibility stance: v1 is still greenfield, so v1 must be designed as the
> long-term compatibility foundation. Do **not** plan a later breaking v2
> migration for ordinary new card features. New fields/block kinds must be
> additive and safely ignored by older clients.
>
> Incorporates a parallel design review (Codex, 2026-05-30): commerce action
> policy (§6), Dina-owned trust badges (§7), stronger URL safety (§8),
> blob-CID-only images (§9), staleness/expiry (§10), provider-declared
> templates (§11).

---

## 1. The problem

The mobile renderer hard-coded a per-capability card (`EtaResultBody` for
`eta_query`). Every new capability needed a new TSX component in an app
update — unworkable for an open-ended Services network. The **handoff/path
container** (who was asked, the trail the call took — the outer card in the
screenshots) stays. Only the **result body** is redesigned.

## 2. The model: card as DATA, not code

The brain maps a provider result → a **CardSpec**: an ordered list of blocks
from a FIXED, safe vocabulary. The client renders ONLY that vocabulary — it
never renders provider- or model-authored markup/code. One renderer draws
every capability.

THREE producers, composing — all output the same CardSpec, all pass through
`validateCardSpec()`:
1. **Deterministic mapper** (`result_card_mapper.ts`) — pure function over the
   provider `result` (+ its published result-schema). No LLM, instant,
   testable. The default + always-available fallback.
2. **Provider-declared template** (§11) — the provider publishes a
   `displayTemplate` (JSON-pointer bindings over its OWN result fields, no
   code). Lets a marketplace seller control presentation without us shipping
   code. Deferred to v2.
3. **LLM-authored** — the requester's already-running agentic LLM emits a
   CardSpec as part of its turn (no extra call), for rich composition.
   Deferred to v2.

The provider RESULT is untrusted input in all three paths. Whatever a producer
derives from it is re-validated to the safe vocabulary + safety rules below
before it reaches the renderer.

### 2.1 V1 compatibility baseline — must ship now

Because CardSpec v1 is not released yet, the compatibility rules belong in v1
from day one:

1. **`version: 1` is the compatibility envelope.** Do not emit `version: 2` for
   additive features. A hard version bump would make older clients reject the
   entire card.
2. **Unknown top-level fields are ignored, not fatal.** This lets future cards
   carry `profile`, `features`, `generatedAt`, `expiresAt`, `provenance`, or
   similar metadata without breaking older clients.
3. **Unknown block kinds are dropped, not fatal.** This is the core forward-
   compatibility behavior. A client that does not know `media`, `quote`, or
   `document` still renders the known blocks.
4. **Every rich card includes a v1-safe fallback.** Producers must include
   enough stable blocks (`title`, `stat`, `keyValue`, `body`, `bar`, `map`,
   `link`) that an old client shows a useful answer even if it drops all newer
   blocks.
5. **Existing block semantics never change.** New behavior is added by optional
   fields or new block kinds. Do not repurpose an existing field.
6. **Renderer fallback is mandatory.** If validation drops every CardSpec block,
   the client falls back to generic key-value rendering of the service result.

`docs/CARD_SPEC_V2_DESIGN.md` is therefore not a separate breaking protocol. It
is the long-term additive profile that v1 must be compatible with by default.

---

## 3. v1 scope (what ships now)

**Blocks implemented + rendered now (14):** title, section, divider, stat,
keyValue, body, badge, bar, rating, chips, list, timeline, map, link.

**Specified in the wire format now, renderer IGNORES until the image proxy
exists (1):** media. (Forward-compat already drops unknown kinds, so adding it
to the validator now means no wire change when the renderer turns it on.)

**Card-level fields now:** version, blocks, generatedAt?, expiresAt?,
ttlSeconds?, sourceLabel? (§10).

**Deferred (additive later, no migration):** provider `displayTemplate` (§11),
LLM-authored cards, image RENDERING (§9), chart/sparkline, comparison/columns,
`markdownBody` (§12), the `contact_provider` / `start_checkout` actions (§6).

---

## 4. Scenario catalogue — 15 services and how their cards look

For each: provider result shape (sketch) + the card it produces. `[tone]`
marks the color-scheme accent.

### S1 — Transit ETA (`eta_query`)
```
🚌 Route 38 Geary
8 min  to Geary Street            [stat, positive]
[ Open in Maps ]                  (map: from lat/lng)
```
title(transit) · stat · map

### S2 — Appointment status (`appointment_status`)
```
📅 Dr Carl's Clinic
( Confirmed )                     [badge, positive]  (factual status, allowed)
Date    Tuesday, June 3
Time    2:30 PM
Please arrive 10 minutes early.
```
title(calendar) · badge · keyValue×2 · body

### S3 — Product price / availability (`price_check`) — COMMERCE
```
🏷️ Organic Bananas (1 lb)
$0.79                             [stat]
( In stock )                      [badge, positive]
Store   Corner Market
[ View item · corner-market.com ] (link: open_url, host SHOWN, user-tapped)
   ┌── product photo — DEFERRED to image proxy (§9) ──┐
as of 2:31 PM                     (staleness, §10)
```
title(price) · stat · badge · keyValue · link · (media deferred)

### S4 — Restaurant / place lookup (`place_lookup`) — the "beautiful" one
```
🍴 Tartine Bakery
( Open now )                      [badge, positive]
RATINGS                           (section)
Food      ▓▓▓▓▓▓▓▓▓░  4.6         [bar, positive]
Service   ▓▓▓▓▓▓▓░░░  3.5         [bar, caution]
Ambiance  ▓▓▓▓▓▓▓▓░░  4.1         [bar, positive]
──────────                        (divider)
Price     $$
Cuisine   Bakery · Cafe
Famous for morning buns…          (body)
[ Open in Maps ]                  (map: lat/lng)
```
title(store) · badge · section · bar×3 · divider · keyValue×2 · body · map

### S5 — Weather now (`weather_now`)
```
☀️ San Francisco
68°  Sunny                        [stat, accent]
Hi 71° · Lo 58°                   (caption)
Humidity  44%
Wind      8 mph NW
NEXT HOURS                        (section)
[3pm 70°][4pm 69°][5pm 66°]       (chips)
```
title(weather) · stat · keyValue×2 · section · chips

### S6 — Stock / crypto quote (`stock_quote`)
```
📈 AAPL
$213.40                           [stat]
+2.15 (+1.02%)                    [badge, positive]   (critical/red if down)
Day range ▓▓▓▓▓▓░░░░               [bar]
Mkt cap   $3.3T
as of 2:31 PM · 15-min delayed    (staleness)
```
title · stat · badge(tone by sign) · bar · keyValue · (sparkline deferred)

### S7 — Package / delivery tracking (`shipment_status`)
```
📦 UPS · 1Z…7K4
( Out for delivery )              [badge, info]
●─●─●─○  Ordered·Shipped·Out·Delivered   (timeline)
ETA       Today by 8 PM
[ Open in Maps ]                  (map: current location coords)
```
title · badge · timeline · keyValue · map

### S8 — Flight status (`flight_status`)
```
✈️ UA 1234
( Delayed 25m )                   [badge, caution]
SFO ●────✈────○ JFK              (timeline w/ progress)
Departs   3:45 PM · Gate B12
Arrives   12:10 AM · Gate 7
```
title · badge · timeline · keyValue×2

### S9 — Currency / unit conversion (`convert`)
```
💱 100 USD → EUR
€92.50                            [stat, accent]
Rate      1 USD = 0.925 EUR
as of 2:31 PM
```
title · stat · keyValue · body

### S10 — Nearby availability (`find_nearby`) — list-shaped
```
🏪 In stock near you
Corner Market   0.3 mi   $0.79   ✓   (list row, positive trailing)
Whole Foods     0.8 mi   $0.99   ✓   (list row)
Safeway         1.2 mi   —       ✗   (list row, critical trailing)
```
title · list(rows)

### S11 — Doctor availability (`provider_availability`)
```
🩺 Dr Carl's Clinic
( In-network )                    [badge, positive]  (factual, allowed)
NEXT AVAILABLE                    (section)
[Tue 2:30][Tue 4:00][Wed 9:15]    (chips)
[ Open in Maps ]                  (map)
```
title · badge · section · chips · map

### S12 — Parking / EV charging (`parking_status` / `ev_charge`)
```
🅿️ Civic Center Garage
42 spots                          [stat, positive]  (critical if 0)
Rate      $3.50 / hr
Avail     ▓▓▓▓▓▓▓▓░░  82%          [bar, positive]
[ Open in Maps ]
```
title · stat(tone by count) · keyValue · bar · map

### S13 — Sports score (`game_score`)
```
🏀 Warriors  ( Final )
Warriors  118                     (keyValue)
Lakers    112
GSW wins by 6.                    (body)
```
title · badge · keyValue×2 · body  (logos = images, §9)

### S14 — Article / claim verification (`peerlens_verify`)
```
🔎 "Study links X to Y"
Trust     ▓▓▓░░░░░░░  Low          [bar, caution]   (Dina/PeerLens-sourced)
Source    example.com
( Disputed )                      [badge, critical] (Dina-owned trust badge)
3 reviewers flagged this claim.   (body)
```
title · bar(trust) · keyValue · badge(Dina-owned) · body

### S15 — Movie / show info (`media_info`)
```
🎬 Dune: Part Two
★★★★☆  4.3                        (rating)
Runtime   2h 46m
Genre     [Sci-Fi][Adventure]     (chips)
A sequel that…                    (body)
[ Watch · netflix.com ]           (link: open_url, host shown)
```
title · rating · keyValue · chips · body · link

---

## 5. Vocabulary derived from the scenarios

| block | fields | covers |
|-------|--------|--------|
| **title** | text, icon?, tone? | all |
| **section** | label | S4,S5,S11 |
| **divider** | — | S4 |
| **stat** | value, unit?, caption?, tone? | S1,S3,S5,S6,S9,S12 |
| **keyValue** | label, value, tone? | many |
| **body** | text (PLAIN, §12) | S2,S4,S9,S13,S14 |
| **badge** | text, tone? — provider badges are FACTUAL only (§7) | many |
| **bar** | label?, ratio[0–1], valueLabel?, tone? | S4,S6,S12,S14 |
| **rating** | value[0–5], count?, tone? | S15,S4(alt) |
| **chips** | items[{text, tone?}] (capped) | S5,S11,S15 |
| **list** | rows[{text, sub?, trailing?, badge?, tone?}] (capped) | S10 |
| **timeline** | steps[{label, state: done\|active\|upcoming}] (capped) | S7,S8 |
| **map** | label, (lat&lng) OR query — **never a URL** (§8) | S1,S4,S7,S11,S12 |
| **link** | label, url(https), action='open_url' — **host shown** (§6,§8) | S3,S15 |
| **media** | did, cid, alt, aspect? — **blob only, render deferred** (§9) | S3,S4,S13,S15 |

`tone` ∈ {neutral, positive, caution, critical, info, accent}. `icon` ∈ a
fixed semantic set. Richness = sections + dividers + colored bars/ratings/
badges/chips + tone; later, bounded images.

---

## 6. Commerce: action policy (Codex #3 — Dina's "Cart Handover" law)

Product/booking cards lead to payment, purchase, refunds. A `link` must NEVER
silently become "Buy now". Every actionable affordance carries an explicit
`action`, and v1 ships only the safe one:

| action | meaning | v1? |
|--------|---------|-----|
| `open_url` | open an https page in the browser — **user-tapped only, real host always shown**, label may not imply a completed transaction | ✅ ships |
| `contact_provider` | send a D2D message to the provider — **user-confirmed** | ⛔ deferred |
| `start_checkout` | begin a purchase | ⛔ deferred until Dina owns a safe checkout/cart-handover flow |

Hard rules: **no auto-purchase, no silent payment, no background actions.** The
client performs an action only on an explicit user tap. `link.action` defaults
to `open_url`; any other value is dropped in v1 (forward-compat).

## 7. Trust UI is Dina-owned, never provider-authored (Codex #4)

A provider-supplied badge "Verified" / "Official" / "Insured" / "Payment
protected" is a trust-spoofing attack. Trust is PeerLens's job, not provider
self-assertion (Dina's Four Laws). **Decision (2026-05-30): NO provider
badges at all** — the strictest option, chosen over a reserved-word denylist
because it leaves zero spoof surface (a denylist always has gaps).

- **The `badge` block is Dina-owned.** `validateCardSpec(value, { trusted })`
  — default `trusted: false` **drops every `badge` block**. Only Dina/PeerLens
  build cards with `validateCardSpec(value, { trusted: true })` (the handoff
  container's trust badges, S14's PeerLens "Disputed"). The deterministic
  mapper + provider template + LLM path are ALL untrusted → they emit no
  badges.
- **Provider status becomes `keyValue` (with `tone`), not a badge.** S2's
  "Confirmed", S3's "In stock", S7's "Out for delivery" render as
  `keyValue{ label:'Status', value:'In stock', tone:'positive' }`. This keeps
  the green/red **color scheme** (color is presentation, not a trust claim,
  and is clearly attributed to the provider as data) while removing the
  authoritative-looking trust-stamp pill.
- **No free-text word-filtering.** We do NOT scrub "verified"/"official" from
  `keyValue`/`body` text — that would break legitimate content (a product
  named "SafeGuard", a movie "Trusted") and the structural fix (badges =
  Dina-only) already removes the spoofable trust-stamp UI. Provider free text
  reads as provider-stated data, never as a Dina trust signal.

The §4 scenario sketches that show `( … )` provider badges (S2,S3,S6,S7,S8,
S11,S13) therefore render as toned `keyValue`/`stat` rows in v1; only S14's
Dina/PeerLens "Disputed" is an actual `badge` (trusted channel).

## 8. URL & map safety (Codex #5)

- **`map` carries STRUCTURED location, never a URL** — lat/lng (WGS84-bounds
  checked) or a place `query` string. The CLIENT builds the maps deep-link, so
  a provider can't supply a URL → can't phish or smuggle a scheme.
- **`link.url` validation (hardened, real parsing not just regex):** require
  absolute `https:`; reject embedded credentials (`user:pass@`), `localhost` /
  `*.local` / IP-literal / private-range hosts, and non-standard ports.
  Normalize the host for display; the renderer ALWAYS shows the real
  destination host beside the label so a misleading label can't hide the
  target.

## 9. Images (Codex #6) — blob-CID only, render deferred

The danger isn't the picture; a raw image URL enables tracking (IP/pixel
beacon), phishing (fake UI as image), layout abuse, IP leak, decoder exploits.
So `media` is **never a URL**:

```
media: { kind:'media', did, cid, alt, aspect?:'1:1'|'4:3'|'16:9' }
```
- **AT Proto blob CID + provider DID only** — content-addressed (tamper-
  evident), the native pattern (a `com.dinakernel.peerlens.media` record already
  carries blobs). The client builds `https://img.dinakernel.com/blob/{did}/{cid}`
  — provider supplies neither host nor clickable link.
- **v1: the renderer IGNORES `media`.** v2 turns it on once the Dina image
  service exists: server-side blob fetch from the provider's PDS, EXIF strip +
  re-encode, content-type allowlist (jpeg/png/webp), size + dimension caps,
  served from a dina domain, behind a user setting, in a fixed-aspect
  provider-framed slot (never full-bleed → can't impersonate Dina chrome),
  `alt` required.
- **Explicitly NOT doing "proxy fetches an arbitrary provider URL"** (SSRF,
  malware, cache-poisoning, moderation, abuse limits all unsolved). Blob-CID
  first; arbitrary-URL images are out of scope.

## 10. Staleness / expiry (Codex #7)

Price, inventory, appointments, shipping, quotes, weather are all
time-sensitive. Card-level fields (all optional):

```
generatedAt?: string   // ISO8601 — when the provider produced the result
expiresAt?:   string   // ISO8601 — hard expiry; OR
ttlSeconds?:  number    // relative expiry from generatedAt
sourceLabel?: string    // short provenance, e.g. "15-min delayed"
```
The renderer shows "as of <time>"; past `expiresAt` (or `generatedAt +
ttlSeconds`) it dims the card + marks it stale. Bounds: timestamps must parse;
`ttlSeconds` clamped to a sane max.

## 11. Provider-declared presentation template (Codex #2) — DEFERRED to v2

For a marketplace ("any seller publishes a product"), a provider may publish a
`displayTemplate` alongside its capability schema: a CardSpec skeleton whose
field values are **JSON pointers into its own `result`** — NOT code, NOT
expressions.

```
displayTemplate: {
  version: 1,
  blocks: [
    { kind:'title', text:'$.product.name', icon:'price' },
    { kind:'stat',  value:'$.price.display' },
    { kind:'badge', text:'$.availability' },        // still §7-filtered
    { kind:'link',  label:'View', url:'$.product_url', action:'open_url' },
  ]
}
```
Dina resolves the pointers against the (untrusted) result, then runs the result
through `validateCardSpec({ trusted:false })` — so a template can't escape the
safety rules (no fake trust badges, https-only links, etc.). Pointer resolution
is a pure lookup (no `eval`, no expression language). Deferred until after v1;
the deterministic mapper covers the common shapes meanwhile.

## 12. Markdown (Codex #8)

`body` is **plain text only** — no markdown is parsed or rendered in v1. If
rich text is needed later, add a separate `markdownBody` block with a strict
safe subset (bold/italic/lists/line-breaks; no links/images/html/scripts) — a
new block kind, additive, unknown-kind-safe for older clients.

---

## 13. Safety invariants (enforced by `validateCardSpec`)

1. **No rendered markup/code** — closed block set; unknown kinds dropped.
2. **No provider URL auto-followed** — `map` = structured coords/query (client
   builds URL); `link` = https-only + creds/localhost/private-IP/odd-port
   rejected + host shown + `open_url`, user-tapped.
3. **No image URL** — `media` = blob-CID + DID via Dina proxy; render deferred.
4. **No provider-faked trust** — reserved trust/payment badge vocabulary
   stripped from untrusted cards; trust badges are Dina-owned (§7).
5. **No silent commerce** — only `open_url` ships; checkout/contact deferred;
   never auto-act (§6).
6. **Bounded** — text cap, block-count cap, `bar.ratio`∈[0,1],
   `rating.value`∈[0,5], coords in WGS84, chips/list/timeline item caps,
   `ttlSeconds` clamped.
7. **Forward-compatible + additive** — unknown block kinds/icons/tones dropped
   not rejected; `@dina/protocol` wire type grows additively only.

## 14. How the spec "handles all these"

Every scenario in §4 is a SELECTION + ORDERING of §5 blocks — none needs a
bespoke block beyond the catalogue. New services render for free when their
result maps onto these blocks: the deterministic mapper covers the common
shapes (name→title, status→badge[filtered], numbers→stat/bar/rating,
coords→map, lists→list, steps→timeline), the provider template (v2) lets
sellers arrange their own, and the LLM path (v2) composes the richest layouts —
all within the exact same safe vocabulary and safety rules. An unseen
capability still produces a sensible card (title + keyValues + body), degrading
to the generic text card only if the result is empty.
