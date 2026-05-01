# Trust Network V2 — The Actionability Layer

> **Audience**: implementers, integrators, operators, and researchers
> evaluating Dina's Trust Network for the V2 expansion.
>
> **Scope**: V2 closes the actionability gaps in V1. The V1 ranking —
> "what do my contacts think of X" — is necessary but not sufficient
> to drive a *decision*. A trusted review of a pen sold only in Uganda
> doesn't help a user in San Francisco. V2 layers viewer context,
> subject metadata, and richer review structure on top of V1's signal
> so the user gets answers they can act on.
>
> **Companion docs**: `TRUST_NETWORK_V2_BACKLOG.md` (the task list);
> `threat-model.md` §7 (privacy model — extended for V2);
> `trust-network-walkthrough.md` §11 (V2 cluster overview).
>
> **Status**: living document. Updated as V2 ships.

---

## 1. The problem V2 solves

V1 answers one question: *"do people I trust think this is good?"*

That's a great filter for the **opinion** layer. It's not enough for
the **action** layer. Concretely, here are reviews that pass V1's
filter but still leave the user stuck:

- A "trusted" pen sold only in Uganda — but the viewer is in SF.
- A 5-star Portuguese-language manual — viewer reads English.
- A "great trust score" steakhouse — viewer is vegan.
- An iOS-only app — viewer is on Android.
- A "highly recommended" restaurant that's permanently closed.
- A 5-year-old laptop review still ranking high — tech moves fast.

These aren't bugs in V1. V1 reports trustworthiness *correctly* in all
six cases. What's missing is the *applicability* lens: "yes, this is
trusted, AND it applies to me, AND it's still relevant."

V2 is that lens.

---

## 2. The 12 fundamental gaps

V1 → V2 audit identified twelve concrete gaps where a trust-only
ranking under-serves the user:

| # | Gap | Example failure |
|---|---|---|
| 1 | **Region** | Uganda-only product top-ranked for SF user |
| 2 | **Language** | Portuguese review surfaced to English reader |
| 3 | **Budget** | Premium-only options when user explicitly wants `$` |
| 4 | **Device compatibility** | iOS-only app when user is on Android |
| 5 | **Dietary** | Steakhouse promoted to a vegan |
| 6 | **Accessibility** | No-elevator restaurant for a wheelchair user |
| 7 | **Schedule** | "Best place ever" — but it's closed Mondays |
| 8 | **Freshness** | 5-year-old tech review on a fast-moving subject |
| 9 | **Alternatives** | "X is bad" with no "try Y instead" surface |
| 10 | **Warnings** | No proactive surface for "your contacts flagged this" |
| 11 | **Use-case fit** | Reviewer used it for X, viewer needs Y |
| 12 | **Reviewer expertise** | Novice opinion outranks expert in technical category |

Some are filters (1, 4, 5 — exclude truly inapplicable subjects).
Some are sort tweaks (3, 8 — boost matches, demote non-matches).
Some are new surfaces (9, 10 — content V1 never showed).
Some are richer review fields (11, 12 — let reviewers say more).

V2 partitions these twelve gaps into four implementation clusters.

---

## 3. The four clusters

```
   ┌─ Cluster A ─┐  ┌─ Cluster B ─┐  ┌─ Cluster C ─┐  ┌─ Cluster D ─┐
   │ Viewer       │ │ Subject      │ │ Review       │ │ Ranking +    │
   │ profile      │ │ metadata     │ │ structure    │ │ surfaces     │
   │              │ │              │ │              │ │              │
   │ LOCAL ONLY   │ │ Server-side  │ │ Lexicon +    │ │ AppView +    │
   │ (mobile)     │ │ (AppView)    │ │ Write form   │ │ mobile       │
   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
        Phase 2A         Phase 2B         Phase 3         Phase 4
        (gaps 1-6)       (gaps 1-6        (gaps 11-12)    (gaps 7-12)
                          server side)
```

### Cluster A — Viewer profile

**Where**: `apps/mobile/src/services/user_preferences.ts` +
`app/trust-preferences/*` screens.

The viewer's preferences: region, languages, budget, device
compatibility, dietary, accessibility. Six fields. **Local-only.**

The user picks them in Settings → Trust Preferences. The mobile
client applies them as a *lens* over the un-personalised data
fetched from AppView. AppView never sees the preferences.

This is a deliberate departure from "personalise on the server".
See §6 (Loyalty Law extension) for the privacy rationale.

### Cluster B — Subject metadata

**Where**: `appview/src/db/schema/subjects.ts` (the `metadata` JSONB
bag) + `appview/src/ingester/handlers/*` (the enrichers).

The subject's discoverable attributes:

- `availability`: `{ regions, shipsTo, soldAt }` — where can you get it?
- `price`: `{ low_e7, high_e7, currency, lastSeenMs }` — how much?
- `compat`: `tags[]` — what platforms does it work on?
- `schedule`: `{ hours, leadDays, seasonal }` — when is it available?
- `compliance`: `tags[]` — vegan, kosher, FDA-approved, ...
- `accessibility`: `tags[]` — wheelchair, captions, screen-reader, ...

Some are reviewer-declared (the reviewer can mark the subject as
`vegan` in their attestation). Others are auto-enriched server-side
(URL TLD → region; OpenGraph `<meta>` → price; JSON-LD
`OpeningHours` → schedule).

Reviewer-declared takes precedence over auto-enriched — the human
is more reliable than heuristics.

### Cluster C — Review structure

**Where**: `appview/src/db/schema/lexicons.json` (lexicon additions)
+ `apps/mobile/app/write/*` (Write form additions).

Optional new attestation fields:

- `useCase` — up to 3 tags from a per-category curated list
  (`everyday`, `professional`, `travel`, `kids`, ...)
- `reviewerExperience` — `novice | intermediate | expert`
- `lastUsedMs` — when did the reviewer last interact with the
  subject? (Distinct from `createdAt`, which is review-write time.)
- `recommendFor` / `notRecommendFor` — string[] use-case tags
- `alternatives` — `SubjectRef[]` of other things the reviewer also
  tried

All optional. V1 attestations remain valid. The Write form's UI
makes the new fields collapsible so casual reviewers don't see them.

### Cluster D — Ranking + surfaces

**Where**: `appview/src/api/xrpc/*` (search filters + new endpoints) +
`apps/mobile/app/trust/*` (filter chips, alternative strips, warning
banners).

The connecting tissue. Cluster A gives us the viewer's lens; Cluster
B gives us the subject's facets; Cluster C gives us the reviewer's
nuance. Cluster D wires them into:

- **Search filters** — `viewerRegion`, `priceRange`, `compatTags`,
  `dietaryTags`, `accessibilityTags`. The mobile client opts in
  per-session via filter chips driven by `useViewerPreferences()`.
- **Per-category recency decay** — tech: 6mo half-life; books: 5yr;
  restaurants: 1yr. Subject scores age out at category-appropriate
  rates.
- **Region boost** — `metadata.availability.regions` includes the
  viewer's region → small sort boost. Not a filter — the user can
  still discover.
- **Alternative surfaces** — `getAlternatives(subjectId, n)` xRPC
  serves the "3 trusted alternatives" strip below the review list
  on the detail screen.
- **Negative-space warnings** — `getNegativeSpace(viewerDid, category)`
  surfaces "your contacts flagged this brand" *before* the user
  taps in.
- **Card chips** — recency badge ("3 years old"), region pill
  ("📍 UK only"), price-range chip (`$$$`), already-shipped host +
  language chips.

---

## 4. What users see in the UI

### Settings → Trust Preferences

Eight rows: Region, Languages, Budget, Devices, Dietary, Accessibility
(Cluster A) + Filter Chips toggle (Cluster D).

Each settings screen is tap-to-save (matches the system Settings
app). No "Done" button — the underlying `mutate(updater)` is
race-safe so rapid toggles compose correctly.

### Subject card (search results, trust feed)

Already-shipped chips (V1 + V2 Phase 1):

- Trust band + score
- Friends pill
- Top reviewer headline
- **Host chip** — `amazon.co.uk`, `jumia.ug` (V2-P1-001)
- **Language chip** — `EN`, `PT-BR` (V2-P1-002)
- **Place location chip** — `37.77°N, 122.42°W` (V2-P1-003)

Coming in V2 Phase 4:

- Recency badge — "3 years old" when category half-life exceeded
- Region pill — "📍 UK only" when `availability.regions` excludes
  viewer
- Price-range chip — `$$$` when `metadata.price` is known

### Subject detail

V1 + V2 Phase 1 already shipped:

- Full header chips (host + language + location, larger than the
  card variants)
- Reviews grouped by ring (friends / fof / strangers)

Coming in V2 Phase 4:

- "3 trusted alternatives" strip below the review list
- Flag-warning banner when 1-hop contacts flagged the brand

### Search filter chips

Off by default. Tap to opt in for the session:

- "In my region"
- "In my budget"
- "Compatible with my devices"
- "Matches my dietary preferences"
- "Matches my accessibility requirements"

Driven by `useViewerPreferences()` — chips read the local profile
and pass derived parameters to the search xRPC.

---

## 5. The race-safe profile mutation API

`apps/mobile/src/services/user_preferences.ts` exposes both
`save(next)` (full-profile write) and `mutate(updater)` (functional
update). The Settings screens use `mutate` for per-field toggles.

**Why both?** The `save(next)` API is convenient when you have a
complete profile to write (e.g., a "reset to defaults" button). For
per-field edits, `mutate(updater)` is required — `save` would race
on concurrent edits because each call captures `profile` from the
React render before its predecessor's keystore write completes.

The `mutate` queue:

```
mutate(updater) → enqueue task →
  task runs → reads LATEST snapshot →
  applies updater → writes keystore →
  updates snapshot → notifies subscribers
```

Tasks run serially. Each task reads the snapshot AFTER the prior
task's write resolved, so updates compose. The pattern mirrors
React's `setState((current) => next)` functional update form,
applied to async storage.

A failed task does not poison the queue: the failure propagates to
that specific caller via the returned promise, but the queue chain
catches the error so subsequent tasks still run.

---

## 6. Loyalty Law extension — viewer profile is keystore-resident

V1 promises: "the human holds the encryption keys; the agent cannot
access vault data without them." That's about *content*.

V2 extends the promise to *context*: the viewer's preferences
(region, languages, budget, devices, dietary, accessibility) are
stored ONLY on the device, in the OS keychain. They are:

- Never written to AppView.
- Never embedded in any AT Protocol record.
- Never sent to any server.

This is enforced by code review + a black-box test that stubs
`global.fetch` and asserts zero calls during `save` / `mutate` /
`load`. See `__tests__/services/user_preferences.test.ts` and
`__tests__/screens/*.render.test.tsx`.

**Why this matters.** The natural shape of "personalise rankings"
is a server-side feature: send the viewer's profile to the server,
let the server compute personalised scores. This is what
recommendation engines on consumer platforms do. It's also how
those platforms build user fingerprints over time.

V2 deliberately does not do this. Instead:

1. AppView returns un-personalised data (V1 trust scores +
   subject metadata).
2. The mobile client fetches that data.
3. The mobile client applies the viewer's lens *locally* — filters
   and sorts using preferences from the keychain.
4. The user sees personalised results. The server saw nothing
   personal about the user beyond the un-personalised query.

This is more expensive bandwidth-wise (we fetch results that get
filtered out client-side) and more limited algorithmically (the
mobile client can't run a server-class recommendation model). But
it preserves the loyalty promise: AppView (and any operator
running an AppView mirror) cannot fingerprint the viewer by their
preferences.

For features where this trade-off doesn't pencil out (e.g.,
collaborative-filtering personalisation in V3+), the design path
is ZK proofs — letting the client prove "my profile satisfies
this filter" without revealing the profile. That's deferred.

---

## 7. Non-goals + V3 deferrals

V2 deliberately does NOT include:

- **Custom-defined budget categories.** The Budget screen ships
  with ~10 curated top-level categories; the user can't add
  arbitrary ones. The ranker only consumes a fixed set anyway, so
  user-added tags would no-op. Custom categories are V3+ if
  demand emerges.

- **Diacritic-insensitive search in the Languages picker.** Search
  is exact-substring (case-insensitive). A user typing "espanol"
  won't match "Español". This is the same compromise the country
  picker ships with — fixing both at once is a V3 i18n pass.

- **Cross-device profile sync.** The viewer profile is keystore-
  resident, which means it's per-device. A user with an iPhone +
  iPad sees different preferences on each unless they configure
  both manually. Cross-device sync is fundamentally at odds with
  "the server doesn't see your profile" — sync would either
  leak (sync via server) or require a bespoke peer-sync protocol
  (V3+).

- **Personalised collaborative filtering.** Cluster D's RANK-008
  task explicitly defers personalisation that requires comparing
  the viewer's review history to candidate reviewers' histories.
  The privacy-preserving version of this needs ZK proofs (V3+).

- **Reverse-geocoding the place location chip.** V2 surfaces
  truncated lat/lng (`37.77°N, 122.42°W`) on place subjects.
  Mapping that to "San Francisco, CA" is a Cluster B follow-on
  that requires either a bundled reverse-geocoding dataset or a
  server-side endpoint — both have trade-offs being weighed.

---

## 8. References

- `TRUST_NETWORK_V2_BACKLOG.md` — task list with phase breakdown
- `trust-network-walkthrough.md` §11 — runtime walkthrough of the V2 layer
- `threat-model.md` §7 — V1 privacy promises (extended by V2)
- `apps/mobile/src/services/user_preferences.ts` — keystore schema
- `apps/mobile/src/hooks/useViewerPreferences.ts` — the React hook
- `apps/mobile/src/trust/preferences/multi_select_screen.tsx` — shared multi-select UI
- `apps/mobile/app/trust-preferences/*.tsx` — settings screens
