# Demo Videos — Marketing Plan & Production Spec

**Status:** decided (2026-06-11) · for the v1 public release.
Companion docs: `README.md` (vision), `docs/reports/MRS_RELEASE_RUN_2026-06-10.md`
(every scenario below was live-verified there), `dina_details.md` (recording/driving
recipes), `docs/SERVICE_PROVIDER_TIERS.md` (what NOT to promise yet).

**The rule this plan follows:** each video sells exactly **one belief** to exactly
**one audience**, and every belief shown must be live-demoable today — no mockups,
no vaporware. The MRS run is the shot list.

---

## Part 1 — Who actually installs this on day 1 (the marketing analysis)

Dina is a sovereign personal AI that requires: installing an app, holding a recovery
phrase, and (for the most differentiated feature) pairing a CLI agent. That filters the
day-1 audience hard. Be honest about the funnel and sequence the waves:

### Wave 1 — Agent-CLI power users (the beachhead) 🥇

**Who:** people already running Claude Code, Codex, Gemini CLI, OpenClaw daily.
**Their pain (felt, not taught):** "my agent runs with my credentials, unsupervised,
and I read horror stories weekly." Nobody else offers a *phone-approval loop* for
agent actions where the agent never holds the keys.
**Why they convert:** `pip install dina-agent` + `dina init` + paste one code is
inside their muscle memory. The setup-code → skill → runner chain we shipped exists
*for* this audience.
**Where they live:** Hacker News (Show HN), X/Twitter dev circles, r/ClaudeAI,
r/LocalLLaMA, lobste.rs.
**What they must SEE:** the 60-second terminal+phone split screen. Words won't do it.

### Wave 2 — Bluesky / AT Protocol community 🥈

**Who:** ATProto devs and Bluesky early adopters. Dina is *built on their protocol*
(did:plc, community PDS, Jetstream, lexicons; PeerLens is an AppView) and offers
"Link your Bluesky" at onboarding.
**Why they convert:** they install things on principle — decentralization,
self-sovereign identity, "credible exit." Dina is the first *personal AI* native to
their stack.
**Where they live:** Bluesky itself (post the video there), ATProto dev Discord.
**What they must SEE:** the did:plc minted at onboarding, PeerLens as an AppView,
"your DID, your data."

### Wave 3 — Self-hosters & privacy enthusiasts 🥉

**Who:** r/selfhosted, r/privacy, local-LLM crowd, Signal-user archetypes.
**Why they convert:** "loyalty enforced by math, not by a privacy policy" — the
recovery phrase, per-persona encrypted vaults, locked tiers, quarantine of strangers.
**What they must SEE:** keys generated on device; a locked Financial vault refusing
even the AI; a stranger's message held at the door with the body hidden.

### Wave 4 — Privacy-leaning consumers (App Store organic)

**Who:** people who find the listing by search/press. They won't watch a terminal.
**What they must SEE (in ≤30s, muted, vertical):** the app remembering something
human ("Emma loves dinosaurs") and using it later; the phone catching an agent
red-handed; a real-world answer with a source. This wave converts on **App Store
previews + screenshots**, not on social videos.

### Wave 5 — Service providers (Tier 1) — **DO NOT market yet**

The "offer a service with a phone and a sentence" story is the long-term killer, but
Tier 1 is not built (see `SERVICE_PROVIDER_TIERS.md`). The bus-42 video plants the
seed from the *consumer* side only. No provider-facing video until Tier 1 ships —
first rule of demos: never show what can't be installed today.

### Interested observers (not installers)

AI-safety researchers, journalists covering agent autonomy, ATProto ecosystem
watchers. Served by the long-form architecture walkthrough (V9), which doubles as
the "documented thinker" asset.

### The one-line positioning per wave

| Wave | One-liner |
|---|---|
| Agent users | "Your agent asks. You decide. It never holds your keys." |
| ATProto | "A personal AI that's *yours* — did:plc, your PDS, our AppView." |
| Self-hosters | "Loyalty enforced by math, not by a privacy policy." |
| Consumers | "An AI that remembers your life — and guards it." |
| (later) Providers | "Offer a service with a phone and a sentence." |

---

## Part 2 — Store-upload constraints (they shape the cuts)

### Apple App Store — App Previews

- Up to **3 previews per locale**, each **15–30 seconds**, plus 10 screenshots.
- Footage must be **captured from the app itself** (screen recording of real UI).
  No terminal footage, no hands-holding-phone B-roll, minimal overlay text. The
  dev-hero split screen **cannot be an App Preview** — it lives on social/YouTube.
- Autoplays **muted** in search/results → the first 3 seconds must work silently;
  burn in captions; pick the poster frame deliberately (it's the de-facto 4th
  screenshot).
- Capture portrait at the 6.9" class size (iPhone Pro Max sim, 886×1920 export);
  `xcrun simctl status_bar override --time 9:41 --batteryLevel 100` before recording.
- Review-safety: the `transfer_money` moment is shown as a **denial/approval gate**
  (a safety feature, not a money-transmission feature) — caption it as such.
- Use only demo-canon personas (Emma, Sancho, Alonso — UTOPAI canon) in any recorded
  vault content. Never record against a vault holding real data.

### Google Play

- Promo video = a **YouTube link** (landscape OK, ~30s ideal) + screenshots. The
  consumer cut of the dev-hero or the Sancho film can serve directly; less
  restrictive than Apple, so derive don't re-shoot.

### Screenshots (higher conversion than video — do not skip)

First three decide the install: ① chat showing a remembered fact + enriched
reminder, ② the agent-approval card mid-buzz, ③ the bus-42 ETA service card with
"via SF Transit" attribution. Then: People/Relations, PeerLens browse, recovery
phrase screen (blurred words), quarantine card.

---

## Part 3 — THE DECIDED VIDEO SET

Ten slots, three tiers. Tier A blocks launch; Tier B fills launch week; Tier C
sustains. Every Tier A/B scene passed live in the 2026-06-10 MRS run.

### Tier A — launch-blocking

#### V1 · "Your agent just tried to move money." — the dev hero (60s, landscape, split screen)

- **Audience/channel:** Wave 1 · Show HN, X, Reddit, YouTube. *Also the Play Store promo.*
- **Belief:** agents act for you, but only with consent — and they never hold keys.
- **Hook (0–3s):** terminal already mid-command (`transfer $2,400…`) → **phone slams
  an approval card**. Cold open on the money shot, then rewind to the setup.
- **Beats:** ① `pip install dina-agent` → `dina init` → paste the setup code from
  Settings → `CONNECTED` (~15s real time — show it uncut, the speed IS the pitch).
  ② Agent runs a safe task → passes silently (Silence First, one caption).
  ③ Agent tries `transfer_money` → HIGH-risk card on the phone → **Deny** →
  terminal shows `blocked`. ④ Agent asks for a Health fact → approval → returns
  *only* HbA1c, refuses what's not granted. Close caption: "The agent never saw a
  key. `pip install dina-agent`."
- **Production:** two captures composited — `asciinema`/clean terminal left,
  `simctl io recordVideo` right; clocks synced by doing it live in one take (we have
  the exact MRS-07/08 command sequence). **Record on a freshly-launched app session**
  (#351 WS staleness).

#### V2 · App Preview 1 — "She remembers." (≤30s, portrait, UI-only)

- **Audience:** Wave 4 App Store browsers. **Belief:** a private mind that remembers
  your life and connects the dots.
- **Beats:** type "Emma loves dinosaurs" → *Stored*. Type "Emma's birthday is Nov 7"
  → reminder card minted. Cut forward: "what should I get Emma?" → answer weaves in
  **dinosaurs**. Caption: "It connected those itself. On your device."
- **Source flows:** MRS-01/02 (the dinosaur enrichment), re-drivable by the existing
  idb/Maestro recipe.

#### V3 · App Preview 2 — "She guards." (≤30s, portrait, UI-only)

- **Belief:** Dina is the bouncer — for agents *and* strangers.
- **Beats:** agent-approval card appears ("An agent wants to read Health") → user
  taps Deny → "Blocked." Then a stranger's message arrives → **quarantine card,
  body hidden** → Block. Caption: "Nothing reaches you — or your data — without
  your yes."
- **Source flows:** MRS-07/08 approval cards + MRS-05 quarantine. (Trigger the
  cards via the paired agent / d2d harness off-screen; only app UI is recorded —
  App-Store-legal.)

#### V4 · App Preview 3 — "Ask the real world." (≤30s, portrait, UI-only)

- **Belief:** answers come from verified sources, not ads (Pull Economy).
- **Beats:** "When does bus 42 reach Castro St?" → service-query card → **ETA card,
  "via SF Transit"** attribution → a reminder offer. Close on PeerLens browse for
  "coffee" with trust badges. Caption: "Ranked by trust. Not by ad spend."
- **Source flows:** MRS-10 (bus42 provider stack on :18298) + MRS-09 browse.

### Tier B — launch week

#### V5 · "The Sancho Moment" — the consumer film (75s, landscape + vertical cut)

- **Audience:** Waves 3–4, press. **Belief:** an AI that connects you to humans,
  never replaces them (Anti-Her — the emotional differentiator no competitor can copy).
- **Beats:** Sancho texts "coming over tomorrow morning" → Dina quietly mints
  "**keep the cold brew ready**" (it remembered his preference from your own vault).
  Contrast beat: a stranger's message → held at the door. Closing line over the
  People graph: "Dina knows your people. She works for you — and points you back
  at them."
- **Source flows:** MRS-04 cold-brew enrichment + MRS-05 — both passed live.

#### V6 · "Your keys. Your AI." — the sovereignty loop (30s, vertical)

- **Audience:** Waves 2–3 · Bluesky, r/selfhosted, r/privacy.
- **Beats:** fresh onboarding → name → **did:plc minted on a community PDS** →
  recovery phrase appears (blur the words) → vault tiers screen → Financial:
  *Locked — even Dina's AI can't read this*. Caption: "Loyalty enforced by math,
  not by a privacy policy. Built on AT Protocol."
- **Source flow:** MRS-12 fresh install (alon18 run) — ~7 steps to working chat,
  itself a quiet selling point.

#### V7 · Vertical money-shot loops (3 × 15s, 9:16, Shorts/Reels/TikTok/Bluesky)

Pure cuts, no new recording: **(a)** approval-card slam from V1 ("Caught it."),
**(b)** dinosaur connection from V2, **(c)** quarantine card from V3 ("Strangers
wait outside."). Loop-friendly: last frame ≈ first frame.

### Tier C — sustain / later

- **V8 · "A day with Dina" (2–3 min, YouTube):** stitches morning briefing → agent
  task gated → bus query → Sancho nudge. The world-we're-building film; cut it from
  Tier A/B footage plus one briefing capture.
- **V9 · Architecture walkthrough (8–12 min, founder-narrated):** intent-gating
  flow, key isolation, persona walls, MsgBox relay, PeerLens on ATProto. Serves
  researchers/press/hiring; pairs with the deep-writing strategy. Screen-share +
  `FLOW_DIAGRAMS.md`, minimal production.
- **V10 · "Offer a service with a sentence" — HOLD.** Tier 1 provider story; do not
  produce until `runCapability` + instruction field ship. When it lands, this
  becomes the new hero.

---

## Part 4 — Production notes (read before recording anything)

1. **#351 first or fresh sessions only.** Any scene touching agents/services/Talk
   rides the MsgBox WS; the idle-staleness bug ("No response from SF Transit…")
   *will* ruin takes. Record within minutes of app launch, or land the heartbeat
   fix first (it's the top fast-follow anyway).
2. **Every scene has a deterministic driver.** The MRS run left idb coordinate
   scripts + Maestro flows for ask/remember/task/approvals/quarantine/services
   (`/tmp/mrs_run/hybrid.sh`, `apps/mobile/maestro/`) — takes are repeatable until
   the take is right. `maestro record` can render flows directly for rough cuts.
3. **Capture:** `xcrun simctl io <udid> recordVideo --codec h264 out.mov` (sim) —
   but for App Store final footage prefer a **physical device** capture if available;
   sim capture is acceptable for social. Status-bar override before every take.
4. **Clean test bed per take:** fresh onboarded identity + guided-demo-style seed
   data (Emma/Sancho/Alonso canon). Never record a vault with real personal data;
   run the MRS-14 log-hygiene mindset on what's visible on screen too (no real
   DIDs of real contacts, no API keys in Settings shots).
5. **Muted-first editing:** all captions burned in; voiceover is a bonus layer for
   YouTube only. First 3 seconds must communicate the belief silently.
6. **One belief per video.** If a cut starts explaining a second feature, split it.

## Part 5 — Order of production

| # | Video | Why this order |
|---|---|---|
| 1 | **V1 dev hero** | Beachhead wave; hardest composite (two captures); everything else derives confidence from it |
| 2 | **V2–V4 App Previews** | Block the store listing; UI-only, fastest to capture once the test bed is seeded |
| 3 | Screenshots set | Same seeded bed, same session as V2–V4 |
| 4 | **V6 sovereignty loop** | One fresh-onboard take; Bluesky wave post |
| 5 | **V5 Sancho film** | Needs the most editing care (it carries emotion) |
| 6 | V7 cuts | Free — derived from 1–5 |
| 7 | V8/V9 | Post-launch week |
| — | V10 | Blocked on Tier 1 build |
