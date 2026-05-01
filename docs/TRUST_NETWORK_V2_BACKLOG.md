# Trust Network V2 — Actionability Layer

Trust answers "should I believe this?" — V2 closes the gap to "can I act on this?". A trusted recommendation is unactionable when the reviewed thing is unavailable in your region, priced out of reach, incompatible with your devices, stale, or just doesn't fit your use case. V1 ships the trust score; V2 makes the recommendation *useful*.

**V1 reference:** `docs/TRUST_NETWORK_V1_PLAN.md` + `docs/TRUST_NETWORK_V1_BACKLOG.md`

## Why this exists

V1's promise — "ranked by trust, not ad spend" — is necessary but not sufficient. A recommendation is only USEFUL if you can act on it. The 12 gaps below are what an ad-driven platform handles invisibly (regional inventory, price filters, device targeting, freshness), and what a decentralised trust network must surface explicitly to compete.

The trust score itself stays region-agnostic and viewer-agnostic — that's what makes scores cacheable + comparable + auditable. Actionability is layered ON TOP as filters, badges, and re-ranking, all keyed by the viewer's locally-held profile that NEVER leaves the device (Loyalty Law).

## Status legend

- `[ ]` todo
- `[-]` in progress
- `[x]` done
- `[!]` blocked / needs decision

## The 12 gaps (motivation, not tasks)

| # | Gap | Concrete failure mode |
|---|---|---|
| 1 | Access / availability | Trusted pen sold only in Uganda — useless to a US viewer. |
| 2 | Recency / freshness | 2018 phone review — model EOL, security stale. 5-year-old restaurant — chef left, ownership changed. |
| 3 | Affordability | Trusted $400 chair — irrelevant to $80 budget. |
| 4 | Compatibility | "Best phone case" — useless if reviewer has iPhone and you have Samsung. |
| 5 | Comparative context | "Is X trusted?" answered. "Is X the BEST trusted option?" not. |
| 6 | Use-case fit | Camera reviewed for wildlife vs weddings vs vlogging — same product, different verdict per purpose. |
| 7 | Negative space | Trust surfaces good things; doesn't proactively warn ("this brand is flagged by 3 of your contacts"). |
| 8 | Language | Mandarin-only review of a movie — useless to non-Mandarin speaker. (Server has filter; mobile UI doesn't surface.) |
| 9 | Schedule / hours | Restaurant only Tue–Sat; 3-week booking lead; seasonal product. |
| 10 | Compliance | Halal/kosher/vegan/gluten-free; FDA/CE marked; age-restricted. |
| 11 | Accessibility (disability) | Wheelchair access; screen-reader compat; captioned content. |
| 12 | Personalisation | Trust score is global, not viewer-specific. A reviewer who matches your taste should weigh more than a stranger with the same trust score. |

## Cross-cutting principles

- **Loyalty Law (privacy):** the viewer's profile (region, budget, devices, dietary, accessibility, language) is keystore-resident and NEVER sent to AppView. All viewer-context filtering is mobile-side after the network query.
- **Trust score stays viewer-agnostic.** Cacheability + comparability + auditability depend on this. Actionability is layered as filters/boosts on top — the underlying score doesn't change.
- **Reviewer-stated metadata is optional.** Existing V1 attestations stay valid. New V2 fields are additive on the lexicon.
- **Subject metadata splits server-extracted vs reviewer-stated.** The enricher fills what it can derive (host TLD → region, OpenGraph → price, JSON-LD → hours). Reviewers fill the rest.
- **Negative space stays opt-in surfacing.** Auto-warnings about flagged brands need careful UX — they can read as "Dina is shaming X" rather than "your trusted contacts have concerns". Phase 4 work, not phase 1.

## Suggested phased path

| Phase | Lift | Delivers | Sections |
|---|---|---|---|
| **P1** | small | Surface what already exists — host TLD, language, lat/lng on cards. | §1 only |
| **P2** | medium | Viewer profile (Cluster A) + subject availability metadata (Cluster B). Closes gaps 1, 3, 4, 8. | §2 + §3 |
| **P3** | medium | Lexicon additions + Write form fields (Cluster C). Closes gaps 2, 6. | §4 |
| **P4** | medium-large | Ranking changes (Cluster D). Closes gaps 5, 7, 9, 10, 11, 12. | §5 |

---

## 1. Phase 1 — Surface existing metadata (`apps/mobile/src/trust/`)

Already extracted server-side, just not visible on cards. Quick win, no schema or backend changes.

- [ ] **TN-V2-P1-001** — `subject_card.ts` — extend `SubjectCardDisplay` with optional `host` field; surface as a small chip on the card (e.g., `amazon.co.uk`, `jumia.ug`). Pure data layer + view update.
- [ ] **TN-V2-P1-002** — `subject_card.ts` — extend with optional `language` field; render as a chip (`EN`, `ES-MX`) when known.
- [ ] **TN-V2-P1-003** — `subject_card.ts` — for `place` subjects, render coordinates as a city/region label (reverse-geocode is a fallback later; for now just lat/lng truncated).
- [ ] **TN-V2-P1-004** — `subject_detail.ts` — extend the header to show host + language + (for places) location. Same chips, larger.
- [ ] **TN-V2-P1-005** — Tests: render coverage for the new chips (3 fixtures: host-only, language-only, both, place-with-coords).

## 2. Phase 2A — Viewer profile (Cluster A)

Local-only preferences. Keystore-resident. Never sent to AppView.

- [ ] **TN-V2-CTX-001** — `apps/mobile/src/services/user_preferences.ts` — keystore schema for the local profile. Discriminated-union shape so future fields can be added without schema migrations: `{ region, budget, devices, languages, dietary, accessibility }`. Defaults derived from device locale on first read.
- [ ] **TN-V2-CTX-002** — Settings → "Region" — picker with country list + "auto" (device locale). Stored as ISO 3166-1 alpha-2.
- [ ] **TN-V2-CTX-003** — Settings → "Budget" — per-category optional. Three tiers: `$` / `$$` / `$$$`. Skipped categories impose no filter.
- [ ] **TN-V2-CTX-004** — Settings → "Languages" — multi-select from BCP-47 list. Defaults to `[device-locale]`.
- [ ] **TN-V2-CTX-005** — Settings → "Devices" — multi-select compatibility profile (iOS / Android / macOS / Windows / Linux / iPad / web). Affects `compat_tags` filtering.
- [ ] **TN-V2-CTX-006** — Settings → "Dietary" — multi-select (vegan, vegetarian, halal, kosher, gluten-free, dairy-free, nut-free, …). Optional.
- [ ] **TN-V2-CTX-007** — Settings → "Accessibility" — multi-select (wheelchair, captions, screen-reader, color-blind-safe, …). Optional.
- [ ] **TN-V2-CTX-008** — `useViewerPreferences()` hook — subscribes to keystore, exposes `{ profile, isHydrated }`. Powers the filter/badge logic on every screen.

## 3. Phase 2B — Subject metadata enrichment (Cluster B)

Server-side: schema additions + enricher upgrades. New columns on `subjects.metadata` (a single JSONB bag per Plan §3.6.2 — NOT new top-level columns; we already enrich into that bag).

- [ ] **TN-V2-META-001** — `subjects.metadata.availability` — `{ regions: ISO[], shipsTo: ISO[], soldAt: host[] }`. Optional reviewer-declared in the attestation; auto-filled by enricher from URL TLD when missing.
- [ ] **TN-V2-META-002** — `subjects.metadata.price` — `{ low_e7, high_e7, currency, lastSeenMs }`. CBOR-int convention same as `serviceArea.latE7/lngE7`.
- [ ] **TN-V2-META-003** — `subjects.metadata.compat` — `tags: string[]` from a curated closed list (`ios`, `android`, `macos`, `windows`, `usb-c`, `lightning`, `110v`, `240v`, …). Open-ended list expanding by deliberate enrichment.
- [ ] **TN-V2-META-004** — `subjects.metadata.schedule` — `{ hours: 7-day map, leadDays, seasonal: month[] }`. Optional. Reviewer-declared; auto-filled by enricher from JSON-LD `OpeningHours` markup where present.
- [ ] **TN-V2-META-005** — `subjects.metadata.compliance` — `tags: string[]` (`halal`, `kosher`, `vegan`, `gluten-free`, `fda-approved`, `ce-marked`, `age-18+`, …). Reviewer-declared.
- [ ] **TN-V2-META-006** — `subjects.metadata.accessibility` — `tags: string[]` (`wheelchair`, `captions`, `screen-reader`, `color-blind-safe`, `audio-described`, …).
- [ ] **TN-V2-META-007** — Enricher: `host_to_region.ts` curated map (TLD heuristic — `.uk` → `GB`, `.in` → `IN`, plus per-host overrides for amazon-* / etsy / shopify-* etc.). Sets `metadata.availability.regions` when not already set by reviewer.
- [ ] **TN-V2-META-008** — Enricher: ASIN region detection — `amazon.com` host implies US ASIN, `amazon.co.uk` implies UK ASIN, etc. Sets `metadata.availability` automatically.
- [ ] **TN-V2-META-009** — Enricher: OpenGraph price extraction — fetch `<meta property="product:price:amount">` from the subject's URL when reviewer hasn't declared price. Best-effort; rate-limited; fallback graceful.
- [ ] **TN-V2-META-010** — Enricher: JSON-LD `OpeningHours` parser for `place` subjects. Falls through to reviewer-declared schedule if no markup.
- [ ] **TN-V2-META-011** — Subject `lastActiveMs` — server-derived freshness signal. Updated when any new attestation lands on the subject. Powers the "stale" badge in §5.

## 4. Phase 3 — Review-structure additions (Cluster C)

Lexicon additions + Write form. Existing V1 attestations remain valid (all new fields optional). Schema-validated by AppView record-validator.

- [ ] **TN-V2-REV-001** — Lexicon: `com.dina.trust.attestation.useCase` — optional free-text from a per-category curated list (`everyday`, `professional`, `travel`, `kids`, …). Up to 3 tags. Enables use-case-aware ranking.
- [ ] **TN-V2-REV-002** — Lexicon: `attestation.reviewerExperience` — optional enum `novice|intermediate|expert`. Self-declared. Future: scorer can weight expert reviews higher in technical categories.
- [ ] **TN-V2-REV-003** — Lexicon: `attestation.lastUsedMs` — optional ms-since-epoch when reviewer last interacted with the subject. Distinct from `createdAt` (review write time). Powers freshness even when the review itself is recent.
- [ ] **TN-V2-REV-004** — Lexicon: `attestation.recommendFor` / `notRecommendFor` — optional string[] use-case tags. "Recommend for everyday writing; not for calligraphy."
- [ ] **TN-V2-REV-005** — Lexicon: `attestation.alternatives` — optional `SubjectRef[]` of other subjects the reviewer also tried. Enables "the reviewer also looked at X, Y" surfaces. Plan §6.3 conflict_chooser dovetails here.
- [ ] **TN-V2-REV-006** — Mobile: Write form — use-case picker (multi-select, per-category vocabulary).
- [ ] **TN-V2-REV-007** — Mobile: Write form — last-used date picker (defaults to "today"; collapsible section so casual reviewers don't see it).
- [ ] **TN-V2-REV-008** — Mobile: Write form — alternatives selector (search-based; reuses existing search xRPC + the subject card row component).
- [ ] **TN-V2-REV-009** — AppView: ingester handler accepts the new fields; record-validator schema covers them; enricher passes them through unchanged.
- [ ] **TN-V2-REV-010** — Tests: write_form_data tests cover the new optional fields; record-validator tests pin the new schema; ingester unit tests cover both paths (with + without new fields).

## 5. Phase 4 — Ranking, alternatives, and warnings (Cluster D)

The biggest lift. Closes the remaining gaps (5, 7, 9, 10, 11, 12).

### Search xRPC filters (small)

- [ ] **TN-V2-RANK-001** — `search` xRPC: `viewerRegion` filter — bounded by `metadata.availability.regions` containment. Excludes subjects unambiguously unavailable in the viewer's region.
- [ ] **TN-V2-RANK-002** — `search` xRPC: `priceRange` filter — `low <= max AND high >= min`. NULL price = include (we don't penalise unknown).
- [ ] **TN-V2-RANK-003** — `search` xRPC: `compatTags` filter — array overlap with `metadata.compat.tags`.
- [ ] **TN-V2-RANK-004** — `search` xRPC: `dietaryTags` / `accessibilityTags` filters — array containment.
- [ ] **TN-V2-RANK-005** — Mobile: filter chips on `/trust/search` driven by viewer profile from `useViewerPreferences()`. Off by default; user opts in per session.

### Score / ranking changes (medium)

- [ ] **TN-V2-RANK-006** — Scorer: per-category recency-decay tuning. Tech moves fast (6mo half-life), books slow (5yr half-life), restaurants medium (1yr). Configurable in `appview_config`.
- [ ] **TN-V2-RANK-007** — Scorer: viewer-region boost (NOT a filter — a sort tweak). Subjects available in viewer's region rank slightly higher; no penalty for unavailable so the user can still discover.
- [ ] **TN-V2-RANK-008** — Scorer: personalisation hook — taste-profile match between viewer's prior reviews and the candidate reviewer's history boosts that reviewer's weight. Defer to a later phase if the privacy story isn't crisp (computing taste-profile match without leaking either party's reviews to AppView is non-trivial — likely needs ZK proofs which are V3+).

### New surfaces (medium)

- [ ] **TN-V2-RANK-009** — New xRPC: `getAlternatives(subjectId, count, viewerCtx?)` — top-N trusted alternatives in the same category. Powers the "3 trusted alternatives" strip on subject detail.
- [ ] **TN-V2-RANK-010** — New xRPC: `getNegativeSpace(viewerDid, category)` — flagged-by-1-hop subjects in a category. Powers the proactive warning surface.
- [ ] **TN-V2-RANK-011** — Mobile: subject card — recency badge ("3 years old") when category-tuned half-life threshold is exceeded.
- [ ] **TN-V2-RANK-012** — Mobile: subject card — region pill ("📍 UK only") when `availability.regions` doesn't include viewer region.
- [ ] **TN-V2-RANK-013** — Mobile: subject card — price-range chip (`$$$`) when `metadata.price` is known.
- [ ] **TN-V2-RANK-014** — Mobile: subject detail — "3 trusted alternatives" strip below the review list. Tap → search results scoped to category.
- [ ] **TN-V2-RANK-015** — Mobile: subject detail — flag-warning banner ("2 of your contacts flagged this brand"). Surfaces only when the viewer has 1-hop flags on the same brand/category.
- [ ] **TN-V2-RANK-016** — Mobile: search filter chips — "in my region" / "in my budget" / "compatible with my devices". Off by default.

## 6. Tests

- [ ] **TN-V2-TEST-001** — `apps/mobile/__tests__/trust/` — viewer-preferences keystore round-trip + locale-defaults test.
- [ ] **TN-V2-TEST-002** — `apps/mobile/__tests__/trust/subject_card.test.ts` — extend with new chip variants.
- [ ] **TN-V2-TEST-003** — `appview/tests/unit/host_to_region.test.ts` — TLD heuristic + per-host override map.
- [ ] **TN-V2-TEST-004** — `appview/tests/unit/subject_enrichment.test.ts` — extend with availability/price/schedule paths.
- [ ] **TN-V2-TEST-005** — `appview/tests/unit/record_validator.test.ts` — extend with the new optional attestation fields (accept-with + reject-on-malformed).
- [ ] **TN-V2-TEST-006** — `appview/tests/integration/` — search filter tests for `viewerRegion`, `priceRange`, `compatTags`.
- [ ] **TN-V2-TEST-007** — `appview/tests/integration/` — `getAlternatives` xRPC.
- [ ] **TN-V2-TEST-008** — `appview/tests/integration/` — `getNegativeSpace` xRPC.
- [ ] **TN-V2-TEST-009** — Property test: per-category recency-decay monotonicity (older = lower decay weight; same age = same weight).

## 7. Documentation

- [ ] **TN-V2-DOCS-001** — `docs/trust-network/V2-actionability.md` — public-facing explainer of the actionability layer (the 12 gaps, the 4 clusters, what users see in the UI).
- [ ] **TN-V2-DOCS-002** — `docs/trust-network/threat-model.md` — extend §7 ("V1 does NOT promise") with V2 promises and the new privacy surface (viewer profile is keystore-resident; never sent to AppView; filtering is mobile-side).
- [ ] **TN-V2-DOCS-003** — `docs/trust-network-walkthrough.md` — extend with §11 "V2 actionability layer" pointing at the new cluster A/B/C/D shape.

---

## Total: 56 tasks across 7 sections

| Section | Count |
|---|---|
| 1 Phase 1 (surface existing) | 5 |
| 2 Phase 2A — Viewer profile | 8 |
| 3 Phase 2B — Subject metadata | 11 |
| 4 Phase 3 — Review structure | 10 |
| 5 Phase 4 — Ranking + surfaces | 16 |
| 6 Tests | 9 |
| 7 Docs | 3 |
| **Total** | **62** |

## Working agreement

- Same as V1: pick one task at a time. `[-]` when starting, `[x]` when merged. Block? `[!]` + one-line reason.
- Phase 1 first — surface existing metadata buys credibility for the V2 framing before the larger schema work lands.
- Phase 2A and 2B can land in parallel (one is mobile-only, one is server-only).
- Phase 3 lexicon additions need a `@dina/protocol` minor bump and a conformance-vector regen — coordinate with the protocol changelog.
- Phase 4 personalisation (TN-V2-RANK-008) has a privacy gate — defer if the ZK story isn't ready.
- New tasks discovered mid-flight: append to the relevant section with the next sequential ID.
