# Dina Mobile — Release-Readiness Audit (2026-06-08)

Deep check of every screen and action in `apps/mobile`: copy quality (AI-isms,
em-dashes, phrasing, logic), visuals (colour/fonts/layout vs the design system),
functionality completeness, and logical consistency — plus a live run on the
booted iPhone 17 Pro sim (idb / Maestro).

Method: 7 parallel per-screen-group code audits (38 routes + 40 components) +
design-system review of `theme.ts` + live walkthrough/functional tests. Key
"doesn't work" claims were re-verified against the source before listing.

---

## Verdict

**The core personal-AI loop is release-ready and was validated live.** Remember,
Ask, persona-routing to locked vaults, identity, vault, people, settings,
activity/approvals all hold up. The design system is strong and well-respected.

**Two areas are NOT production-wired and need an explicit ship/scope decision:**
1. **PeerLens *write*** (publishing reviews) — no durable production publish path.
2. **Services *provider* role** + **PeerLens preference filters** + **namespaces** —
   reachable UI that collects input or offers actions that do nothing yet.

PeerLens *read* (search/browse via AppView) works. The blockers cluster around
*contributing* to PeerLens and *providing* services — not the everyday user loop.

Beyond those, there is a focused, fixable list of copy (em-dashes, jargon leaks,
a wrong version string) and design-token fixes (3 Android-breaking fonts, ALL-CAPS
timestamps, ~11 hardcoded colours).

---

## Validated live on iPhone 17 Pro (works)

- **Remember → routing**: `Emma loves dinosaurs` → "Stored in General vault"; repeatable.
- **Ask (real LLM round-trip)**: `What does Emma like?` → answer contains "dinosaur".
- **Persona routing to locked vaults**: HbA1c → "Stored in **Health** vault"; Barclays →
  "Stored in **Finance** vault" — **with no approval prompt** (owner-in-app is trusted;
  the gate is for external agents). Confirmed in `vault` (Health 1, Finance 1, General 2).
- **Navigation/visuals**: Chat, People, Network/PeerLens, Activity, Settings, Vault,
  Reminders, Help all render cleanly with consistent type/colour and good empty states.

Note: the "Downloading 100%…" band at the top is the **Expo dev-client Metro
indicator** and the floating gear bubble is the **dev menu** — both are dev-only and
absent from release builds.

---

## P0 — Decide before a public release (feature completeness)

These are tracked/known-scope items, not accidental regressions. Each needs a
"ship it / hide it / cut it" call.

1. **PeerLens review publish has no durable production path.**
   `src/peerlens/outbox_store.ts` is explicitly *in-memory only (V1 scope), lost on
   app restart* (TN-MOB-007). In production (no `EXPO_PUBLIC_DINA_TEST_INJECT_TOKEN`),
   `write.tsx` → `enqueueLocal()` parks the review in that in-memory store; the outbox
   screen shows it as queued forever and it never reaches AppView/PDS. The only working
   publish is the DEV test-inject path. (A *separate* durable D2D outbox drainer exists —
   `boot_capabilities.ts startOutboxDrainer` — but it does not serve the PeerLens write.)
   → If PeerLens contribution is in-scope for v1, wire the real PDS `createRecord` runner;
   if not, hide the write/compose CTAs and the Outbox link.

2. **PeerLens preference filters are collected but do nothing.**
   `src/peerlens/preferences/viewer_filters.ts`: region/budget/devices/dietary/accessibility
   are all `isApplicable: STUB_NEVER_APPLIES` pending TN-V2-META-*. Only **languages** is
   live. The Settings → PeerLens preferences screens let users configure budget bands,
   devices, dietary, accessibility — none affect any result. → Hide those rows (keep
   languages) or mark them "coming soon" until the consuming logic ships.

3. **Namespaces management is presentational-only.** `app/peerlens/namespace.tsx` is
   mounted with no runner: after a timeout it shows "DID document unavailable" and the
   "+ Add namespace" CTA is inert. → Hide the Namespaces footer link or wire the PLC
   signing flow.

4. **Services provider: capability runner hardcoded to `'transit'`.**
   `app/service-settings.tsx:369` `mcpServer: prior?.mcpServer ?? 'transit'`. Any
   non-transit provider (bakery, generic) publishes a config that routes inbound queries
   to a nonexistent "transit" runner → the service silently can't answer. Real
   correctness bug for the provider role. → Derive the runner from the capability, or
   require the user to pick one.

5. **PeerLens cosignature-release safety warning never fires.**
   `write.tsx:713` derives the "editing releases cosignatures" warning from
   `editing.cosigCount`, but both edit entry points hardcode `editingCosigCount: '0'`
   (`peerlens/[subjectId].tsx:226`, `reviewer/[did].tsx:220`). Editing a cosigned review
   silently destroys others' endorsements with no warning — the exact case the warning
   exists for. (Tied to PeerLens write being in-scope.)

---

## P1 — Should fix before public release

### Copy / correctness
- **Wrong version string**: `settings.tsx:401` shows `Dina v0.1.0` but `app.json` is
  `0.0.1`. Derive from `expo-constants`.
- **Internal jargon leaked to users** (humanize these):
  - `service-settings.tsx:587` shows raw codes: "Missing: publisher.stub, transport.msgbox.missing".
  - `my-listings.tsx:88` Alert: "boot wires ServicePublisher + ServiceHandler".
  - `_layout.tsx:664` "dev-degraded mode"; `admin.tsx:422` "Rebuild the dev client to enable it".
  - `service-settings.tsx:587-590` "wires PDS + MsgBox… reach AppView".
- **Raw error text shown to users**: `unlock_gate.tsx:153,226` and
  `existing_atproto_identity.tsx:44` concatenate raw exception/SDK strings into UI error
  messages. Show friendly copy, log the raw error.
- **`humaniseAskError` never runs**: `hooks/useChatAsk.ts` is dead (only its test imports
  it). The live path (`index.tsx` → `useLiveThread` → `handleChat`) shows raw vendor
  errors (quota/401/timeout). Wire `humaniseAskError` into the live error surface or delete it.
- **Worst prose**: `help.tsx:54` reminder card ("Since Dina also knows the context about
  the user, the reminder has extra context added… dinosaur toys suggested") — rewrite to
  active voice; it also duplicates the Sancho cold-brew example used by the Talk card (`:66`).
- **Risk enums shown raw**: `approval_inbox.tsx:303` displays `SAFE`/`MODERATE`/`HIGH`/`BLOCKED`
  verbatim. Humanize ("High risk", "Needs review").
- **Terminology fragmentation**: the services feature is called Services / My Services /
  Listings / Service Sharing / service profile / node across screens; and `vault/[name].tsx:157`
  leaks "persona" ("No persona named …") on a screen that otherwise says "vault". Pick one
  noun per concept (`FEATURE_NAMES.services = 'Services'`; user-facing = "vault").

### Functionality
- **No delete-vault anywhere** (`vault/index.tsx` `void Alert` placeholder; nothing in
  `[name].tsx`). Contradicts "personas are user-configurable (add **and delete**)". A
  mistyped vault is permanent.
- **Reminder snooze built but not surfaced**: `useReminders.ts:126-164` ships
  `snoozeReminderBy`/presets, documented in the hook header, but the Reminders UI only
  offers long-press → Dismiss. Wire snooze or drop the API/claims.
- **No contact trust editing**: `add-contact.tsx:121` hardcodes new contacts to
  `'verified'` and the "contact detail view" to change it is "not built yet". For a
  trust-centric product, an uneditable trust level is a gap.
- **chat/[did] "Add to contacts" doesn't pre-fill the DID** (`[did].tsx:154` `router.push('/add-contact')`
  with no params) despite its own docstring claiming it does — user lands on a blank form.
- **Create-vault validation mismatch**: button enables on non-empty
  (`vault/index.tsx:268`) but the hook requires 2–30 chars `[a-zA-Z0-9_-]`; "my trip"
  passes the gate then fails after tapping Create. Mirror the real rule inline.
- **region.tsx nav inconsistency**: selecting a country `router.replace('/settings')`
  (skips the prefs index) while header-back goes to the index — two "up" destinations.
- **region.tsx loading gate**: `!isHydrated` "Loading…" guards only the list; the search
  box + Auto row are live above it on cold open.

### Visual (design-system drift)
- **Android-breaking mono font**: `fontFamily: 'Menlo'` (iOS-only) in `ai-providers.tsx:440,455`
  (API-key display/input) and `InlineVaultReadApprovalCard.tsx:281`. On Android it falls
  back to sans → broken key display. Use `textStyles.mono`/`monoSmall`.
- **ALL-CAPS timestamps**: `vault/[name].tsx:643` item meta spreads `textStyles.eyebrow`
  (`textTransform: 'uppercase'`) → "APR 29, 2026 3:14 PM". Same `eyebrow`-misuse in
  `reminders.tsx:210` (persona badge) and `my-listings.tsx:206` (section header smaller
  than siblings). Use `textStyles.caption`.
- **Approvals risk bands ignore the risk palette**: `approval_inbox.tsx:540` uses
  warning/error tokens; `theme.ts` ships `colors.riskLow/Med/High/Admin` for exactly this
  surface (used correctly in `policy.tsx`). The canonical risk surface is the inconsistent one.
- **Maturity badge hardcodes 6 hex values** (`peerlens/components/subject_card_view.tsx:72`)
  — the only colour-token bypass in PeerLens, plus a muted-grey-on-pale contrast risk.
- **TrustBadge hardcodes 3 hex** (`people.tsx:508`) where tokens exist (`errorBgSofter`,
  `bgTertiary`, `successBgSoft`).
- **`ActivityIndicator color="#FFFFFF"`** instead of `colors.white` in several places
  (`unlock_gate.tsx`, `chat/[did].tsx:203`, `add-contact.tsx`, `people.tsx:451`).
- **BootBanner hardcodes bg/border hex** (`_layout.tsx:1076`) where tokens exist.

### Logic
- **`BLOCKED` intent could render an enabled Approve** (`approval_inbox.tsx:188`). Verify
  upstream that BLOCKED never mints an approval task; if it can, hard-disable Approve.
- **Two divergent `needs_action` definitions** (`notifications.tsx:53` vs dead
  `screen_filter.ts`); `ask_approval` notifs never reach the "Needs action" filter.
- **Recurring-reminder dismiss "reappears"** with no hint it's the next occurrence
  (`reminders.tsx:106`). Make the confirm dialog occurrence-aware.
- **Self-review band-shame** suppressed on detail (`[subjectId].tsx:671`) but not on
  feed/search cards (`subject_card_view.tsx:246`).

---

## P2 — Polish (themes; full list in the agent notes)

- **Em-dashes in user-visible prose** (the explicit ask). Confirmed in UI strings:
  `ai_provider_set.tsx:162`, `unlock_gate.tsx:202`, `admin.tsx:390`, `service-settings.tsx:517,522,563,599`,
  `my-listings.tsx:60`, `confirm-recovery-phrase.tsx:155`, `paired-devices.tsx:108`,
  `peerlens/namespace.tsx:112`, `peerlens/reviewer/[did].tsx:416`, `peerlens/write.tsx:1171,1531,1585,1643,1757,1805`,
  `InlineServiceQueryCard.tsx:325`, `InlineQuarantineCard.tsx:115`, `identity_modal.tsx:222`,
  `ai/provider.ts:261,297,308,326,340` (provider error toasts), `oauth_flow_store.ts:69`,
  `edit_flow.ts:107`, `first_run.ts:76`, `useChatAsk.ts:211`, `useAuditLog.ts:127`.
  (Borderline-OK as typographic dashes: citation dash in `subject_card_view.tsx:246`;
  date-range en-dash in `InlineBriefingCard.tsx`; `'—'` empty-value placeholders.)
  Good news: **zero AI buzzwords** (delve/seamless/robust/leverage/etc.) anywhere.
- **Capitalization inconsistency**: Title Case ("Generate Pairing Code", "Remove API Key",
  "Invalid Key") vs sentence case ("Save changes", "Use this provider"). Standardize.
- **Ellipsis style**: `useUnlock.ts:259` uses ASCII "..." while the rest uses "…".
- **Serif glyph as chevron**: `textStyles.h2/h3` (Cormorant) used for "›" in `help.tsx`,
  `policy.tsx:449`, `peerlens-preferences/index.tsx`. Use `Ionicons chevron-forward`.
- **Dead code/styles** (cleanup): `heroTitle` (index), `etaPrimary/etaSecondary/mapButton*`
  (InlineServiceQueryCard), `approveCommand` (InlineServiceApprovalCard), `heavy`-tier
  scaffolding (ModelPickerSheet), `screen_filter.ts`, dead StyleSheet entries in
  recovery/confirm-recovery, vault `formCard`, service-settings `knownCap*`/`helpText`.
- **Stale docstrings**: `admin.tsx:1-20` describes "Coming soon"/auto-start/risk-threshold
  sections that no longer exist; `chat/[did].tsx:9` and `paired-devices.tsx:54` describe
  behavior the code dropped.
- **Reminders tab**: no error state and no pull-to-refresh (focus-only refresh).
- **Frozen TTL countdown** "expires in 0s" lingering (`approval_inbox.tsx:289`).
- **"known_only" copy overstates enforcement** (`service-settings.tsx:599`): "the provider
  controls who may use the service" while the documented known-gap is URI-possession with
  no caller-contact gate yet.

---

## Design system status (theme.ts)

Strong and centralized: one source of truth for `colors`, `spacing`, `radius`, `fonts`,
and a canonical `textStyles` type scale. Adherence is high — only **~11 hardcoded-hex
sites** app-wide (index, add-contact, people, _layout, chat/[did], unlock_gate,
onboarding/shell, subject_card_view), **3 `Menlo` font sites** (Android-breaking), and a
scattering of raw spacing numbers (`marginTop: 2`, tab-bar `49` duplicated 3×). The two
systemic visual bugs are: (a) `Menlo` instead of the mono token, and (b) `eyebrow` token
(uppercase) reused for running meta/timestamps → ALL-CAPS.

---

## Honest gaps in this pass (not yet driven live)

- Talk/D2D (MRS-04/05), Task-via-agent (MRS-06), agent vault-read/risky-action approvals
  (MRS-07/08), public-service E2E (MRS-10), known_only (MRS-11) — need a 2nd Dina + paired
  `dina-agent`; covered by static audit only here.
- Guided demo end-to-end (validated in the prior session; static audit passed).
- Existing-Bluesky OAuth login (real external credential) and full Restore-into-clean-install
  (OS document picker) — manual per the test plan.
- Android visual pass (no emulator booted this run) — the `Menlo` bug specifically needs it.

---

## Update — fixes applied (2026-06-08, uncommitted)

All in the working tree; tsc clean (0 errors); 712 tests pass across the touched
suites (peerlens 285, services 312, components+onboarding 115). Nothing committed.

**Copy / AI-isms (all user-visible em-dashes removed):** onboarding, chat cards,
service-settings, my-listings, admin, recovery, paired-devices, peerlens
write/namespace/reviewer, provider error toasts, help, model picker, etc. Zero
user-visible em-dashes remain (only JSDoc/LLM-prompt/dev-log dashes left).

**Correctness / functionality:**
- `service-settings.tsx` capability runner defaults to `openclaw` (was hardcoded
  `transit`, which black-holed non-transit providers).
- Settings version reads from `expo-constants` (was a stale hardcoded `v0.1.0`).
- PeerLens prefs: Budget/Devices/Dietary/Accessibility → "Coming soon" (disabled);
  Region + Languages stay live; Loyalty-Law-contradicting subtitle fixed.
- Namespaces → clean "Coming soon" screen (was a spin-to-error).
- chat → "Add to contacts" pre-fills the peer DID; region select returns to the
  prefs index (was jumping to Settings).
- Jargon leaks humanized (raw blocker codes, `ServicePublisher/ServiceHandler`,
  "dev-degraded mode"). Help "Reminders" card rewritten (worst prose) + de-duped.

**Visual / design tokens:** `Menlo` → `textStyles.mono` (×3; fixes Android key
display); ALL-CAPS vault item meta → `caption`.

**Flagship — real PeerLens publish (DONE + tested):**
- `boot_capabilities.ts`: builds the authed `PDSPublisher` for ALL roles (lazy for
  non-providers; providers keep eager validation). `bootstrap.ts`: exposes it on
  `DinaNode`.
- `src/peerlens/publish_attestation.ts` (new): `publishAttestationToPDS()` —
  identity-gated **authed** `putRecord(com.dinakernel.peerlens.attestation, …, rkey)`
  (NOT the unauthed `publishToPDS`), the same sovereign path service profiles use
  (PDS → Jetstream → AppView). Unit-tested.
- `write.tsx`: production publish goes through it with a **stable rkey**; test-inject
  kept for fast E2E.
- **Durable outbox (TN-MOB-007):** `src/peerlens/review_outbox_durable.ts` (new) —
  SQLCipher-backed via `@dina/core/kv` (no schema migration). Offline reviews persist
  with the full record + stable rkey and survive restart; the drainer replays via the
  same authed `putRecord` (idempotent — same rkey, so a crash-after-accept can't
  duplicate). `outbox.tsx` hydrates on mount and drains on mount + app-foreground +
  manual retry. Unit-tested (persist/load, drain success+remove, failure+attempt-bump,
  dead-letter, stable-rkey idempotency).
- Verification: tsc 0; 1573 peerlens tests + 312 services + 115 components/onboarding
  green.
- **LIVE WIRE TEST PASSED (2026-06-08):** with the inject token temporarily
  disabled + Metro cache cleared, a review published from the sim landed in the
  user's **PDS repo** (`com.dinakernel.peerlens.attestation/mob-…`, real CID
  `bafyreib5g4pci7…`, not the inject placeholder) AND was **ingested by AppView**
  via Jetstream (same uri + CID, searchable). Sovereign round-trip phone → PDS →
  firehose → AppView confirmed. `.env` restored afterward (git-clean). Test records
  `QAWireReal Chair` (real path) + `QAWireCheck Chair` (inject, from the first run
  before the cache-clear) remain on test-pds/test-appview under the test identity —
  harmless test data, deletable via the app.

**Additional P1 fixes (2026-06-08, after the live test):**
- #3 raw-error handling: the live ask path already humanizes (brain
  `humaniseProviderError` + `ask_handler` fallback), so the dead, redundant
  `useChatAsk`/`humaniseAskError` module + test were **deleted**; fixed an em-dash
  in the live fallback (`ask_handler.ts`); added a defensive try/catch around the
  chat send so an unexpected throw surfaces a friendly message.
- #4 unlock/identity errors: raw exception text → friendly copy (raw error to
  `console.warn` for diagnostics) in `unlock_gate` (×2) + `existing_atproto_identity`.
- #5 vault-name validation: the Create button + an inline hint now mirror the hook
  rule (2–30 chars, `[a-zA-Z0-9_-]`) — no more "tap Create, then rejected".
- #6 terminology: persona-leak fixed ("No vault named …"); service-settings screen
  title is consistent ("New/Edit listing"); node/profile jargon in its alerts →
  service/listing.

**Self-review hardening on the durable-publish work (2026-06-08, code-review rounds):**
Each finding below was a review note on my OWN publish/outbox changes, verified
against the source, then fixed (tsc clean + targeted tests green each round):
- Refactored publish/retry logic OUT of the route files into mobile-local services
  (`src/peerlens/review_publish_service.ts` + `review_outbox_durable.ts`); the
  `write.tsx`/`outbox.tsx` routes now just delegate.
- Permanent vs transient publish failures: identity mismatch + over-length text
  (`AttestationIdentityMismatchError`/`AttestationLexiconError`) surface an
  actionable error instead of being queued for futile retries; pre-write lexicon
  guard (2000-char cap) + matching form-level cap so a record can't "publish" yet
  silently fail AppView ingestion.
- Boot: a transiently-unreachable PDS no longer blocks startup. The lazy publisher
  is kept for the review-outbox drainer, but `pdsSessionReachable=false` now gates
  the service-profile `ServicePublisher` construction so its load-bearing initial
  `sync()` (which re-auths and throws out of `start()`) never runs — the intended
  `publisher.stub` degradation stays a degradation, not a `BootStartupError`.
  (bootstrap regression + faithfulness sentinel tests added.)
- Dismissing a queued review now releases its originating inline chat-draft card
  from the `publishing` state (→ `discarded`); previously the card stayed stuck,
  un-publishable, after the queue row was gone.
- Concurrency + edge-case hardening on the drain path: (a) single-flight guard so
  the screen, foreground, global autodrain, and manual retry can't run overlapping
  passes that resurrect a just-published row; (b) the drain re-checks KV existence
  immediately before each public write, so a review the user dismisses mid-pass is
  skipped rather than steamrolled into a publish; (c) the autodrain hydrates the
  originating chat thread before flipping its card to `published`, so a post-restart
  publish can't leave the persisted card stuck in `publishing`; (d) a durable-persist
  failure during queue rolls back the in-memory mirror row and surfaces an error
  instead of an orphan that vanishes on restart; (e) a transient PDS 429/408 now
  queues for retry (only non-retryable 4xx surface as permanent errors).
- Write screen: the combined headline+body length error (`text_too_long`, AppView's
  2000-char composed cap) now renders under the body field — it previously left
  Publish disabled with no explanation; and a queued publish opened from a chat draft
  now routes back to the chat tab (matching cancel/success) instead of the PeerLens
  stack.
- Guided demo (P3): birthday reminder cards now carry an explicit per-card due offset
  so the rendered date matches the body copy ("Today" → today, "in a week" → +7d)
  instead of a blanket per-index offset that contradicted the text.
- Publish-path completeness + queue correctness (review round): (1) the inline chat
  review-draft card (`InlineReviewDraftCard`) now routes its Publish through the same
  `publishReview` decision tree as the full form (test-inject → real PDS → durable queue);
  it previously short-circuited to the dev test-inject endpoint and failed in production
  ("Trust publish endpoint is not configured"). (2) The per-identity queue cap now counts
  only the current DID's durable rows, so 50 stale rows from a previous identity can't
  permanently block publishing. (3) Hydrating a dead-lettered durable row inserts it
  DIRECTLY as terminal (`enqueueDeadLetteredLocal`), bypassing the active-queue cap — a
  full queue no longer hides a dead-letter with no row to dismiss/retry. (4) "Try again"
  on a dead-letter now lifts it out of the failure state (in-flight) before the write, so
  Remove can't drop a review already on the wire. (5) Guided-demo birthday reminders now
  render the absolute next Nov 7 (via `nextNovember7`), not a relative `now + N days` that
  printed a date contradicting the "Nov 7" copy outside that week.
- Identity / cap / scope edge-cases (review round): (1) outbox hydration now filters by
  the booted DID via `hydrateBootedReviewOutbox`, so reviews queued under a previous
  identity (restore / re-onboard) don't show, occupy the cap, or get dismissed by the
  wrong identity; (2) the queue cap is now enforced against the DURABLE active-row count
  (`countActivePendingReviews`), not just the in-memory mirror, so an un-hydrated mirror
  can't wave a 51st review past the cap into the persisted store; (3) the drain marks a
  row in-flight (`submitted-pending`) before the public write so the Outbox hides Dismiss
  (a dismiss can't "cancel" a review already on the wire), reverting to `queued-offline`
  on transient failure; (4) if a guided demo starts mid-write, post-publish cleanup is
  deferred (durable row kept for a later user-scope idempotent re-drain) so the demo-scope
  chat thread isn't patched; (5) `markVerificationPending` now clears a stale
  banner-dismissal so a NEW recovery phrase re-surfaces the confirm reminder. (`.claude`
  lock file was already gitignored — no change needed.)
- Follow-up hardening (review round): (1) fixed a guided-demo test regression from the
  reminder-model change (`/dinosaur/.test(r)` → `r.text`); (2) the combined-length
  (`text_too_long`) error now renders EAGERLY on overflow — a real user can't tap the
  disabled Publish button to reveal it; (3) `dismissReview` now hydrates the chat
  thread before patching, so a dismiss before opening chat post-restart still releases
  the persisted card (was a no-op → stuck in `publishing`); (4) the drain now scopes
  the failure/retry path to JUST the public write (a post-publish cleanup error no
  longer resurrects a published row) and re-checks KV existence in the failure path
  (a row dismissed mid-write isn't re-persisted); (5) the global autodrain is now
  skipped while a `guided_demo:*` scope is active, so a foreground drain can't publish
  a real user-scope review under the demo scope and orphan the user's draft card.

**Remaining / decisions:**
- P1 still open: humanize approval risk enums + hard-disable Approve on BLOCKED;
  raw exception text → friendly copy; `humaniseAskError` wiring; vault-name
  validation; terminology rename (needs a naming decision).
- Parked by user: delete-vault, reminder snooze.
