# THOROUGH_TEST Report — 2026-06-10 (overnight autonomous sweep)

> **Mandate:** drive the whole app via Maestro (creating yamls where missing), find
> UX/UI/functionality issues + bugs, produce a detailed report. **No fixes were
> applied to anything found here** (per instruction). Supporting references:
> `dina_details.md`, `docs/MANUAL_RELEASE_TESTS.md`, `docs/MANUAL_RELEASE_TEST_RESULTS.md`.
>
> **Environment:** iOS sim iPhone 17 Pro (`6D57…BACB7`), dev-client
> `com.dinakernel.mobile` on Metro `:8081` (`--no-dev`), test infra
> (`test-pds` / `test-appview` / `test-mailbox`). Maestro 2.6.0
> (`/opt/homebrew/opt/maestro/bin/maestro`), idb available. App identity:
> `Alon69` / `alon69.test-pds.dinakernel.com`. Artifacts (screenshots/logs):
> `/tmp/thorough_test/`.
>
> **Context:** run immediately after the PUBLIC_SERVICES_TAXONOMY enforcement
> implementation (uncommitted in the working tree — see
> `docs/PUBLIC_SERVICES_TAXONOMY.md`). Where a finding could have been caused by
> that work, it was **stash-bisected against clean HEAD** before attribution.

---

## Executive summary

| Area | Verdict |
|---|---|
| Navigation / tabs / identity | ✅ healthy |
| Remember + persona routing | ✅ healthy (real LLM, correct vault routing) |
| **Ask (chat answers)** | ✅ **RESOLVED** — root cause was depleted Gemini prepayment credits (confirmed by direct 429 probe); healthy after top-up (04:10 probe). Was 🔴 hard-down 4/4 during the sweep. |
| **Reminders from dated facts** | ✅ **RESOLVED** — same root (credits). Post-top-up probe produced both §13.2 reminders. **F-3 (silent drain failure UX) still open.** |
| PeerLens search/browse/launchpad | ✅ healthy (visually verified; flow flakiness is Maestro-side) |
| Services / listing editor (taxonomy surface) | ✅ healthy — full 34-step regression green (visibility tiers, coming-soon tier, catalog-only-under-Public, custom-under-Unlisted, sensitive-public gate + one-tap fixes) |
| Durability (restart) | ✅ healthy — no re-onboard, vault + thread persist |
| Deep links / 404 handling | 🟡 P2 — raw expo-router "Unmatched Route" debug screen user-reachable; one flaky deep link |
| Maestro test infra | 🟡 several committed flows are not actually runnable on the iOS dev-client (details below) |

---

## Product findings

### F-1 (P1) · Ask lane hard-down: every /ask ends "I ran into a problem reaching the AI provider"
- **ROOT CAUSE CONFIRMED (2026-06-10 morning):** direct API probe with the dev key
  (`EXPO_PUBLIC_DINA_DEV_GEMINI_API_KEY`) returns **HTTP 429 `RESOURCE_EXHAUSTED` — "Your
  prepayment credits are depleted"** on ALL models tested (`gemini-3.5-flash`,
  `gemini-3.1-pro-preview`, `gemini-2.5-flash`, `gemini-3.1-flash-lite-preview`). The key
  itself is valid (not 401/403). **Fix = top up credits at https://ai.studio/projects**, then
  re-run one ask probe + one dated-remember probe (F-2).
- **Repro:** Ask chip → any question ("What is my favorite planet?", even "Just say hello to me") → bubble *"I ran into a problem reaching the AI provider. Please try again in a moment."* 4/4 between 02:59–03:07 (screenshots `shot_r2_final.png`, `shot_hello_final.png`, `shot_hello_HEAD2.png`).
- **Attribution ruled out:** reproduced **identically on a clean-HEAD bundle** (working tree stashed, protocol dist rebuilt, Metro reloaded) — so NOT caused by the taxonomy/brain edits.
- **Timeline now explained:** /remember succeeded until 02:57 and ask failed from 02:59 — the credits ran out mid-sweep under the night's automated LLM load; earlier reminder-drain failures (F-2) were most likely the same depletion hitting the heavier drain calls first.
- **Product gap inside the failure:** the error copy is fine, but there is **no retry affordance and no detail** (which provider/model, quota vs network). Consider an inline "Retry" + a diagnostics hint in Settings → AI providers.
- **Cascade:** F-2 and the test-suite false-positives (T-5) are likely downstream of this.

### F-2 (P1) · Dated /remember stores the fact but creates NO reminder — **RESOLVED (credits)**
- **CLOSED 2026-06-10 04:11, after the user topped up:** fresh probe "Mia's school play is on October 20" →
  *Stored in General vault* **+ two reminder cards** (Oct 19 09:00 "tomorrow!", Oct 20 08:00 "today!") —
  exactly the §13.2 contract (`shot_rp2_card.png`). F-1 cleared at the same time ("Just say hello to me" →
  "Hello! How can I help you today?", `shot_ask_recovered.png`). **Both P1s were the depleted prepayment
  credits; no drain regression exists.**
- **Original repro (for the record):** "Emma's birthday is on November 7" → stored, **no reminder card** (60 s);
  same with "Leo's piano recital is on December 12"; Reminders screen "No reminders yet" (`shot_reminders2.png`).
- F-3 (silent drain failure) **still stands** — during the outage the user saw a confident "Stored ✓" and was
  never told the reminder step failed. The new key-health pill (below) narrows but does not close that gap.

### F-3 (P2) · Reminder-drain failures are SILENT — store success masks downstream failure
Regardless of F-2's root cause: when the post-store reminder drain fails, the user sees a confident *"Stored in General vault."* and **nothing else, ever**. No "couldn't set up reminders, will retry", no badge, no retry. For a product whose §13.2 promise is automatic reminders, a silent drop is a trust bug. (Report-only; suggested shape: surface a system chip on drain failure + a durable retry.)

### F-4 (P2) · Raw expo-router "Unmatched Route" debug screen is user-reachable
`dina://activity` (a plausible guess for the Activity tab — the real route is `/notifications`) renders the **stock expo-router 404**: dark debug styling, "Unmatched Route — Page could not be found", and a **"Sitemap" link** (`lf_activity.png`). Any wrong/stale deep link (QR, shared link) lands here. Needs a branded `+not-found` screen; Sitemap must not ship.

### F-5 (P3) · Deep-link inconsistency: `dina://my-listings` silently no-ops (1/1 attempt)
`my-listings.tsx` exists as a route, yet the deep link left the app on Chat (`lf_my-listings.png`), while `people`/`peerlens`/`reminders`/`settings` links navigated fine. Possibly a race with app state; worth a second look when wiring link/QR features (listing share links are on the roadmap — same mechanism).

### F-6 (P3) · Look & feel (screens visually swept: chat, people, network home, browse, search, reminders, listing editor)
- **No layout breakage found** on the swept screens; the Network launchpad, People empty-state, Reminders empty-state, search empty-state ("No results / Review 'coffee'") and the listing editor all render clean and on-brand. The 2026-06-09 fixes (services-card width, modal sheet scroll, centered ×, friendly capability names, visibility copy) all hold.
- Chat's provider-error bubble (F-1) renders as a plain DINA bubble — consistent, though see F-1's retry note.
- Dev-only overlays (Expo gear puck overlapping content, Metro "Downloading 100%…" banner) appear in every dev screenshot — cosmetic in dev, absent in release builds; just noise for screenshot-based review.

### Pre-existing baseline issues (verified NOT from current work; for the record)
- `packages/brain/__tests__/integration/approve_event_to_delegation.test.ts` — 1 failing case on clean HEAD (payload carries one extra field vs expectation).
- `packages/brain/__tests__/resilience/degradation.test.ts` — 1 case, order-dependent flaky (passes in isolation).
- `packages/core` **full-suite single-run hang** (`npx jest --runInBand` sat at 0 % CPU, 0 output, >25 min; killed). Directory-scoped runs are fine (714/714 across service/routes/d2d/transport). Worth finding the hanging suite.
- **Deployed test/prod AppView is stale** for the taxonomy enforcement (old code + pre-2026-06-09 catalog snapshot). Required ops (NOT run autonomously — deploys bounce MsgBox): `deploy_shared_infra.sh update test`, then `npm run emit:catalog -w @dina/protocol` + re-run `appview/scripts/seed_catalog.ts` against the env DB, then curl-verify catalog_version `2026-06-09` and an empty school-intent `searchCapabilities`. Mobile/brain are defended meanwhile (stale-catalog gate + local re-filter).

---

## Test-infrastructure findings (Maestro suite health)

### T-1 (P2) · Several committed flows cannot run on the iOS dev-client as written
- `own_identity`, `remember_recall`, `persona_routing`, `remember_reminder`, `ask_reminder`, `durability/restart_persists` use **bare `launchApp`**, which cold-starts the dev-client into its **server-picker** (no bundle). They only pass with `launchApp: {stopApp:false}` after a deep-link reset (the documented fast-loop pattern). Suggest: a shared `launchApp` convention or an env-var-driven wrapper.
- `restart_persists`'s mid-flow `stopApp`/`launchApp` (the actual restart under test) needs `openLink` with the dev-client URL afterwards (patched copy proved the durability behavior itself is ✅).

### T-2 (P2) · The chat menu (`root-layout-menu-row-*`) is not Maestro-drivable on iOS
The nav menu is an RN `<Modal>`; **Maestro taps on the trigger complete but the menu never opens** (verified: 4 s wait, no menu; **idb tap at the same point opens it instantly** — product fine, `shot_menu_idb.png`). Even when opened, Modal-internal testIDs don't surface to XCUITest (the codebase already documents this in `own_identity.yaml`). `remember_reminder`, `ask_reminder`, `restart_persists` all depend on menu rows → unrunnable as written. Suggest: drive clear-chat via a testable affordance (e.g. long-press on the chat title, or a deep link `dina://chat/new`), or document idb pre-steps.

### T-3 (P2) · Maestro hierarchy-staleness after `pressKey: Enter` + navigation
`peerlens/search_and_review` fails its post-Enter assert (`search-screen`, and even `search-empty`) **while the screen is visibly rendered** — yet the identical flow passes whenever a `takeScreenshot` step sits between Enter and the assert (forces a hierarchy refresh; reproduced 2×fail / 2×pass). Same signature hit `restart_persists`' `send-button` step. Suggest: after keyboard-submit/navigation, insert a screenshot or an `optional` wait step; or assert by text.

### T-4 (P3) · Root-View testIDs can be unreliable (`search-screen`)
The search screen's container id never matched even when children would — consistent with RN view-flattening of style-only Views. Prefer asserting state-bearing child ids (`search-empty` / `search-results`).

### T-5 (P2) · Self-matching text assertions produce false positives
`restart_persists`/recall-style assertions like `.*Neptune.*` match the **user's own seed bubble**, not Dina's answer — my recall probes "passed" while the actual answers were provider errors (F-1). Any flow asserting recall text that also appears in a sent message is unsound. Suggest: clear the thread first AND assert text unique to the answer, or scope to the DINA-bubble container ids.

### T-6 (P3) · No committed flow covered the taxonomy listing editor — added
`apps/mobile/maestro/services/listing_editor_taxonomy.yaml` (new, committed-ready): 34 steps across visibility tiers + provider-specific coming-soon + catalog-only-under-Public + custom-under-Unlisted + sensitive-public gate + save. Green twice tonight.

---

## Flow results matrix

| Flow | Result | Notes |
|---|---|---|
| `tabs_smoke` | ✅ 7/7 | |
| `own_identity` | ✅ (patched launch) | T-1 |
| `remember_recall` | ✅ 11/11 | recall assert subject to T-5 caveat |
| `persona_routing` | ✅ 11/11 | finance/health vault routing correct |
| `remember_reminder` | 🔴 product F-2 | negative half (no-reminder-for-plain-fact) ✅; positive half: no reminder |
| `ask_reminder` | ⏭ not run | same pipeline as F-2 + T-2; would fail for F-1/F-2 reasons |
| `peerlens/search_and_review` | ✅ product / 🔴 flow | screen verified visually; flow needs T-3 fix |
| `services/listing_editor_taxonomy` (new) | ✅ 34/34 ×2 | taxonomy UI regression |
| `durability/restart_persists` | ✅ (patched) | no re-onboard; vault+thread persist; final recall blocked by T-3 then verified via paced probe (answer itself then hit F-1) |
| `talk/*`, `services/bus_eta`, `agent/*` | ⏭ env-dependent | need 2nd Dina / provider daemon / CLI pairing; not run in this sweep (see MANUAL_RELEASE_TEST_RESULTS for last known state) |
| `guided_demo/*` | ⏭ skipped | demo-env flows; heavy; unrelated to this round's risk surface |
| `onboarding_create` | ⏭ skipped | destructive to current identity; covered by MT-01..04 history |

## Taxonomy-enforcement verification (this round's feature — all green)
- Validator: public+sensitive rejected (incl. alias bypass), `subject_auth_needs_review`, explicit-allow caps pass — protocol **511/511**.
- AppView: generic search filters `intentRoutable`; ingester drops public+sensitive at the trust boundary; `isDiscoverable` derived from the enum — appview unit **1911/1911**.
- Brain: local re-filter + rewritten routing prompts — brain **3254 passed**.
- Mobile: stale-catalog gate, stub parity (set + ORDER), alias-aware hydrate — services **320/320**; live sensitive-public gate verified on-sim (alert + one-tap fix + save).
- Full detail + design decisions: `docs/PUBLIC_SERVICES_TAXONOMY.md`.

## Recommended next actions (in order)
1. ~~Top up Gemini prepayment credits + re-test F-1/F-2~~ **DONE 2026-06-10 — both resolved.** Shipped alongside:
   a **key-health pill** on Settings + AI-providers (`src/ai/key_health.ts`, `KeyHealthPill`) that probes the
   BILLED generation path and shows "Credits exhausted" / "Key not working" on the active key (problem-only,
   error verdicts re-probe within 15 s so recovery clears the pill on the next visit; verified live against the
   real depleted→restored key cycle).
2. Ship a branded `+not-found` route (F-4) — small, user-visible.
3. Adopt T-1/T-2/T-3 conventions in the Maestro suite (one PR: launch wrapper + clear-chat affordance + post-Enter pacing); then `ask_reminder`/`remember_reminder` become runnable and F-2 gets a regression net.
4. Run the deployed-AppView ops steps (PSV-001) at the next deploy window.
5. Schedule the env-dependent flows (talk/bus/agent) as their own session with the two-Dina harness.
