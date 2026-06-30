# Maestro E2E flows (mobile)

The reliable, automated replacement for hand-driving the app with `idb`.
Maestro launches the **real** app on a sim/emulator, taps **real** elements
by `testID`, and **waits for the app to be idle** between steps — so flows
don't flake the way coordinate-poking + screenshot-reading do.

These are the device-tier of the test pyramid:

| Tier | Tool | What it proves |
|---|---|---|
| Unit / component | jest + React Native Testing Library | card internals, button presses |
| Integration | in-process / debug-channel harness (`.d2d-live-scratch/live_d2d_enrichment.ts`) | real logic + backend + LLM + two Dinas, no UI |
| **E2E (here)** | **Maestro** | the whole MRS scenario through the **real UI + real logic** |

## One-time install (outside the repo — run it yourself)

Maestro installs to `~/.maestro` and needs a JDK (already on this machine via
`openjdk`):

```bash
! curl -Ls "https://get.maestro.mobile.dev" | bash
# then add to PATH for this shell:
! export PATH="$PATH:$HOME/.maestro/bin"
```

(`xcrun simctl` for iOS / `adb` for Android must be reachable — they already are.)

## The fast loop — dev-client + `--no-dev` (NOT Release builds)

**Do not iterate against a native Release build.** A Release rebuild is
~10 min per change, which makes "find a bug → fix → retest" unbearable.

The only reason we ever reached for Release was the Expo dev overlay
(Fast Refresh banner / source-code-explorer panel) that interrupts
multi-step Maestro runs. That overlay is **`__DEV__`-gated** — it has
nothing to do with native Release config. Serving a `__DEV__=false`
bundle through the **existing dev-client** kills the overlay while
keeping Metro's instant reload:

```bash
# 1. Install the DEV-CLIENT build once (Debug config — loads JS from Metro,
#    no embedded main.jsbundle). An upgrade-install preserves onboarding:
xcrun simctl install <udid> <DerivedData>/Build/Products/Debug-iphonesimulator/Dina.app

# 2. Serve a production-mode bundle (kills the overlay, no native rebuild):
npm run start:e2e          # = expo start --no-dev --port 8081

# 3. Point the dev-client at Metro (once):
xcrun simctl openurl <udid> "dina://expo-development-client/?url=http://localhost:8081"
```

Now **JS / testID edits go live on the next `launchApp`** (Maestro
re-fetches the bundle from Metro; only changed modules re-transform).
Verified: `tabs_smoke` + `remember_recall` (multi-step, real-LLM) both
run clean under this setup — no overlay, no rebuild. `--no-dev` disables
Fast Refresh, so a changed module needs a fresh launch rather than a hot
patch; every flow starts with `launchApp`, so that's automatic.

(Add `--minify` only if you also want to catch terser/prod-only issues —
it slows each reload and isn't needed to suppress the overlay.)

## Run

Boot a sim with the dev-client installed + onboarded and `start:e2e`
running, then:

```bash
# from apps/mobile/ — every flow in this dir
npm run test:e2e

# single flow (from repo root)
maestro test apps/mobile/maestro/remember_recall.yaml

# tab-nav smoke (cheap, deterministic — run first after any layout change)
maestro test apps/mobile/maestro/tabs_smoke.yaml

# interactive selector inspector (the Maestro equivalent of poking the UI)
maestro studio
```

Maestro auto-detects the booted iOS sim / running Android emulator. To pin a
device: `maestro --device <udid> test …`.

## Flows

- `remember_recall.yaml` — **MRS-01 + MRS-02**: Remember "Emma loves
  dinosaurs" → assert it stored in a vault → Ask "what does Emma like?" →
  assert the answer contains "dinosaur" (recalled from memory, real LLM).
- `persona_routing.yaml` — **MRS-01**: a health fact lands in the Health
  vault, a finance fact in the Finance vault — and no approval prompt fires
  because the owner is asking in-app.
- `remember_reminder.yaml` — **MRS-03** (flagship): a preference + a dated
  event auto-creates a REMINDER card that weaves in the preference (and a plain
  fact creates NO reminder — the negative case). The enrichment wording is
  real-LLM, so keep this one in the on-demand lane.

## Scenarios that need a second Dina or an agent

Talk (MRS-04/05), Services (MRS-10/11), and the agent-safety approvals
(MRS-06/07/08) are **hybrid**: Maestro drives the *receiver* app's UI while
the *sender*/*agent* side is driven by the headless harness
(`.d2d-live-scratch/live_d2d_enrichment.ts` for a second Dina; the
`dina-agent` CLI for agent flows). The harness sends the D2D message / agent
request; the Maestro flow asserts the card shows up and its buttons work.

## Selectors

The app is already instrumented (61 files with `testID`). Key ones:
`index-mode-chip-{ask,remember,task}`, `chat-input`, `send-button`,
`quarantine-accept-<id>` / `quarantine-block-<id>`, the People / Network /
Activity tabs. Prefer `id:` (testID) over `text:` for stability.
