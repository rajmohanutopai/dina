# `__chrome__` — tri-driver scenario suite

Operator-runnable test scenarios that exercise the **same mobile
source** across three real platform surfaces:

| Driver | Tool | What it tests | Required setup |
|---|---|---|---|
| `web`     | Claude Chrome plugin | RNW rendering in a real browser | `npm run web:export` + static-serve dist/ |
| `ios`     | `idb`                 | iOS Expo dev-client            | iOS simulator booted, `idb companion` running |
| `android` | `adb`                 | Android Expo dev-client        | Android emulator booted, `adb` on PATH |

Per `docs/HOME_NODE_LITE_WEB_UI_TASKS.md` §4.6 — "one scenario, three
drivers". The same `.scenario.md` file maps to a Claude prompt that
drives whichever surface you ask for.

## Directory layout

```
__chrome__/
  README.md             — you are here
  DRIVERS.md            — how to install adb / idb / Chrome plugin + run drivers
  *.scenario.md         — one file per scripted scenario (§4.5.3 backlog)
  scripts/
    web-export.sh       — build the SPA + start the static server
    drivers-doctor.sh   — diagnose which drivers are ready right now
  results/              — Claude writes <scenario>/<platform>/result.md
                          + screenshots here on each run
```

## Running a scenario

The recommended way is to paste this verbatim at Claude with the
appropriate browser-driver MCP attached:

```
Run __chrome__/<scenario_name>.scenario.md against <platform>.
Use the driver commands listed in the scenario's Drivers block.
Write the result to __chrome__/results/<scenario_name>/<platform>/.
```

Claude reads the scenario, executes the steps, captures
screenshots, evaluates the pass criteria, and writes `result.md`
plus image artefacts under the results directory. The artefact
bundle is what gets attached to the release notes.

## Why this complements Playwright

| Playwright | Chrome plugin |
|---|---|
| Runs unattended in CI | Operator pastes the scenario at Claude |
| Fast feedback on regressions | Catches "looks wrong" + state issues during development |
| Web only (Chromium) | Web + iOS + Android via three drivers |
| Strict — selectors, asserts | Tolerant — Claude reasons about state |

Same scenario backlog, different cadence: Playwright runs on every
PR; Chrome scenarios run on every release + during exploratory
development.

## Adding a new scenario

1. Pick a phase from `docs/HOME_NODE_LITE_WEB_UI_TASKS.md` §4.5.3.
2. Copy `_template.scenario.md` (when it lands) or one of the
   existing scenarios as a starting point.
3. Fill in `Preconditions`, `Drivers` (selector strategy per
   platform), `Steps`, `Pass criteria`, `Artefacts`.
4. Run it once against each driver, paste the resulting
   `result.md` paths into the PR.
5. Reviewer verifies the screenshots match expectation.
