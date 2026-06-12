# Mobile Store Release — Runbook (#360/#361)

Status: production-config audit DONE (2026-06-12). First production build:
pending the interactive steps below.

## Audit results (verified 2026-06-12)

| Item | State |
|---|---|
| `eas.json` production profile | ✅ store distribution, autoIncrement, channel `production` |
| Endpoints | ✅ `EXPO_PUBLIC_DINA_ENDPOINT_MODE=release` resolves mailbox/pds/appview.dinakernel.com + plc.directory from `packages/home-node/src/endpoints.ts` baked-in release set; eas.json's explicit URLs match |
| Local `.env` (test endpoints, dev Gemini key, dev passphrase/owner) | ✅ gitignored ⇒ **excluded from EAS uploads**; none of the `DEV_*`/`TEST_INJECT`/provider-demo vars are set in the production profile ⇒ undefined in store builds |
| OAuth client URL | ✅ defaults to `https://mobile.dinakernel.com` when unset (`src/services/atproto_oauth.ts`) — ⚠️ VERIFY prod infra actually serves client-metadata there (test uses test-mobile.dinakernel.com) |
| Bundle IDs | ✅ `com.dinakernel.mobile` (iOS + Android) |
| EAS project | ✅ `projectId 061afa64-…` exists (Expo account already initialized) |
| Apple Team ID | ✅ `9DCZ8PHCDP` filled into `submit.production.ios` |
| Apple ID email | **Deliberately NOT in eas.json** (public repo, founder privacy). `eas submit` reads `EXPO_APPLE_ID` env var or prompts interactively |
| `ascAppId` | placeholder — fill after the App Store Connect app record exists |
| App version | ✅ bumped 0.0.1 → 1.0.0 (build numbers auto-increment remotely) |
| `ITSAppUsesNonExemptEncryption: false` | set — ⚠️ #361 review item: standard-algorithm exemption is the right category for SQLCipher/NaCl/Ed25519, but confirm + calendar the annual US self-classification report (and France declaration if distributing there) |
| `UIBackgroundModes: ["remote-notification","fetch"]` | ⚠️ #361 review item: we have no remote-push server; reminders are local notifications. Unused background modes can draw App Review questions — decide keep (future push) vs drop |

## First production build — interactive steps (founder)

```bash
npm install -g eas-cli          # or: npx eas-cli@latest
cd apps/mobile
eas login                        # Expo account
eas build --platform ios --profile production
#  → first run: sign in with the Apple Developer account when prompted.
#    EAS registers the bundle ID, creates the distribution cert +
#    provisioning profile on the account (Team 9DCZ8PHCDP), builds in
#    the cloud, and outputs an .ipa.
eas build --platform android --profile production   # .aab for Play
```

Then iOS TestFlight:
```bash
# Creates/links the ASC app record on first run (interactive) and
# uploads the build to TestFlight:
EXPO_APPLE_ID=<your-apple-id-email> eas submit --platform ios --latest
#  → after the ASC app exists, copy its numeric Apple ID into
#    eas.json submit.production.ios.ascAppId
```
TestFlight → App Store Connect → TestFlight tab → add yourself as
internal tester → install via the TestFlight app on the phone.

Android (no Play console account yet?): `eas build` produces an .aab;
for device testing before Play setup, build the preview profile
(`--profile preview` → installable APK) or set up Play internal track
(needs the service-account JSON at `secrets/play-store-service-account.json`).

## Real-device validation checklist (the sim-impossible items)

1. Fresh onboarding on the real phone — incl. LIVE PDS account creation
   against pds.dinakernel.com (prod, first real account).
2. Reminder local notifications fire (app foreground, background, killed).
3. **Real iOS backgrounding:** background the app 2+ min → foreground →
   relay reconnects instantly (`[WS] wakeRelay` — the #359 true test);
   then a D2D/agent round-trip immediately after foregrounding.
4. MsgBox over cellular; wifi↔cellular handoff mid-session.
5. Auto-lock + unlock on device (Face ID interactions if wired).
6. Overnight battery with the app backgrounded (keepalive behavior).
7. Backup export → restore on the second platform (iOS↔Android).
8. Agent pairing + approval cards end-to-end against prod relay.
9. Salon Tier-1 flow against prod AppView (publish, discover, book,
   approve) — first prod-infra services round-trip.
10. Log hygiene in release build (no PII in device console).

## Submission gates (#361 — decide BEFORE submitting)

1. **Reviewer access (2.1 risk):** onboarding requires an LLM API key.
   Options: review-notes test key / built-in trial provider / demo mode.
   DECISION NEEDED.
2. Export compliance: declaration set to exempt — file the annual
   self-classification report; France addendum if applicable.
3. Guideline 4.8: "Login with Bluesky" is identity-linking, not account
   login (primary onboarding = self-created DID) — pre-argue in review
   notes; assess Sign-in-with-Apple obligation.
4. Privacy nutrition labels ("Data Not Collected" — verify precisely:
   the app itself collects nothing; LLM calls go to the USER'S chosen
   provider) + privacy policy page written & hosted.
5. Age rating, screenshots (marketing/DEMO_VIDEOS.md), App Previews
   (V2/V3/V4-portrait).
