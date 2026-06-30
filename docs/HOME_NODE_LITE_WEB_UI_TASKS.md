# Home Node Lite — Web UI parity plan

**Status**: Draft v1 (2026-05-17). Superseded by the **thin-client**
direction — see `docs/WEB_THIN_CLIENT_DESIGN.md`. The web build is now a
**thin client of a Home Node Lite server**, not an in-browser node: it boots
no `createCoreRouter`/SQLite and drives the server over the brain-server's
`/api/v1/*` proxy.

> **The web app REQUIRES a running brain-server** (it is not standalone). Start
> a node first (`dina-nodes/start.sh` or a brain-server with `DINA_BRAIN_WEB_UI=1`);
> with no reachable server the SPA shows a "No Home Node reachable" screen, not
> onboarding. Implemented domains: chat/ask, reminders, vault, personas,
> service-config, workflow/approvals, action-policy, identity, contacts, people,
> devices/pairing (list + pair-code). See `implementation-notes.html` for the
> per-domain status + deferrals (PeerLens publish, D2D quarantine, export).

## 1. Vision

Bring the **exact mobile UI** to the home-node-lite stack so users who don't
want a phone app get the same Dina experience in a browser. Mobile is the
**primary surface**: every UX decision starts there, the web bundle tracks
it.

### Non-goals (these are non-negotiable, not nice-to-haves)

- **No UI fork.** We do NOT re-implement screens in plain React. Every
  pixel comes from the same `apps/mobile` codebase via React Native Web
  (RNW). One source of truth, mobile-first iteration.
- **Mobile MUST NOT be degraded in any way to support web.** Dina is
  a mobile-first product. iOS and Android behaviour, performance,
  layout, animations, native interactions — all stay exactly as they
  are today. Web ships by ADDING shims that make the mobile code work
  in a browser; it never ships by removing or changing mobile-side
  behaviour. If a screen genuinely cannot work on web without
  weakening it on mobile, the screen goes into §8 out-of-scope and
  stays mobile-only. This rule is stronger than the
  "no-regression-on-CI" sense: even subtle UX degradation (slower
  animations because of a shim, simplified gestures, dropped haptics
  where they were intentional, lighter blur effects) is forbidden.
- **No new design system.** We reuse `apps/mobile/src/theme.ts`,
  `@expo-google-fonts/*`, the existing component library. The browser
  renders RN's `<View>`, `<Text>`, `<Pressable>` through RNW's DOM
  emitter.

### Why this approach over a separate web app

The user's directive — *"absolutely no duplicates"* — applies as
strongly here as it does to the brain wiring we just deduped. A
separate React web app would mean every chat screen, every settings
row, every persona switcher exists in two places, and the moment
mobile lands a new approval card or a new onboarding step the web
falls behind. RNW removes that drift.

## 1.5. Strong preference — minimize code duplication

**Default position: avoid duplication.** Try hard. Restructure shared
modules, add `*.web.ts` shims, push logic into `packages/brain` or
`packages/core` rather than copy-pasting.

**Escape valve: if avoiding duplication would degrade mobile (or any
other) behaviour, accept the duplication.** Mobile-first is the harder
rule than no-duplication — see §1 non-goals. A shared abstraction that
makes the iOS animation slightly less smooth, drops a haptic, or
weakens a native gesture is the wrong trade. In that case, duplicate
the bit that resists sharing and document why in the source.

These rules are NOT absolute commandments — they're strong defaults
that should win 95% of the time. An absolute "no duplication ever"
directive causes worse mistakes than the duplication itself by
pushing engineers into contortions that hurt other things. Use
judgement; when in doubt, ask.

The user has reinforced minimizing duplication across the codebase
during this build:

- The brain `setRememberCoreClient` + `setRememberDrainHook`
  wiring (mobile + brain-server) → consolidated into
  `@dina/home-node/chat-runtime::wireChatRememberRuntime`.
- The Gemini embedding registration (mobile + brain-server) →
  consolidated into `buildHomeNodeAskRuntime` via the
  `embedding?: {name, generate}` option.
- The `handleChat` orchestrator (mobile + the new `/api/v1/chat`
  HTTP route) → orchestrator owns the logic, brain-server is a
  ~30-line HTTP shim, mobile is in-process.

The exact same discipline must hold for the web UI. The single-tree
Expo Web approach in §2 is the architectural commitment to this rule
— but the rule is bigger than the build target. It governs every
file the plan touches.

### 1.5.1 Default rules — strong, not absolute

The mobile-first rule (#1 below) is **absolute** because the user has
named it as such. The remaining rules are defaults that win unless
breaking them prevents a degradation somewhere else — in which case
duplicate with a comment explaining why.

1. **Mobile is the source of truth and MUST NOT be modified to
   accommodate web.** (Absolute — no exceptions.) Dina is a mobile-
   first product. The mobile screen's layout, behaviour, native
   interactions, and performance characteristics stay exactly as
   they are. If web "doesn't quite fit", the fix lives in the web
   shim (the `*.web.ts` peer of whatever native module the screen
   depends on) — never in the mobile screen itself. If web cannot
   render the screen without a behaviour change on mobile, the
   screen goes into §8 out-of-scope for web. We DROP screens from
   the web build before we degrade mobile to bring them in. This is
   the harder rule than no-duplication: when in conflict, duplicate
   rather than degrade mobile.

2. **Default: hooks are platform-agnostic, web-specific bits go
   into `*.web.ts` peers.** Every hook in `apps/mobile/src/hooks/`
   should serve both platforms via Metro's platform resolution.
   Exception: if making a hook web-compatible requires changing
   how it works on mobile (different lifecycle, different update
   timing), duplicate the hook for web with a comment, don't fight
   it.

3. **Default: utility libraries live in `packages/brain` or
   `packages/core` once.** Date formatting, currency, FTS
   sanitizers, persona display-name formatters — both platforms
   import the same module. Web-specific tweaks go behind a
   `Platform.OS === 'web'` branch in the shared module. Exception:
   if a single shared util becomes a mess of branches, it's
   cleaner to have two cleanly-named utils than one tangled one.

4. **Default: shared shims live next to the native counterparts.**
   `foo.ts` (shared) + `foo.native.ts` (iOS/Android) + `foo.web.ts`
   (browser), all in the same directory, Metro routes. Avoid
   placing the web peer in `apps/home-node-lite/web/...` — that's
   the duplication trap because Metro doesn't see it.

5. **Default: one brain orchestrator.** `handleChat`,
   `planReminders`, `gatherVaultContext`, `evaluateIntent`, the LLM
   router, the persona classifier — all in `packages/brain` or
   `packages/core`. Both mobile (in-process) and web (HTTP through
   brain-server) call the same module. The HTTP boundary is a
   transport. This default is rarely worth breaking — orchestrator
   behaviour drift is exactly the bug class that motivated the
   shared-runtime dedup work today.

6. **Default: one test suite per shared module.** A shim's contract
   test parameterises over the native + web implementations. Two
   separate test files for the same shape is the smell. Exception:
   if the test surface for native is genuinely different (e.g.
   includes hardware-keychain-specific assertions), split.

7. **Default: one Chrome scenario, one Playwright spec, one mobile
   screen.** The scenario backlog in §4.5.3 maps 1:1:1. Drift is
   the failure mode. Acceptable when a scenario covers something
   that intrinsically can't be replicated on the other surface
   (e.g. a Touch ID specific flow).

8. **Default: one source for shared assets.** Icons, fonts, the
   theme palette in `apps/mobile/src/theme.ts` — single file, both
   platforms import it. RNW resolves the imports to DOM-compatible
   equivalents. Exception: a font weight that's free on iOS but
   costs 200KB to load on web might justify a web-specific stack.

9. **Default: one brain-server boot path.** The dev `/dev` route
   built today and the future `/web` route both call the same chat
   orchestrator wiring (`wireChatRememberRuntime`). When the SPA
   ships, retire `/dev` rather than maintain both. Exception:
   `/dev` might survive as a developer escape hatch — fine if it's
   genuinely thinner than `/web` (a non-React inline HTML page,
   like today) and not a parallel implementation of the same UI.

10. **Default: one Core API surface.** Every backend operation the
    web bundle needs has exactly one route on brain-server.
    "Add a web-only route" is usually a sign that the existing
    route needs broadening, not forking. Exception when the web
    needs a genuinely different verb (e.g. streaming SSE vs polling)
    — at that point an additional route is OK.

### 1.5.2 Failure modes to watch for

These have already happened once in this codebase. They will happen
again unless reviewers actively look for them:

- **"Quick web version"**: a screen gets re-written in plain React
  because RNW "doesn't quite work for this case". Always: investigate
  what specifically doesn't work, fix the shim, keep the single
  implementation.
- **"Just for the dev tool"**: a helper gets copy-pasted into the
  dev `/dev` route or a Playwright spec because "it's just for
  testing". Tests are code; they live by the same rules.
- **"Server has its own copy"**: the brain-server gets its own
  date formatter / persona normaliser / FTS query builder because
  the shared one "isn't in the right shape". Reshape the shared
  one; don't fork.
- **"The web doesn't need this"**: a feature gets dropped from web
  with a stub. If web really doesn't need it, the screen is
  out-of-scope. If web DOES need it but the implementation is
  inconvenient, fix the implementation.

### 1.5.3 Enforcement — light-touch, judgement-led

Every phase below ends with a **diff audit** task: read the diff
asking *"did any new file here re-implement logic that already
exists elsewhere? If yes, was that the right call?"*. Either
consolidate, or leave a comment explaining why duplication was the
better trade.

A CI lint at Phase 10 (`scripts/audit_duplication.ts`) helps surface
candidates:
- Identical or near-identical function bodies (≥10 lines, ≥80%
  textual overlap) across files.
- Two files importing from `react-native` with no `.web.ts` /
  `.native.ts` peer alongside (suggests a `Platform.OS` branch in
  the body — fine for small branches, smell for big ones).
- Hook names that exist in both `apps/mobile/src/hooks/` and any
  other location.

The lint is **advisory**. Suppressions are normal — every
suppression is a one-line code comment explaining why the
duplication is the better trade for this specific case. Reviewers
push back on suppressions that look unjustified; they accept ones
that explain a real conflict with the absolute rules (mobile
behaviour, performance, accessibility). The goal is judgement, not
ritual.

---

## 2. Architecture decision

```
┌────────────────────────────────────────────────────────────────────┐
│                  apps/mobile  (single Expo project)                │
│                                                                    │
│  app/* (expo-router screens — iOS + Android + Web)                 │
│  src/components/* (RN components — RNW renders them to DOM on web) │
│  src/hooks/*  (platform-agnostic logic)                            │
│  src/services/* — platform-gated:                                  │
│    foo.ts             ← shared logic                               │
│    foo.native.ts      ← op-sqlite, keychain, expo-notifications    │
│    foo.web.ts         ← IndexedDB, WebCrypto, Notification API     │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  Metro bundler (web target)
┌────────────────────────────────────────────────────────────────────┐
│            apps/home-node-lite/web (static output)                 │
│                                                                    │
│  Served by brain-server at GET /  when DINA_BRAIN_WEB_UI=1.        │
│  Talks to brain-server's HTTP API (chat, ask, reminders, vault).   │
└────────────────────────────────────────────────────────────────────┘
```

**Two builds, one tree.** Expo's Metro bundler already supports a `web`
target; we add `react-native-web` and a `web/index.html` shell. The
build output is a static SPA the brain-server serves from a `/web`
route (similar to how `/dev` works today but for the whole app).

**Storage + identity boundary**:
The brain-server already runs Core in another process and exposes
chat/ask/vault APIs. The web bundle is a **thin client** — no
SQLCipher, no keychain, no master seed in the browser. The user
unlocks the home-node from the browser (passphrase + Ed25519 device
key in IndexedDB), but the master seed lives in Core's process.
This is closer to the "pair a new device" model than to mobile's
in-process model — and that's the right separation for a hosted
home-node.

## 3. Native dependency inventory

Every native module the mobile app uses, with the web equivalent.

| Native module | Used for | Web replacement | Shim file |
|---|---|---|---|
| `@op-engineering/op-sqlite` | Per-persona encrypted SQLite vault | **Not needed** — browser talks to Core via HTTP, never opens a vault locally | n/a |
| `react-native-keychain` | Ed25519 device key, passphrase hint, install marker | IndexedDB + WebCrypto AES-GCM (key wraps from passphrase) | `apps/mobile/src/services/keychain.web.ts` |
| `react-native-argon2` | KDF for passphrase → DEK | `argon2-browser` (WASM) | `apps/mobile/src/services/argon2.web.ts` |
| `react-native-get-random-values` | Polyfill for `crypto.randomBytes` | WebCrypto `getRandomValues` (native in browsers) | already a polyfill — drop on web |
| `expo-secure-store` | Used inside `wrapped_seed_store.ts` | IndexedDB + AES-GCM wrap | shared with keychain shim |
| `expo-notifications` | Reminders, approval cards | `Notification` API + `serviceWorker.showNotification` | `apps/mobile/src/notifications/local.web.ts` |
| `expo-background-fetch` | Periodic reminder + sync ticks | `setInterval` while tab is open + Service Worker for background | `apps/mobile/src/hooks/useBackgroundTasks.web.ts` |
| `expo-contacts` | "Add contact" from phone book | `<input type="file">` import vCard / manual entry only | `apps/mobile/src/hooks/usePhoneContacts.web.ts` |
| `expo-haptics` | Tap feedback | no-op (web has no haptic API) | trivial stub |
| `expo-clipboard` | Copy recovery phrase | `navigator.clipboard` | trivial shim |
| `expo-linking` | Deep links | `window.location` + History API | trivial shim |
| `expo-sharing` | Share via OS sheet | `navigator.share` when present, copy-to-clipboard otherwise | trivial shim |
| `expo-status-bar` | iOS/Android status bar tint | no-op on web | trivial |
| `expo-router` | Filesystem routing | **supported on web** — same `app/*.tsx` files | n/a (just enable web target) |
| `expo-font` | Google Fonts loader | RNW supports `expo-font` on web — Inter / Plus Jakarta load via `@font-face` | n/a |
| `expo-mcp` | MCP client | not exposed in UI today; defer | n/a |
| `react-native-screens` | Native-stack performance | no-op on web (RNW falls back to JS stack) | n/a |
| `react-native-safe-area-context` | Notch insets | RNW has built-in web provider returning zero insets | n/a |

**Platform-gating convention**: Metro picks `foo.web.ts` over `foo.ts`
when bundling for web automatically. Existing mobile code keeps
importing `./foo` — no caller-side changes.

## 4. Test strategy

Five layers, mirroring what we already do for brain + core.

### 4.1 Unit tests (jest + jsdom)

Already exist as 2,677 tests in `apps/mobile/__tests__/`. They run in
jsdom today (no native bindings) so they pass on whatever code Metro
picks. New work:

- Every `*.web.ts` shim gets a unit test that pins behaviour vs the
  `*.native.ts` counterpart. Pattern: a single contract test imports
  both via dynamic `require()` (with `__DEV__` overrides) and asserts
  identical input/output for shared scenarios.

### 4.2 Component / render tests (`react-native-testing-library`)

Mobile already has 149 render test suites. They render `<View>` /
`<Text>` to RN's test renderer, which is platform-agnostic — these
already cover the RNW DOM tree by transitive equivalence. No new work
unless a screen branches on `Platform.OS === 'web'`, in which case
add a second `it.each` row covering the web branch.

### 4.3 Integration tests (existing dual-mode pattern)

Already covered by `packages/brain/__tests__/integration/` — same
chat orchestrator, same vault, same ask coordinator. Nothing to add.

### 4.4 Browser end-to-end (Playwright)

NEW: real Chromium driven against the dev server. Layout:

```
apps/home-node-lite/web/__e2e__/
  setup.ts              — boot core-server + brain-server, wait /readyz
  onboarding.spec.ts    — fresh install → mnemonic → confirm → home screen
  remember.spec.ts      — /remember Emma birthday → reminders rendered
  ask.spec.ts           — /ask "when is Emma's birthday" → answer cites vault
  peerlens.spec.ts      — write a review, see it in outbox
  approvals.spec.ts     — agent ask hitting sensitive persona → approve → resume
  reminders.spec.ts     — reminder fires in foreground, badge increments
  persona_wall.spec.ts  — locked persona requires passphrase, vault tab blocks
  cart_handover.spec.ts — purchase action triggers HIGH approval card
  multi_tab.spec.ts     — two browser tabs see consistent thread state
  recovery.spec.ts      — view recovery phrase requires passphrase re-entry
```

Playwright config: headless by default in CI, headed for local dev,
trace recording on failure. Each spec calls `setup.ts` to wipe state
+ stand up a fresh `/tmp/dina-e2e-<random>/` vault.

### 4.5 Chrome-plugin tests (Claude driving the real browser)

Two distinct uses of the Chrome plugin — both promoted from "manual
nicety" to formal test surface, sitting between Playwright (machine,
deterministic, CI) and human eyeball (slow, qualitative, ad-hoc).

#### 4.5.1 Scripted Chrome-plugin tests (CI-runnable, replayable)

A new directory, `apps/home-node-lite/web/__chrome__/`, holds
**Claude-prompt-driven test scenarios** that any operator can replay
by pasting the prompt at Claude with the Chrome plugin attached.
Each scenario is a Markdown file with three sections:

```
apps/home-node-lite/web/__chrome__/
  README.md
  emma_personalization.scenario.md
  approval_card.scenario.md
  persona_wall.scenario.md
  d2d_thread.scenario.md
  reminder_fire.scenario.md
  …
```

Each scenario file follows a strict template so the run is
repeatable:

```markdown
# Scenario: Emma personalization

## Preconditions
- core-server + brain-server running on the default ports
- `GEMINI_API_KEY` set in brain-server env
- A fresh vault dir (set DINA_VAULT_DIR=/tmp/dina-chrome-$(date +%s) for isolation)
- The browser session is freshly onboarded (mnemonic stored, default personas seeded)

## Steps (verbatim Claude prompt)
1. Open http://127.0.0.1:8200/web in Chrome.
2. Click the chat tab if not already there.
3. Type "/remember My daughter Emma loves dinosaurs" and press Enter.
4. Wait for Dina's reply containing "Stored in" — screenshot.
5. Type "/remember Saving aggressively for house deposit, budget tight" and Enter.
6. Wait for reply — screenshot.
7. Type "/remember Emma's birthday is on November 7th" and Enter.
8. Wait for the reminder block to render — screenshot the full thread.

## Pass criteria
- The third reply contains TWO reminder cards (Nov 6 + Nov 7).
- At least one reminder message mentions Emma's name.
- At least one reminder message references dinosaurs / gift / budget.

## Artefacts
- screenshots/emma_step{1,2,3}_thread.png
- screenshots/emma_reminders_close.png
- console.log capture for any errors
```

Claude reads the scenario, drives Chrome via the plugin, captures
screenshots + DOM state, then writes a `result.md` next to the
scenario with PASS/FAIL + the artefacts. The pass criteria are
unambiguous so Claude can self-grade.

The same scenario list seeds Playwright spec generation (Phase 4–9
tasks generate a `.spec.ts` from each `.scenario.md`) — Chrome plugin
tests and Playwright tests share a single source of truth for what
needs verifying.

#### 4.5.2 Exploratory Chrome-plugin sessions (dev iteration)

Free-form: operator pastes a problem statement into Claude with the
Chrome plugin, Claude explores, reports findings, fixes are applied.
No scenario file required — these turn into scenario files when the
finding is reproducible.

Example loops:
- *"The reminder card on Android shows a 🎂 icon but in Chrome it
  renders as a box. Find out why."* → Claude opens Chrome, inspects
  the element, identifies missing emoji font fallback, proposes a
  CSS fix.
- *"Open the vault tab and the persona switcher feels laggy.
  Profile it."* → Claude opens Chrome dev tools via the plugin,
  records a performance trace, reports the slow render path.
- *"Compare the onboarding step 3 layout between Chrome and the iOS
  sim screenshot I just pasted."* → Claude diffs the two,
  highlights pixel-level differences (font weight, button padding).

#### 4.5.3 Chrome-plugin scenario backlog (seed set, all Phase 10)

The minimum set we ship `__chrome__/` with:

| Scenario file | What it covers | Replayable in | First-run target |
|---|---|---|---|
| `onboarding_fresh_install.scenario.md` | Welcome → mnemonic → home | Phase 3 | Phase 3 |
| `remember_3_step_emma.scenario.md` | The Emma personalization invariant | Phase 4 | Phase 4 |
| `remember_classifier_routing.scenario.md` | /remember finance fact → "Stored in Finance vault" reply | Phase 4 | Phase 4 |
| `ask_with_citations.scenario.md` | /ask returns answer + source citations rendered as chips | Phase 4 | Phase 4 |
| `approval_card_approve.scenario.md` | Agent ask hits sensitive persona → card → approve → resume | Phase 4 | Phase 4 |
| `approval_card_deny.scenario.md` | Same flow, deny path | Phase 4 | Phase 4 |
| `peerlens_write_review.scenario.md` | Write a review, see it in outbox | Phase 5 | Phase 5 |
| `peerlens_browse_subject.scenario.md` | Navigate to a subject page, scroll reviews | Phase 5 | Phase 5 |
| `vault_persona_unlock.scenario.md` | Sensitive persona requires passphrase | Phase 6 | Phase 6 |
| `vault_search.scenario.md` | Search the general vault, click an item | Phase 6 | Phase 6 |
| `people_add_contact.scenario.md` | Add a contact by handle, see them appear | Phase 7 | Phase 7 |
| `chat_d2d_message.scenario.md` | Send a D2D message to a paired Dina, see reply | Phase 7 | Phase 9 |
| `reminder_foreground_fire.scenario.md` | Schedule reminder 30s out, see it fire + badge | Phase 8 | Phase 8 |
| `recovery_phrase_view.scenario.md` | Settings → view phrase → passphrase prompt → reveal → hide | Phase 7 | Phase 7 |
| `cart_handover_purchase.scenario.md` | Agent purchase request → HIGH risk approval card | Phase 7 | Phase 7 |
| `multi_tab_thread.scenario.md` | Two tabs see the same thread state | Phase 9 | Phase 9 |
| `notifications_badge.scenario.md` | Tab badge counts unread approvals + reminders | Phase 8 | Phase 8 |
| `policy_view.scenario.md` | Operator sees the policy table from today's work | Phase 7 | Phase 7 |
| `restore_from_mnemonic.scenario.md` | Reinstall, restore from the previously-shown mnemonic | Phase 3 | Phase 3 |

Each scenario file is **owned by the phase that lands the underlying
screen** — the phase isn't done until both the Playwright spec AND
the Chrome-plugin scenario file are written + pass on a clean boot.

#### 4.5.4 Comparing Chrome plugin vs Playwright vs iOS sim vs Android sim

| Property | Playwright | Chrome plugin (Claude) | iOS sim (idb) | Android sim (adb) |
|---|---|---|---|---|
| Runs in CI | ✅ headless | ❌ (operator-driven) | partial (idb in headless mode) | partial (adb in CI runners) |
| Real engine | ✅ Chromium | ✅ user's actual Chrome | ✅ WebKit-on-RN, real Expo dev-client | ✅ V8-on-RN, real Expo dev-client |
| Visual diff capable | ✅ screenshot APIs | ✅ plugin screenshot + Claude vision | ✅ `idb screenshot` + Claude vision | ✅ `adb exec-out screencap` + Claude vision |
| Catches DOM / a11y | ✅ | ✅ + Claude reasons | n/a (no DOM) | n/a (no DOM) |
| Iterates in seconds | ✅ | ✅ | ❌ (build cycle on first run, fast after) | ❌ (same) |
| Catches mobile divergences | ❌ | ❌ | ✅ source of truth for iOS | ✅ source of truth for Android |
| Catches web divergences | ✅ | ✅ | ❌ | ❌ |
| Multi-step intelligent navigation | scripted | ✅ Claude reasons | ✅ Claude via idb commands | ✅ Claude via adb commands |
| Cost per run | $0 | ~Claude API tokens | $0 | $0 |

**Rule of thumb**: Playwright catches regressions on web, Chrome
plugin catches "looks wrong" + state issues during web development,
iOS sim catches mobile-only divergences via idb, Android sim catches
Android-only divergences via adb. All four target the same scenario
backlog — same `.scenario.md` files, different drivers.

### 4.6 Per-platform UI drivers — adb, idb, Chrome plugin

The same `.scenario.md` file (§4.5.3) must be runnable against all
three real platform surfaces — that's the **one scenario, three
drivers** rule that keeps mobile-vs-web parity honest.

#### 4.6.1 The driver surface

Each driver is a thin operator-runnable harness. Claude with the
appropriate plugin/MCP issues the platform-native commands; the
scenario file is the same.

| Platform | Driver | Tap | Type | Screenshot | Read UI tree |
|---|---|---|---|---|---|
| Android sim | `adb` | `adb shell input tap <x> <y>` | `adb shell input text "<text>"` | `adb exec-out screencap -p > out.png` | `adb shell uiautomator dump /sdcard/window_dump.xml && adb pull /sdcard/window_dump.xml` |
| iOS sim | `idb` (Facebook) | `idb ui tap <x> <y>` | `idb ui text "<text>"` | `idb screenshot out.png` | `idb ui describe-all` (returns the accessibility tree as JSON) |
| Chrome (RNW) | Claude Chrome plugin | plugin `click(selector)` | plugin `type(selector, text)` | plugin `screenshot()` | plugin `getDOM()` / `accessibilityTree()` |

#### 4.6.2 Scenario file augmentation

The scenario template in §4.5.1 gets a `Drivers` block so the same
file documents the command translation per platform. Most scenarios
are platform-agnostic at the step level ("type X", "tap the send
button") and only diverge in the selector/coordinate strategy:

```markdown
# Scenario: Emma personalization

## Drivers
- web   : chrome-plugin    (selectors via testID prefix, e.g. `[data-testid="chat-input"]`)
- ios   : idb              (selectors via accessibility id — same testID prop, RN maps to a11y id)
- android: adb             (selectors via uiautomator resource-id — same testID prop, RN maps to resource-id)

## Preconditions
…

## Steps
1. Open the app (web: `http://127.0.0.1:8200/web`, ios: `idb launch com.dinakernel.mobile`, android: `adb shell am start -n com.dinakernel.mobile/.MainActivity`).
2. Tap the chat input — testID `chat-input`.
3. Type `/remember My daughter Emma loves dinosaurs` and press Enter.
…
```

The `testID` prop in RN screens is what makes this work — RNW emits
it as `data-testid`, iOS maps it to accessibility id, Android maps
it to resource-id. **One annotation, three selector strategies, zero
duplicated scenario code.** This is a direct consequence of the
prime directive (§1.5): a scenario file that needs a separate web
copy because the selectors aren't shareable is broken at the source
— add `testID`s to the mobile screen until it works.

#### 4.6.3 Operator workflow per driver

**Android (adb)**:
```
emulator -avd Pixel_API_34            # start the sim
adb wait-for-device
cd apps/mobile && npx expo run:android
# now hand Claude the scenario:
#   "Run __chrome__/remember_3_step_emma.scenario.md against the
#    Android sim — use adb, capture screenshots into
#    __chrome__/results/android/."
```

**iOS (idb)**:
```
brew install facebook/fb/idb-companion
pip install fb-idb
idb companion --boot <udid>           # boot the sim
cd apps/mobile && npx expo run:ios
# hand Claude the scenario, instructing it to use idb commands +
# screenshot to __chrome__/results/ios/.
```

**Chrome (plugin)**:
```
# brain-server already running with DINA_BRAIN_WEB_UI=1
# hand Claude the scenario, instructing it to use the Chrome
# plugin + screenshot to __chrome__/results/web/.
```

In all three cases Claude reads the same `.scenario.md`, the same
pass criteria gate PASS/FAIL, and the same `result.md` format is
written under `__chrome__/results/<platform>/<scenario>/`.

#### 4.6.4 Tri-platform parity diff

The §10.3 visual parity audit becomes:

```
For each scenario in __chrome__/:
  artefacts/web.png   ← from chrome plugin
  artefacts/ios.png   ← from idb screenshot
  artefacts/android.png ← from adb screencap
→ paste all three into Claude with the prompt
  "diff these three — what differs visually, structurally, or behaviourally?"
→ Claude reports per-element drift
→ acceptable drift goes into PARITY.md with a note,
  unaccepted drift is a P1 bug.
```

This is what makes "mobile-first iteration" actually work in
practice — when the iOS screen changes, the iOS-run scenario and
the web-run scenario both surface the divergence before merge.

#### 4.6.5 Driver setup tasks (added to Phase 0)

- [ ] Document the adb / idb / Chrome-plugin setup in
      `apps/mobile/__chrome__/DRIVERS.md`.
- [ ] Verify all three drivers can hit a placeholder "hello world"
      RN screen with the same `testID` and report success.
- [ ] Add `npm run chrome:web` / `npm run chrome:ios` /
      `npm run chrome:android` scripts that prep the environment +
      print the Claude prompt to paste.
- [ ] Ship at minimum **one** scenario (the welcome screen) wired
      for all three drivers at the end of Phase 0 — proves the
      tri-platform loop works before Phase 3 onboarding scales it.

## 5. Phase plan

Each phase has a single ship gate: **every previous test layer green**.

### Phase 0 — Architecture spike (1 day)

Prove RNW renders one mobile screen in a browser before committing
to the rest.

- [ ] Add `react-native-web` + `react-dom` + `babel-plugin-react-native-web`
      to `apps/mobile/package.json`.
- [ ] Add `web` platform to `apps/mobile/app.json` with bundler `metro`.
- [ ] Add `apps/mobile/web/index.html` shell (RNW root).
- [ ] Run `npx expo start --web` and verify `app/help.tsx` (the
      simplest static screen) renders without errors. Pin a screenshot
      to the PR for the record.

**Done when**: a single hand-picked screen renders in Chrome with the
same fonts, theme, and layout as the iOS sim.

### Phase 1 — Build pipeline (2 days)

Production web bundle, served by brain-server.

- [ ] Configure Expo web build output (`npx expo export --platform web`)
      to write into `apps/home-node-lite/web/dist/`.
- [ ] Brain-server: serve `dist/` at `GET /web/*` when `DINA_BRAIN_WEB_UI=1`
      (parallel to the existing `/dev` route — but for the whole SPA, not
      a single inline HTML page).
- [ ] CI step: build the web bundle on every PR, fail the build if Expo
      web export errors.
- [ ] Add `apps/home-node-lite/web/__e2e__/setup.ts` + a placeholder
      `smoke.spec.ts` that checks the bundle loads and `/web/` returns
      HTML.

**Done when**: `DINA_BRAIN_WEB_UI=1 npm start` in brain-server serves a
loadable SPA at `http://127.0.0.1:8200/web/`, and a single Playwright
test verifies the React root mounts.

### Phase 2 — Storage shim (2 days)

**Mobile keeps using op-sqlite + react-native-keychain unchanged.** This
phase adds web-side peers (`*.web.ts`) that Metro picks ONLY when the
web target is built. iOS and Android continue to resolve the existing
`.ts` / `.native.ts` files exactly as today — zero behavioural change
on mobile.

**The web bundle never opens a SQLCipher file** — vault writes go to
Core via HTTP. The web-side storage is ONLY for the device-local
secrets the mobile app keeps in keychain (Ed25519 device key,
passphrase hint, install marker).

- [ ] `apps/mobile/src/services/keychain.web.ts` — IndexedDB-backed
      store with the same `getGenericPassword`/`setGenericPassword` API
      `react-native-keychain` exposes. Values encrypted with WebCrypto
      AES-GCM using a key derived from a session passphrase.
- [ ] `apps/mobile/src/services/argon2.web.ts` — wrap `argon2-browser`
      WASM with the same API shape `react-native-argon2` provides.
- [ ] Unit tests: same Jest spec runs against both shims, asserts
      identical encrypted-round-trip behaviour for a fixture passphrase +
      payload set.
- [ ] Document the security model in `apps/home-node-lite/web/SECURITY.md`
      — web doesn't have Secure Enclave; the operator's browser session
      is the trust boundary. Discourage shared-device installs.

**Done when**: every `keychain.ts` call site in mobile works in the
browser with no caller changes. The dual-mode unit test passes.

### Phase 3 — Onboarding flow (3 days)

The 13-component onboarding flow (`src/components/onboarding/*.tsx`).
All UI work; the backend (Core's seed gen + DID creation) is already
HTTP-callable.

- [ ] Verify each onboarding screen renders in RNW:
  - [ ] `welcome.tsx`
  - [ ] `mode_choice.tsx` (requester / provider / both)
  - [ ] `recovery_entry.tsx` (new vs restore)
  - [ ] `passphrase_set.tsx`
  - [ ] `mnemonic_reveal.tsx`
  - [ ] `mnemonic_verify.tsx`
  - [ ] `recovery_handle.tsx`
  - [ ] `handle_pick.tsx`
  - [ ] `owner_name.tsx`
  - [ ] `infra_setup.tsx`
  - [ ] `provisioning.tsx`
  - [ ] `shell.tsx` + `onboarding_flow.tsx`
- [ ] Playwright e2e: complete onboarding from welcome → home screen
      against a fresh Core + Brain. Asserts: DID created, mnemonic shown
      + verified, default personas seeded, lands on the chat home.
- [ ] Address copy-to-clipboard for the mnemonic (use `navigator.clipboard`).
- [ ] Auto-hide mnemonic on tab background — already implemented via
      `AppState` in RN; web equivalent is `document.visibilitychange`.
      The existing onboarding shell hides the words on
      `AppState.change`; verify this fires on web via RNW's AppState
      polyfill.

**Done when**: `onboarding.spec.ts` (Playwright) goes from welcome to
home in a fresh browser session. The chat tab is the screen the user
lands on.

### Phase 4 — Chat tab (3 days)

Main user-facing surface. Existing `apps/mobile/app/index.tsx` is the
chat home; everything composes around the shared `handleChat`
orchestrator we already exposed in brain-server.

- [ ] Verify `index.tsx` renders the thread, input, and approval cards
      in RNW.
- [ ] Hook up `useChatThread` + `useChatApprovals` + `useChatAsk`
      against the brain-server HTTP API (the in-process bindings on
      mobile become HTTP fetches on web — `setRememberCoreClient`'s
      `HttpCoreTransport` is already wired by `wireChatRememberRuntime`
      in `@dina/home-node/chat-runtime`).
- [ ] Slash commands all work end-to-end:
  - [ ] `/remember` — Playwright: 3-step Emma flow, asserts
        personalized reminder text appears in the thread.
  - [ ] `/ask` — Playwright: ask about Emma, assert answer + source
        citations.
  - [ ] `/search` — keyword search returns hits.
  - [ ] `/service` — provider lookup card renders + lifecycle updates.
  - [ ] `/help` — static help text renders.
- [ ] Approval cards: render inline in thread, Approve/Deny buttons
      drive Core via HTTP, status updates stream back via SSE or polling.

**Done when**: `remember.spec.ts`, `ask.spec.ts`, `approvals.spec.ts`
all green against a real Core + Brain.

### Phase 5 — PeerLens tab (4 days)

`apps/mobile/app/peerlens/*.tsx` — write reviews, browse, namespace
config, outbox.

- [ ] Screens render: `index.tsx`, `search.tsx`, `write.tsx`,
      `namespace.tsx`, `outbox.tsx`, `[subjectId].tsx`,
      `reviewer/[did].tsx`.
- [ ] Preferences nested route: 6 screens under
      `app/peerlens-preferences/` (region, languages, budget, dietary,
      devices, accessibility).
- [ ] Playwright e2e: write a review, publish via PDS, see it in the
      outbox, navigate to the subject page.
- [ ] PDS publishing: the web bundle posts to Brain's `/api/v1/peerlens/publish`
      endpoint (add if missing — brain already has the PDS client).

**Done when**: `peerlens.spec.ts` writes + browses + reviews end-to-end.

### Phase 6 — Vault tab (3 days)

Persona switcher + item browser + search. Existing
`app/vault/index.tsx` + `app/vault/[name].tsx`.

- [ ] Persona list renders, locked personas show a closed lock icon.
- [ ] Unlock flow: passphrase prompt → Core `/v1/persona/unlock` HTTP
      call → vault tab refreshes to show items.
- [ ] Item detail screen renders summary + body + tags + source.
- [ ] Search bar drives `/v1/vault/query` against the persona.
- [ ] Playwright e2e: lock + unlock + search the `general` persona,
      assert an item the e2e seeded appears in results.

**Done when**: `persona_wall.spec.ts` passes — sensitive personas
require passphrase even after the home-node is unlocked.

### Phase 7 — Other tabs (3 days)

Secondary screens.

- [ ] `app/people.tsx` — contacts list + add-contact flow.
      `app/add-contact.tsx` already does xrpc resolve via fetch (we
      fixed it earlier this session); works as-is on web.
- [ ] `app/chat/[did].tsx` — D2D chat with a specific contact.
- [ ] `app/approvals.tsx` — pending approval inbox.
- [ ] `app/notifications.tsx` — notification inbox + badge.
- [ ] `app/reminders.tsx` — scheduled reminders list.
- [ ] `app/admin.tsx` — admin tab (audit log, health, paired devices).
- [ ] `app/paired-devices.tsx` — device list + pair-new-device flow.
- [ ] `app/policy.tsx` — operator policy view (from today's work).
- [ ] `app/settings.tsx` + `app/service-settings.tsx` — settings panes.
- [ ] `app/help.tsx` — static help.
- [ ] `app/recovery-phrase.tsx` + `app/confirm-recovery-phrase.tsx` —
      view + verify recovery phrase. Passphrase re-entry required.

**Done when**: every tab in the iOS sim's tab bar also works in
Chrome with the same content. No screen branches on `Platform.OS`
beyond what the shims already cover.

### Phase 8 — Notifications + reminders (2 days)

- [ ] `apps/mobile/src/notifications/local.web.ts` — wrap the
      browser `Notification` API + service worker registration. Use
      the same `scheduleLocalNotification` / `cancelLocalNotification`
      surface mobile uses.
- [ ] Background reminder fire watcher: on web, run a `setInterval`
      every minute while a tab is open. For background firing, register
      a service worker that wakes on periodic sync (where supported).
- [ ] Playwright e2e: schedule a reminder 5 seconds out, advance fake
      timers (or actually wait), assert the notification fires +
      badge increments.

**Done when**: `reminders.spec.ts` passes.

### Phase 9 — D2D + MsgBox over WebSocket (2 days)

Mobile's MsgBox client (`packages/core/src/relay/msgbox_ws.ts`)
already uses WebSocket — should work in browsers natively.

- [ ] Confirm the existing WS client runs in a browser context (no
      Node-specific APIs).
- [ ] Web bundle subscribes to MsgBox for inbound D2D, identical to
      mobile flow.
- [ ] Playwright e2e (cross-node): two browser tabs as two Dinas,
      send a D2D message, assert delivery.

**Done when**: `multi_tab.spec.ts` (and the cross-node variant) pass.

### Phase 10 — Full test sweep + CI gate (2 days)

#### 10.1 Automated CI (Playwright + unit)
- [ ] All Playwright specs in CI on every PR.
- [ ] Unit + render tests green across the matrix (iOS + Android +
      Web).
- [ ] Brain + Core test suites unchanged (no regression from web shims).
- [ ] Trace recording on failure; traces uploaded as PR artefacts.
- [ ] Matrix: Chrome stable + Firefox stable + WebKit (Safari) on
      Playwright; Phase 8 service-worker behaviour is browser-
      conditional, the matrix catches that.

#### 10.2 Chrome-plugin scenario suite (operator-runnable)
- [ ] All 19 scenarios in §4.5.3 are written, validated against the
      built app, and replayable by anyone who pastes the prompt at
      Claude with the Chrome plugin attached.
- [ ] `apps/home-node-lite/web/__chrome__/README.md` documents the
      setup: which env vars to set, where to find the scenarios, how
      to interpret the `result.md` Claude writes, how to file a bug
      with the scenario id + result attached.
- [ ] One full pass of every scenario before each ship — the artefact
      bundle (screenshots + result.md per scenario) gets attached to
      the release notes.
- [ ] A regression in any scenario blocks ship until either the
      scenario gets updated (intentional UI change) or the code gets
      fixed (regression).

#### 10.3 Mobile-vs-web visual parity audit
- [ ] For each of the 19 scenarios, capture an iOS sim screenshot of
      the equivalent flow.
- [ ] Operator pastes iOS sim screenshot + Chrome screenshot into
      Claude with the prompt "diff these two — what differs?". Claude
      reports per-element diffs (font weight, padding, color drift,
      icon substitution).
- [ ] Document acceptable divergences (e.g. iOS native blur vs CSS
      backdrop-filter) in `apps/home-node-lite/web/PARITY.md`.
- [ ] Any unaccepted divergence is a P1 bug.

**Done when**: pushing a UI change to mobile automatically triggers
the web build + Playwright sweep + the Chrome-plugin scenario set
gets re-run by the operator before merge, and any divergence between
iOS/Android/Web fails the build or surfaces as a known-and-accepted
entry in `PARITY.md`.

### Phase 11 — Distribution (1 day)

- [ ] `install-lite.sh` flag `--web-ui` that flips
      `DINA_BRAIN_WEB_UI=1`.
- [ ] Docker compose serves the SPA on port 8200 (same as Brain).
- [ ] `README.md` Quickstart updated with browser URL + the supported
      auth methods.

**Done when**: a clean `install-lite.sh --web-ui` boot prints a URL
the operator opens in any browser to onboard.

## 6. Total scope

| Phase | Days | Cumulative |
|---|---|---|
| 0 Spike | 1 | 1 |
| 1 Build pipeline | 2 | 3 |
| 2 Storage shim | 2 | 5 |
| 3 Onboarding | 3 | 8 |
| 4 Chat | 3 | 11 |
| 5 PeerLens | 4 | 15 |
| 6 Vault | 3 | 18 |
| 7 Other tabs | 3 | 21 |
| 8 Notifications | 2 | 23 |
| 9 D2D / MsgBox | 2 | 25 |
| 10 Test sweep (Playwright + Chrome plugin + parity audit) | 2 | 27 |
| 11 Distribution | 1 | 28 |

**~5.5–6 working weeks** of focused work assuming one engineer, all
tests passing at each phase boundary, no scope-creep.

Each Phase 3–9 ships **both** a Playwright spec **and** a Chrome
scenario file for every new screen — the test artefacts are part of
the phase, not retrofitted in Phase 10. Phase 10 is the integration
gate that runs the whole suite.

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| RNW renders a critical screen incorrectly | Medium | Phase 0 spike catches this on the simplest screen first; if the spike fails we revisit the architecture before sinking effort. |
| `react-native-keychain` API surface doesn't fully shim | Low | Inventoried; only 4 call sites use it. Wrap thinly. |
| Service workers + notifications behave differently across browsers | High | Test matrix includes Chrome, Firefox, Safari. Fall back to in-page notifications when SW unavailable. |
| Onboarding fonts don't load on web | Low | `expo-font` supports web; verified in spike. |
| Brain-server doesn't expose every endpoint the mobile in-process model needs | Medium | Audit during Phase 4 + Phase 6; add missing routes to brain-server before the dependent phase. |
| Two browser tabs share IndexedDB → bad multi-window UX | Medium | Phase 9 `multi_tab.spec.ts` catches this; lean on `BroadcastChannel` to keep tabs in sync. |
| Playwright + claude-chrome flake on CI | Medium | Retry config (max 2) + trace recording on failure; manual exploration via Chrome plugin is the escape hatch. |

## 8. Out of scope for this plan

- **iOS / Android native module replacements** — keep `*.native.ts`
  paths unchanged.
- **Building a separate React app** — explicit non-goal (see §1).
- **PWA install prompt + offline mode** — Phase 12+ if there's demand.
  Not blocking the first ship.
- **Native browser extensions** — operators can pair a desktop browser
  as a device via the existing pairing flow once Phase 11 lands; no
  extension needed.

## 9. Out-of-band: today's brain-server `/dev` route

The minimal HTML chat UI we built today (`apps/home-node-lite/brain-server/src/routes/chat.ts`)
stays as a **dev utility**. Once Phase 11 ships, `/dev` becomes
redundant and gets retired in the same PR that lands the full SPA at
`/web`. Until then it's the fast feedback loop for backend-only
changes that don't need the full UI.
