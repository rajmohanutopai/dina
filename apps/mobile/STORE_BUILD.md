# Store-build pipeline (Dina mobile)

This is the committed pipeline for producing the artifacts that ship to the App Store and Play Store. It uses [EAS Build](https://docs.expo.dev/build/introduction/) — Expo's managed cloud-build service — driven by `eas.json` at the root of `apps/mobile/`.

> The local `Debug-iphonesimulator` builds we run during development are not what ships. Anything that needs to reach a tester or a store reviewer comes out of one of the EAS profiles below.

## Profiles in `eas.json`

| Profile | Distribution | iOS sim? | Android | When to use |
|---|---|---|---|---|
| `development` | internal | yes | APK (debug) | Day-to-day debugging on a real device with Expo Dev Client; talks to the dev server. |
| `preview` | internal | no | APK (release) | TestFlight internal track / Play Console internal track — what testers actually install. |
| `production` | store | no | AAB | App Store / Play Store submission. `autoIncrement` bumps the build number on every run so we never re-upload the same number. |

All three profiles set `EXPO_PUBLIC_DINA_ENV` so the in-app boot can branch on it (e.g. point at production MsgBox/PDS/AppView for `production`, the `test-*.dinakernel.com` triplet for `preview`).

## One-time setup

The first time anyone runs an EAS build for this repo:

```bash
# Globally (or via npx) — the eas-cli is intentionally NOT a workspace dep
# so root `npm install` doesn't pull a 200MB native CLI for every contributor.
npm install -g eas-cli@latest
cd apps/mobile
eas login           # uses the dinakernel Expo org account
eas init            # links this directory to the Expo project (one-time per checkout)
```

Configure once before the first **production** submit:

1. Replace the placeholder values in `eas.json` → `submit.production.ios`:
   - `appleId` — the App Store Connect login email.
   - `ascAppId` — the App Store Connect app's numeric ID (visible in the App Store Connect URL).
   - `appleTeamId` — the 10-char Apple Developer team ID.
2. Drop the Play Console service-account JSON at `secrets/play-store-service-account.json` (gitignored). The path in `eas.json` is repo-root-relative.

These values stay in `eas.json` — they're operational, not secret. The actual credentials (Apple sign-in cookie, ASC API key, Play service account) live in EAS itself via `eas credentials`, not in the repo.

## Build commands

From `apps/mobile/`:

```bash
# Day-to-day device builds — install once, then JS-only updates
eas build --profile development --platform ios
eas build --profile development --platform android

# Internal-distribution build for testers
eas build --profile preview --platform ios
eas build --profile preview --platform android

# Store-ready artifact
eas build --profile production --platform ios
eas build --profile production --platform android
```

Each invocation queues a build on EAS's servers, prints a URL where you can watch logs, and ends with a download link for the .ipa / .apk / .aab. Add `--non-interactive --wait` in CI to block until the build finishes and exit non-zero on failure.

## Submit commands

After a successful production build:

```bash
eas submit --profile production --platform ios       # → App Store Connect
eas submit --profile production --platform android   # → Play Console (internal track, draft)
```

The Android profile defaults to the **internal** track + **draft** release. Promoting to a public track is a manual decision in Play Console — we don't automate that.

## Versioning model

`expo.version` in `app.json` is the user-visible **marketing version** (e.g. `0.1.0`). Bump it manually before a production build when shipping a meaningful change.

The internal **build number** (`CFBundleVersion` on iOS, `versionCode` on Android) is auto-incremented by EAS because `eas.json` sets `cli.appVersionSource: "remote"` + `production.autoIncrement: true`. Each production build gets a fresh, monotonically-increasing build number — so a build never collides with one already in App Store Connect / Play Console.

## CI integration (planned, not yet wired)

When we wire CI for this:

```yaml
# .github/workflows/mobile-release.yml (sketch)
- run: cd apps/mobile && eas build --profile production --platform all --non-interactive --wait
- run: cd apps/mobile && eas submit --profile production --platform all --non-interactive
```

Triggered manually via `workflow_dispatch` — not on push, because every production build burns a slot in our EAS subscription.

## What the previous release manual-test pass found (MT-35)

- **MT-35-I1** [resolved by this doc + `eas.json`] — there was no committed build pipeline before; the only verified build was the local `Debug-iphonesimulator` build, which is not what ships. Now any contributor can produce a TestFlight or Play internal artifact by running `eas build --profile preview --platform <ios|android>`.
- **MT-35-I2** / **MT-28-I1** — `NSContactsUsageDescription` is declared in `ios/Dina/Info.plist`. The `usePhoneContacts` hook exists (`apps/mobile/src/hooks/usePhoneContacts.ts`) but isn't wired into any screen yet, so an App Store reviewer would flag the unused permission. Either wire the contacts feature or drop the Info.plist entry before the first production submit. Tracked separately.
