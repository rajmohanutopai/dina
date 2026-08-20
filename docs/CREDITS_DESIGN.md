# Dina Starter Credits — Design (UI + Architecture)

> Phase 1 of the credit model (#363). Companion findings:
> `docs/MODEL_COST_QUALITY_FINDINGS.md`. Status: DESIGN (rev 2 —
> incorporates the 2026-06-12 external review: honest copy, anonymous
> claim, App Attest target, Android gated off, config hardening,
> key-as-secret). Phase 2 (IAP top-ups, #362) is designed-for, not built.
>
> **Release sequencing (settled): NOT in the first App Store RC.**
> Submission is decoupled from launch — the RC ships BYOK + a test key
> in App Review notes (starts the review clock, surfaces first-account
> rejections early); credits are the immediate fast-follow update; the
> PUBLIC LAUNCH waits until credits are live, so launch-day first
> impressions get the frictionless onboarding.

## Principles (the design is derived from these)

1. **The grant is an enhancement, never a gate.** Onboarding completes
   fully with the grant service unreachable. A sovereign product's
   first-run must not hard-depend on founder infrastructure.
2. **No proxy.** Dina's infrastructure never sits in the inference hot
   path. The phone talks to OpenRouter directly with a spend-capped key;
   the cap is enforced by OpenRouter, not by us.
3. **Anonymous claim, no-identity ledger, redacted logs.** The grant
   claim carries NO DID and no signed identity headers — the attestation
   is the scarce resource, TLS handles delivery, the attestation
   challenge kills replay. iOS per-device state lives in Apple's
   DeviceCheck bits; our ledger holds only OpenRouter key ids +
   timestamps; access logs redact anything identity-shaped. (We don't
   claim "zero-PII" — the service unavoidably sees source IPs — we
   claim: nothing identity-bearing is requested, stored, or needed.)
4. **Silence First applies to monetization.** One gentle low-balance
   card, in-thread, after an answer. No notifications, no nags, no
   countdown anxiety.
5. **Disclosed, not discovered.** The OpenRouter hop is named in the UI
   the moment credits activate.
6. **Remotely tunable.** Grant size, model pin, and enablement come from
   a config endpoint — changing ₹20→₹30 or rotating the pinned model
   must not require an app release.

## Model policy (settled)

| Tier | Model |
|---|---|
| primary | `deepseek/deepseek-v4-pro` |
| lite | `deepseek/deepseek-v4-pro` |
| heavy | `deepseek/deepseek-v4-pro` |

All-Pro, uniform. Why: (a) V4 Flash silently drops constraints (incl.
health) under multi-constraint load — disqualified as an unguarded
default; (b) prompt caching is per-model, so a uniform model gives one
shared cache namespace across tiers — tier switches never go cache-cold;
(c) no conditional routing to maintain. The model picker is **hidden**
for the credits provider — pinned for reliability, and the pin comes
from server config (rotatable without app update).

## Architecture

```
┌─────────────── Phone (Home Node) ───────────────┐
│ onboarding → identity + vault (NO network dep)  │
│        │ background, non-blocking               │
│        ▼                                        │
│ ┌─────────────┐  signed claim + attestation     │
│ │ grant client│ ────────────────────────────┐   │
│ └─────────────┘                             │   │
│        ▼ key → Keychain ('dina-credits')    │   │
│ ┌─────────────┐   chat/completions          │   │
│ │ LLM router  │ ───────────────────────► OpenRouter
│ │ (credits =  │   (capped key, direct,       ▲  │
│ │  default)   │    deepseek-v4-pro)          │  │
│ └─────────────┘                              │  │
└──────────────────────────────────────────────┼──┘
                                               │ provisioning API
                ┌───────────────────────┐      │ (management key)
   Apple        │  grants service       │ ─────┘
   DeviceCheck ◄│  grants.dinakernel.com│
   Google       │  (tiny, stateless-ish)│
   PlayIntegrity│  + test- variant      │
                └───────────────────────┘
```

### The grants service (new, deliberately tiny)

A standalone TS service (same stack/deploy pattern as msgbox/appview,
`deploy_shared_infra.sh`), isolated because it holds two secrets with
real blast radius: the **OpenRouter provisioning key** and the
**attestation verification keys** (Apple .p8, Google service account).
Nothing else in the fleet gets near them.

Endpoints (xRPC-style for fleet consistency):

- `GET /xrpc/com.dinakernel.credits.getConfig` → `{ enabled, grantUsd,
  modelPin, estConversations }`. Public, cacheable. The client renders
  ALL credit copy from this — grant size changes are server-side.
- `POST /xrpc/com.dinakernel.credits.claimGrant` →
  request: `{ platform, attestation }` — **anonymous by design: no DID,
  no signed identity headers.** The attestation (with its server-issued
  challenge) is the scarce resource and the replay protection; TLS
  handles delivery. The one endpoint where anonymity matters most has
  it.
  response: `{ key, limitUsd, modelPin }` or a typed refusal
  (`already_claimed` / `attestation_failed` / `grants_paused` /
  `platform_disabled`).

Claim pipeline:
1. Verify attestation: iOS → **App Attest** assertion (genuine-app
   proof — the stronger primitive; v1 may ship DeviceCheck-token-only
   with App Attest as the documented target) + DeviceCheck server API.
   Android → **Play Integrity** (see the Android section below); the
   platform stays `getConfig.enabled=false` until its Google Cloud
   credentials are wired, so there is still no weak path shipped by
   default.
2. Per-device once-only: iOS → DeviceCheck **bits** (bit0 = claimed;
   Apple stores the state — we keep no device ledger). Android → Play
   Integrity **Device Recall** bit0 (Google stores the state — same "no
   device ledger on our side" posture).
3. Provision: OpenRouter provisioning API → create runtime key,
   `limit = grantUsd` (~$0.25 ≈ ₹20), label = opaque grant id.
4. Ledger row (ops only, identity-free): `{ grant_id, or_key_id,
   platform, granted_at }`. Access logs redact identity-shaped headers.

Ops/abuse posture: per-IP + global rate limits; daily-grant-count alert
threshold; `grants_paused` kill switch (env/config); OpenRouter
provisioning list/disable for anomaly response. Worst case is bounded:
leaked or farmed keys each die at their cap.

### Client integration

- **Key source, not new provider.** The granted key lives in the
  Keychain under a dedicated `dina-credits` slot (BYOK OpenRouter key
  coexists untouched). The provider layer gains
  `keySource: 'grant' | 'byok'` — when `grant`, `resolveModelId` returns
  the pinned model for every tier and the model picker is hidden.
- **The grant key is a secret, full stop.** Device-bound Keychain
  (`…ThisDeviceOnly`, non-synchronizable), **excluded from Dina's own
  backup/export archive**, wiped on identity erase. By design,
  restore-onto-a-new-device does NOT restore the key — the new physical
  device is legitimately eligible for a fresh claim (its DeviceCheck
  bits are unset).
- **Config hardening (remote tunability ≠ remote attack surface).** The
  client clamps everything `getConfig` returns: model pin must be in a
  compiled-in allowlist, numeric values clamped to sane ranges, unknown
  fields ignored, and compiled-in safe defaults used when the endpoint
  is unreachable or returns anything malformed.
- **Default active provider** after a successful claim = credits. BYOK
  or Ollama selection always wins if the user sets one.
- **Balance, serverlessly.** OpenRouter's `GET /api/v1/key` (called with
  the granted key) returns `usage`/`limit_remaining`. The client reads
  it lazily — on providers-screen open and after every ~5 interactions —
  and converts to "≈ N conversations" using the measured ₹0.55 average
  (from `MODEL_COST_QUALITY_FINDINGS.md`), always rendered with "≈".
- **Exhaustion detection**: OpenRouter 402/limit error → provider flips
  to `exhausted` state → the wall card (below). Non-LLM features (vault
  browse, reminders list, history) keep working untouched.
- **Resilience**: claim runs in the background AFTER onboarding
  completes. Unreachable service → silent retry w/ backoff + the
  "add your own key" affordance is always present. Never a blocking
  spinner, never an error wall.

## Android path (Play Integrity + Device Recall) — BUILT

The Android analog of iOS DeviceCheck. Same shape everywhere: an
anonymous claim, no DID, a per-device once-only bit stored on the
platform's side, a spend-capped OpenRouter key in return.

**Client (`modules/dina-attest` Android + `src/ai/attestation.ts`).** A
Kotlin Expo module wraps the Play Integrity **Standard** API
(`prepareIntegrityToken` once per cloud project, then `request` with a
per-request hash). `getPlayIntegrityToken()` returns a token on a genuine
device and null on every no-token path (iOS, emulator / no Play services,
missing cloud-project config, dev override, native error) — so the claim
parks as `unavailable` and BYOK stays the door, exactly like iOS.
`runClaimFlow('android', …)` sends `{ kind: 'play_integrity', token }`;
if Play Integrity yields null it falls back to the DeviceCheck seam, so
the dev fake-attest override still drives an emulator claim.

**Server (`apps/grants-service/src/play_integrity.ts`).** A
`PlayIntegrityClient implements DeviceState`. `check` decodes the token
via `…:decodeIntegrityToken` (authed with a Google service-account access
token, minted in `google_oauth.ts`) and enforces:
- **package binding** — `requestDetails.requestPackageName` == our app;
- **freshness** — `timestampMillis` within 10 min (a stale token is a
  replay → `invalid`);
- **device integrity** — the verdict must include `MEETS_DEVICE_INTEGRITY`
  (an emulator/rooted device reports only `MEETS_BASIC_INTEGRITY` or an
  empty verdict → `invalid`). This is the anti-farm gate.
Then it reads **Device Recall** `bitFirst` as the "already claimed" bit.
`setClaimed` writes that bit via `…:writeDeviceRecall`. Same
invalid / unavailable / `{claimed}` contract as DeviceCheck — a Google
outage or our own misconfig (401/403/5xx) is `unavailable` (the device
retries), never a device brick.

**Replay model (v1).** Freshness + Device Recall carry replay protection:
a genuine device claims once, the recall bit blocks re-grants, and the
global daily ceiling + per-IP limit bound the small window before the bit
is written. A **server-issued signed challenge** (a stateless HMAC nonce
the client feeds to Play Integrity and the server verifies) is the
documented hardening, deferred — it needs no protocol change (the nonce
rides inside the token), so it can land later without a client break.

**Enablement.** `GRANTS_ENABLED_ANDROID=1` plus the Google secrets
(`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`,
`ANDROID_PACKAGE_NAME`) turn it on; config validation refuses to boot
Android-enabled without them. The dev bypass (`GRANTS_DEV_ALLOW_ANDROID`,
paired with the fake DeviceState stub and the client's
`EXPO_PUBLIC_DINA_FAKE_ATTEST`) lets an emulator drive a real mint with no
Google creds — DEV/E2E ONLY, never in the prod deploy.

### Play Console setup runbook (operator — the one part code can't do)

Play Integrity only "recognizes" the app once it is on a Play Console
track, so this dovetails with the Android Play Store submission.

1. **Play Console → App integrity → Play Integrity API.** Link the app to
   a Google Cloud project; note its **cloud project number**.
2. **Turn on Device Recall** for the app (App integrity → Device Recall)
   — this is what backs the once-per-device bit.
3. **Google Cloud → IAM → Service Accounts.** Create a service account,
   grant it the Play Integrity API on the project, and download a JSON
   key. Feed its `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
   `private_key` → `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (single-line,
   `\n`-escaped) to the grants service.
4. **Enable the Play Integrity API** in the Cloud project's API library.
5. **Client build:** set `EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER` to
   the cloud project number (build-time inline). Put the app on at least
   an internal-testing track so integrity verdicts evaluate.
6. **Flip on:** `GRANTS_ENABLED_ANDROID=1` on the grants service, redeploy.
7. **Verify on a REAL device** (an emulator fails device integrity by
   design): fresh install → onboard → the grant lands; a second install
   on the same physical device → `already_claimed` (Device Recall held).

## UI design

Visual language: existing Dina aesthetic — warm cream (#F9F2EC), serif
display for headers, soft rounded cards, understated. Credits should
feel like **hospitality, not a meter**. The word "credits" is internal;
the user-facing noun is **conversations**.

### 1. Onboarding moment (after identity creation, inside the existing flow)

```
┌──────────────────────────────────────────┐
│           Your first conversations       │
│                are on us.                │
│                                          │
│   No account. No card. No API key.       │
│   Just start talking to Dina.            │
│                                          │
│   ﹙ small print ﹚                        │
│   Starter conversations run directly     │
│   through OpenRouter — Dina does not     │
│   proxy or store them. For maximum       │
│   privacy, use your own AI provider key  │
│   or a local model (Settings).           │
└──────────────────────────────────────────┘
```

No button — informational beat, auto-advances. If the claim hasn't
resolved yet, nothing here blocks; the chat opens regardless and a
hairline status under the composer reads "getting your free
conversations ready…" until the key lands (then disappears silently).

### 2. AI-providers screen — the credits tile (replaces nothing; sits first)

```
┌──────────────────────────────────────────┐
│ Dina Starter Credits          ACTIVE     │
│ Free conversations, on the house         │
│                                          │
│  ◔ ≈ 41 conversations left               │
│                                          │
│ Model — deepseek-v4-pro · pinned for     │
│ reliability                              │
│ Privacy — runs directly through          │
│ OpenRouter; Dina does not proxy or       │
│ store these conversations. Your own key  │
│ or a local model is more private. →      │
└──────────────────────────────────────────┘
```

Notes: a soft quarter-ring meter (not a red bar) for remaining balance;
no rupee/dollar figures anywhere; no key string shown (it's not the
user's key); no Remove action (nothing to manage). The privacy line
links to the trust-ladder explainer (credits → BYOK → Ollama).

### 3. The low-balance card — the ONLY proactive moment (Silence First)

Appears once, inline in the chat thread, attached after a completed
answer when ≈5 conversations remain. Never a push notification.

```
┌──────────────────────────────────────────┐
│ ☕ Your starter conversations are        │
│ almost used up — about 5 left.           │
│                                          │
│ Two ways to keep going:                  │
│  ▸ Use your own AI provider key          │
│  ▸ Run a local model (most private)      │
│                                          │
│            [ Set up ]      [ Later ]     │
└──────────────────────────────────────────┘

(When #362 ships, getConfig flips a third row on: "▸ Top up". Until
IAP exists, purchasable credits are NOT mentioned anywhere in-app —
pre-announcing them invites the App Review question we don't want.)
```

"Later" dismisses permanently (state persisted) — it never reappears;
the wall card covers the terminal case.

### 4. The wall card (grant exhausted)

Replaces the LLM answer slot when a request hits the cap; warm, honest,
zero guilt:

```
┌──────────────────────────────────────────┐
│ That's the last of your free             │
│ conversations — thanks for spending      │
│ them with Dina. 🌱                       │
│                                          │
│ Everything you've saved stays yours,     │
│ on this device. To keep talking:         │
│  ▸ Use your own AI provider key          │
│  ▸ Run a local model (most private)      │
│                                          │
│            [ Set up ]                    │
└──────────────────────────────────────────┘
```

Composer stays enabled for non-LLM commands; LLM-needing sends re-show
the card (it doesn't stack — single instance pinned at thread bottom
until resolved). Top-up row appears here too only after #362 ships
(config-driven).

### Copy rules (persona work + App Review constraints)
- Never show currency; always "conversations", always "≈".
- Disclose OpenRouter by name at activation and on the tile — phrased
  honestly: "runs directly through OpenRouter; Dina does not proxy or
  store these conversations." **NEVER "no logging"/"nothing logged"** —
  downstream providers receive prompts; that's an overclaim.
- **In-app**, BYOK is "use your own AI provider key" (neutral —
  guideline 3.1.1: avoid anything that reads as steering around IAP).
  The "free forever" framing lives in web/marketing copy only.
- "fully private" is reserved for the local-model option only, and even
  there prefer "most private".
- No mention of purchasable credits anywhere in-app until IAP exists.
- No "running out!" urgency language anywhere; no red.

## Failure modes

| Failure | Behavior |
|---|---|
| Grants service down at onboarding | Onboarding completes; silent retry w/ backoff; BYOK affordance present; hairline status only |
| Attestation fails (emulator/jailbreak/old OS) | Typed refusal → quiet "free credits aren't available on this device" + BYOK/Ollama paths; never accusatory |
| OpenRouter outage | Standard provider-error card (already exists); retry |
| Key extracted/shared | Bounded by cap; OpenRouter per-key disable for anomalies |
| Grant exhausted | Wall card; local features unaffected |
| Config endpoint unreachable | Client uses last-cached config; defaults compiled in |
| Grants paused (kill switch) | getConfig.enabled=false → onboarding skips the credits beat entirely; BYOK path is the onboarding default again |

## Phase 2 hook (IAP top-ups, #362 — designed-for, not built)

Top-up = **raise the cap on the same key**: client sends the store
receipt to `com.dinakernel.credits.topUp` → service validates with
Apple/Google → OpenRouter provisioning PATCH raises `limit`. Same key,
same pinned model, no client key-swap. Ledger gains a receipts table
(store transaction id ↔ grant_id — still identity-free). A "Top up"
row then appears on the wall/low-balance cards, driven by getConfig.

## Build plan (#363 — fast-follow AFTER the first RC submission)

1. **Verify OpenRouter provisioning API live** (create/cap/disable/PATCH
   limit; provider data-handling settings) — with the founder's account.
2. **Pre-req test: salon/services schema-strict flow on V4 Pro** (the
   one untested path — frozen schemaSnapshot validation).
3. Grants service (config + claim; **iOS only at v1 — Android stays
   `enabled=false`** until Play Integrity/Device Recall verification)
   + deploy test- variant.
4. Client: keySource plumbing, anonymous claim flow, balance read,
   model pinning + config clamping, key-as-secret handling (device-only
   keychain, export-excluded), provider tile.
   ✅ Native attestation: local Expo Module `dina-attest`
      (modules/dina-attest, iOS-only, DeviceCheck — no entitlement).
      Autolinking discovery verified; Swift compiles on the next EAS
      build. getDeviceCheckToken graceful on every no-token path.
5. UI: onboarding beat, low-balance card, wall card (+ tests per card).
6. E2E on TestFlight with real DeviceCheck/App Attest (sim can't attest
   — REAL device required; folds into #360's device-validation pass).
7. Launch-copy sync: privacy page + persona-doc honesty lines (the
   "no logging" phrase is banned there too).

## Open questions (parked, not blockers)

- ✅ Android Play Integrity / Device Recall — the grant path is BUILT
  (client Kotlin module + server verifier, see the Android section).
  Remaining before enabling: the Play Console setup runbook + a
  real-device E2E, and a quota check on Google's decode/Device-Recall
  APIs at expected claim volume.
- App Attest in v1 vs DeviceCheck-token-only first (App Attest is the
  documented target either way).
- Grant size A/B later (config-driven, no release needed).
- Whether the credits tile should surface measured per-conversation cost
  transparency post-#362 (leaning no — currency stays internal).
