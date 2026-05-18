# Result — welcome_screen_renders / web

**Run timestamp**: 2026-05-18 (Phase 0); re-validated Phase 1 via Playwright
**Driver**: Chrome plugin (Claude in Chrome MCP) for Phase 0;
  Playwright + Chromium for Phase 1 (apps/home-node-lite/web/__e2e__/smoke.spec.ts)
**Bundle**: produced by `npx expo export --platform web` with
  `experiments.baseUrl: "/web"` set in `apps/mobile/app.json` (Phase 1).
  Phase 0 ran the bundle without baseUrl from `/tmp/dina-web-spike/`;
  Phase 1 serves the same shape from the brain-server's `/web/*` route.
**Scenario file**: `apps/mobile/__chrome__/welcome_screen_renders.scenario.md`

## Status: ✅ PASS

All four pass criteria met.

## Captured artefacts

- `01_open.png` — initial render of the onboarding shell at infra-setup
  step (this is the screenshot Phase 0 unblocks all subsequent phases on).

## Pass criteria check

| Criterion | Expected | Actual | Result |
|---|---|---|---|
| Dina brand wordmark visible | `D-I-N-A` letterforms | `read_page` returned `generic "DINA" [ref_1]` | ✅ |
| Onboarding-shell text | one of welcome / mode-choice / infra-setup | `"Choose your infrastructure"` rendered | ✅ |
| No console errors | zero `Cannot read properties of undefined` | `read_console_messages onlyErrors=true` → 0 messages | ✅ |
| Page background = Dina cream | `rgb(250, 248, 245)` (`#FAF8F5`) | matched on the styled root content div | ✅ |

## Visible text dump

```
DINA
Choose your infrastructure
Dina uses AT Protocol and needs a PDS for identity and an AppView for PeerLens and Services. You can use your own, or use the defaults here.
PDS URL
[textbox, value="https://test-pds.dinakernel.com"]
Where your did:plc account lives. The PDS mints the DID and stores published records.
PeerLens and Services URL
[textbox, value="https://test-appview.dinakernel.com"]
Indexes PeerLens attestations and service profiles. PeerLens reviews and service discovery both hit this URL.
[button] Continue
You can change these later in Settings → Service Sharing → Infrastructure.
```

## Fonts loaded (from `document.fonts`)

```
ionicons
material-community
Figtree_400Regular
Figtree_500Medium
Figtree_600SemiBold
PlusJakartaSans_500Medium
PlusJakartaSans_600SemiBold
PlusJakartaSans_700Bold
PlusJakartaSans_800ExtraBold
CormorantGaramond_600SemiBold_Italic
JetBrainsMono_400Regular
JetBrainsMono_500Medium
```

All `@expo-google-fonts/*` packages the mobile app declares loaded
successfully on web. The visible italic serif "Choose your
infrastructure" heading matches CormorantGaramond_600SemiBold_Italic.

## Console errors

None.

## Notes for future scenarios

- The 404 on `http://127.0.0.1:18290/help` is the static-server's
  default behaviour (no SPA fallback). Phase 1 — when brain-server
  serves the SPA — must include `app.setNotFoundHandler` that
  returns `index.html` for any path not matching a static asset.
- Computed-style `font-family` returns the system-font fallback
  string even when the actual rendering uses the loaded Google
  font. This is a RNW + Expo Font implementation detail.
  Visual-diff (screenshot vs iOS sim) is the authoritative font
  check, not `getComputedStyle`.

## ios / android runs

Pending — both drivers need their environments set up first. Run
`apps/mobile/__chrome__/scripts/drivers-doctor.sh` to see what's
ready, then re-run this scenario from each.
