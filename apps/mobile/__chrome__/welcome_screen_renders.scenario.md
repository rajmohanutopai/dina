# Scenario: Welcome screen renders (tri-driver smoke)

Phase 0 deliverable per `docs/HOME_NODE_LITE_WEB_UI_TASKS.md` §4.6.5.
The MINIMAL multi-driver scenario — every other scenario builds on
the assumption that this one works. If this regresses, the tri-driver
test loop is broken.

## Preconditions

- Working tree built; `npm test` is green at workspace root.
- For `web`: SPA bundle exists at `apps/home-node-lite/web/dist/`,
  reachable at `http://127.0.0.1:18290/` (run
  `apps/mobile/__chrome__/scripts/web-export.sh`).
- For `ios`: an iOS simulator is booted with the Dina dev-client
  installed and the app launched (`cd apps/mobile && npx expo run:ios`).
- For `android`: an Android emulator is booted with the dev-client
  installed (`cd apps/mobile && npx expo run:android`).
- Fresh app state: the keychain / IndexedDB MUST have no prior DID
  stored, so the app boots into onboarding.

## Drivers

| Surface | Selector strategy | Open command |
|---|---|---|
| `web`     | `data-testid="<id>"` via `read_page` + `computer`  | `navigate http://127.0.0.1:18290/` |
| `ios`     | iOS accessibility-id, same value as RN `testID`    | `idb launch com.dinakernel.mobile` |
| `android` | Android resource-id, same value as RN `testID`     | `adb shell am start -n com.dinakernel.mobile/.MainActivity` |

## Steps (driver-agnostic)

1. **Open the app** on the target platform per the table above.
2. **Wait** for the onboarding shell to mount (≤ 3 seconds).
3. **Screenshot** the initial onboarding screen.
4. **Read the visible text** on the page (via `read_page` for web,
   `idb ui describe-all` for iOS, `uiautomator dump` for android).
5. **Capture console / log errors** if any (web only — `read_console_messages`).

No interactions — this is a "did it render?" smoke check.

## Pass criteria

ALL of:

- The screenshot shows the Dina brand wordmark (D-I-N-A spaced
  letterforms) somewhere on the page.
- The visible text on the page contains AT LEAST ONE of these
  onboarding-screen phrases (depends on which step the fresh-install
  router lands on — welcome, mode-choice, or infra-setup are all
  acceptable as "we rendered an onboarding screen"):
  - `"Welcome to Dina"`
  - `"Choose your infrastructure"`
  - `"What kind of node will this be?"`
  - `"Let's set up Dina"`
- No JavaScript exceptions in the console (web only).
- The page background colour is the Dina cream tone — `bgPrimary`
  in `apps/mobile/src/theme.ts` (`#FAF8F5`, `rgb(250, 248, 245)`).
  Note that `app.json` `web.backgroundColor` uses the slightly
  darker `#F9F2EC` cream — that's the splash colour shown before
  the React bundle mounts, NOT the in-app theme. The pass-criteria
  colour is the in-app one.

ANY of the following FAILS the scenario:

- White screen (RNW didn't mount).
- Error response page (static server 404 etc.).
- Wrong font (the app should be using the bundled Inter / Plus
  Jakarta — system sans-serif fallback means font loading is
  broken).
- Console errors mentioning `Cannot read properties of undefined`
  or `Module not found` (means a native module leaked into the
  web bundle without a shim).

## Artefacts

Written to `results/welcome_screen_renders/<platform>/`:

- `01_open.png`    — initial render
- `result.md`      — PASS / FAIL + visible text dump + console dump
- `accessibility_tree.txt` — `read_page filter=all` output (web only)

## Notes

- This scenario MUST be runnable from a fresh install (no DID stored)
  — every platform's storage gets wiped before the run.
- The exact screen the router lands on (welcome vs mode-choice vs
  infra-setup) depends on `useOnboarding` state. The pass criteria
  accepts any of them because all three are onboarding-shell screens
  rendering the Dina design system correctly. Future scenarios pin
  individual onboarding steps explicitly.
- First-run verification was captured at `apps/mobile/__chrome__/results/welcome_screen_renders/web/` on Phase 0 ship.
