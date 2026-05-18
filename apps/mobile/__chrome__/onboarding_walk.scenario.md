# Scenario: Onboarding render walk (tri-driver)

Phase 3 deliverable per `docs/HOME_NODE_LITE_WEB_UI_TASKS.md`. Pins the
render contract for the first three onboarding surfaces on every
platform — the slice that does NOT require a running Core (Core is
needed only from the mnemonic-verify step onwards).

Builds on `welcome_screen_renders.scenario.md` — that proves the SPA
mounts; this proves the user can advance through the first three
screens without a wired Core.

## Preconditions

- `welcome_screen_renders.scenario.md` passes on this platform.
- For `web`: brain-server is up with `DINA_BRAIN_WEB_UI=1`. The
  Playwright spec at `apps/home-node-lite/web/__e2e__/onboarding.spec.ts`
  encodes the exact assertions; this scenario is the
  manual-driver equivalent.

## Steps (driver-agnostic)

1. **Open the app** on the target platform per the welcome-renders
   scenario.
2. **Screenshot** the infra setup screen at `01_infra_setup.png`.
3. **Tap Continue** on the infra setup screen.
4. **Screenshot** the welcome screen at `02_welcome.png`.
5. **Tap "Get started"** on the welcome screen.
6. **Screenshot** the mode choice screen at `03_mode_choice.png`.

## Pass criteria

ALL of:

- Step 2 screenshot contains the text `"Choose your infrastructure"`
  AND `"PDS URL"` AND `"PeerLens and Services URL"` AND a `Continue`
  button.
- Step 4 screenshot contains the `DINA` wordmark, the
  `"Your sovereign personal AI"` tagline, AND a `Get started` button.
- Step 6 screenshot contains the text `"Let's get your Dina set up"`,
  AND both `"Create a new Dina"` and `"Restore from recovery phrase"`
  options.
- No JavaScript exceptions in the console between steps (web only).
- No `Cannot read properties of undefined (reading
  'setGenericPasswordForOptions')` — that's the Phase 2 keychain shim
  regression class. If it appears, rebuild the SPA bundle via
  `npm run -w @dina/home-node-lite-web-e2e build:bundle`.

ANY of the following FAILS the scenario:

- A red error banner under any input field after pressing Continue
  ("Couldn't save: ..." indicates a keychain regression).
- Continue tap leaves the user on the same screen with no error
  (silent provisioning failure).

## Artefacts

Written to `results/onboarding_walk/<platform>/`:

- `01_infra_setup.png`
- `02_welcome.png`
- `03_mode_choice.png`
- `result.md`

## Out of scope for Phase 3

Steps 4-11 of the onboarding state machine (passphrase set →
mnemonic reveal → verify → recovery handle → handle picker → owner
name → provisioning) drive into Core to mint a `did:plc`. The
Phase 3 entry criterion is just "the first three screens render";
the full happy-path round-trip is a Phase 4+ orchestration concern
once `core-server` and `brain-server` ship as a paired CI stack.
