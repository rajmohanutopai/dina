# Manual Release Sanity — Full E2E Run (post-Tier-1 / keepalive / codec)

**Date:** 2026-06-11 (evening) · **Build:** commit `563a9fd1` (Tier 1 prompt-provider +
architecture-debt round) · **Relays:** test + **prod** MsgBox deployed this day with the
ping/pong keepalive. **Driver:** Maestro (testID-driven) + idb-coordinate hybrid where the
documented input-bar / RN-Modal flakes hit. **Devices:** iPhone 17 Pro sim
(`6D57…BACB7`, owner identity `alon18`/did:plc:f3vdr5…) + Pixel emulator (`emulator-5554`,
the customer, then re-onboarded fresh for MRS-12). Cloud test infra
(test-pds/appview/mailbox); bus42 lite-Core `:18298` + eta daemon; one paired
`dina-agent` re-paired live this run.

**Every row below is a live assertion** (Maestro step result or a read screenshot), not a
Jest test.

## Verdict: RELEASE-READY

All nine product promises pass end-to-end on the post-Tier-1 build, plus Tier 1 itself
(salon availability + booking approval) and the new per-listing vault pin. One scenario is
environment-degraded (MRS-10 bus42 transit variant — polluted competing AppView listings,
not a code regression; the services path is GREEN via the salon Tier 1 round trip). No
P0/P1 regressions.

## Golden-path results

| MRS / MT | Scenario | Result | Evidence |
|---|---|---|---|
| smoke | Tab navigation | ✅ PASS | tabs_smoke 7/7 green |
| MRS-01/02 | Remember → vault + Ask recall | ✅ PASS | "Emma loves dinosaurs" → General; "What does Emma like?" → *dinosaur* |
| MRS-01b | Persona routing | ✅ PASS | persona_routing 11/11 |
| MRS-03 | Reminder + enrichment (with/without) | ✅ PASS | plain fact → NO reminder; "Emma's birthday Nov 7" → reminder card weaving in *dinosaur* (13/13) |
| MRS-04 | Talk (D2D) + enrichment | ✅ PASS | named contact Alonso (2nd live sender) → "Coming over tomorrow morning" → enriched reminder; cold-brew memory seeded; decrypt/verify silent |
| MRS-05 | Talk safety — unknown sender | ✅ PASS | unknown sender → quarantine card (body hidden) → **Accept** → "Added to contacts" + message released (5/5) |
| MRS-06 | Task via agent | ✅ PASS | `dina task --dry-run` → MODERATE intent card → approve on device → validate-status=approved |
| MRS-07 | Security — agent reads locked vault | ✅ PASS | `dina ask "blood pressure"` (Health locked) → 🔐 card → approve → returned HbA1c=9% only, refused BP (not in vault) |
| MRS-08 | Approvals — risky agent action | ✅ PASS | `dina validate transfer_money` → HIGH card → native confirm → approved; CLI unblocked |
| MRS-09 | PeerLens search/browse | ✅ PASS | Network → Browse → "coffee" → search-screen (9/9), no crash |
| MRS-10 | Services — public E2E (Tier 1) | ✅ PASS | **salon Tier 1**: "What haircut times are free today" → "4:30 PM and 5:15 PM" card via Alonso's Salon (in-process runtime, real signed/relayed path) |
| MRS-10b | Services — bus42 transit (Tier 3) | ⚠️ ENV | 3 competing `eta_query` listings on test-appview (2 dead: stale morning provider + alon18 env-seeded self-listing w/ no transit runner). Single-shot router picked a non-responder → "no response, try again". Live bus42 provider (`sluk5…`) is up + authenticated; answered earlier today. Test-data pollution, not a regression. |
| MRS-12 | Fresh install — first-run onboarding | ✅ PASS | Android `pm clear` → dev-client deep-link re-point → welcome → Create new → name → handle (`alonso` taken → picked available `alon16`, live PDS check) → passphrase + auto-unlock → recovery-skip → **AI auto-connected** → **did:plc provisioned on test-pds** → first-run guided-demo gate → Start empty → working Chat. Fresh identity functional. |
| MRS-13 | Durability — restart persists | ✅ PASS | stored "favorite planet is Neptune" → real `terminate`+`launch` (no re-onboard) → "What is my favorite planet?" → **Neptune** recalled; chat history + reminders survived |
| MRS-14 | Safety — log hygiene (OS log) | ✅ PASS | 118k-line iOS `simctl log` grepped for Neptune/cold brew/HbA1c/9%/dinosaur/Barclays/0102/BP/recovery/seed/API keys: **zero** real leaks (only AX-element-ID substring false-positives) |
| GD-01 | Guided demo (Help-page replay) | ✅ PASS | Help → "See Dina in action" → demo active (GUIDED DEMO banner) → **Exit** → banner cleared, real chat (Neptune) intact, **no demo rows leaked** (data-scope isolation holds) |
| MT-35/89 | Pair dina-agent (setup code) | ✅ PASS | Settings→Agents → Generate → long-press code → `dina configure --headless --setup-code` → "Paired! … MsgBox Connected" (the 245-char `dina1:` string; greenfield, no numeric fallback) |
| MT-91 | Headless runner execution (`claude -p`) | ✅ PASS (live on 563a9fd1) | `dina agent-daemon --runner claude-code` running; mobile Task chip → `delegate_to_agent` creates an **untagged `free_form_task`** → daemon claims it over MsgBox (`task-26ba21b6d3a87c02`) → **`claude -p` executes** → result reported → DINA: "The paired agent has successfully executed the task: **MT91-LIVE-OK**" (appears **once** in Chat). **Tier-1 lane proof:** the untagged delegation went to the EXTERNAL agent and was NOT eaten by alon18's always-on in-process `dina.local` runner — the exact-match lane change holds live. (First attempt timed out on the 60s `delegate_to_agent` window because the app was BACKGROUNDED by deep-link automation — an artifact, not a daemon WS bug; see corrected finding below.) |

## Credited (verified earlier THIS session, not re-run)

| Item | Result | When |
|---|---|---|
| Tier 1 salon E2E (availability auto + booking review approval) | ✅ owner approval card → "Confirmed · 16:30" | earlier today |
| Per-listing vault pin ("ANSWERS FROM") | ✅ pinned salon to `general`, answered E2E | earlier today |
| Codec / dropped-fields fix | ✅ booking executed against the right listing | earlier today |
| Relay keepalive (test + prod) | ✅ zero `[WS] stale` over the run; both deploys health-green | this day |

## Findings (non-blocking)

- **MRS-10b bus42 (environment):** the test AppView accumulated 3 `eta_query` providers
  across a day of runs; 2 are dead-ends. The consumer's **single-shot** routing picks one
  candidate with no failover to the next when it doesn't respond — that's a real (small)
  **product observation**, but the demo failure is test-data pollution. Cleanups attempted
  (delete/pause the env-seeded self-listing) need native confirm dialogs idb can't drive +
  AppView ingester lag; left for a bed reset. The services PATH is proven GREEN by the
  salon Tier 1 round trip.
- **Test-orchestration (not product):** the RN-`<Modal>` "clear chat" menu and the
  input-bar after a 3-chip layout shift (Ask/Remember/**Task** once an agent is paired)
  flaked under pure Maestro — worked around with idb taps. Flows that pre-clear chat and
  the chip-coordinate taps need a refresh pass before they're CI-clean.
- **Agent CLI role:** `dina configure` defaulted the LOCAL config to `role: user` (the
  device registered as agent app-side); `dina task` needs `role: agent`. Set it and MRS-06
  passed. The pairing flow should carry the role through, or `dina task` should read the
  app-side role — minor CLI polish.
- **~~Python daemon WS staleness~~ — CORRECTED, no bug:** initial read suspected the
  daemon's relay WS didn't self-heal. Re-reading `cli/src/dina_cli/transport.py` disproved
  it: `MsgBoxTransport` opens a **fresh WS per `request()`** and closes it in `finally`
  (line 488), with exponential backoff already present — there is no persistent idle WS to
  keep alive, so #351's heartbeat doesn't apply. A traced claim with the Home Node app
  foreground matched in **~1.2s**. The `frames_seen=0` was purely the **iOS app being
  backgrounded** (JS suspended → MsgBox not processing) by deep-link automation churn —
  fixed by keeping the app foreground (idb taps, no deep links), after which MT-91 ran
  green. **The daemon needs no code change.** (Genuine takeaway: a *mobile* Home Node that
  the OS backgrounds can't serve agent claims — inherent to "the phone is the Home Node",
  worth a product note about a foreground/keep-alive affordance, not a WS bug.)

## Not run this session (honest)

| Item | Why | Status |
|---|---|---|
| MRS-11 known_only grant differential | harness-side; verified live 2026-06-10 | credited |
| MRS-12 "Login with Bluesky" | real external OAuth credential | manual, by hand |
| MRS-13 full restore-into-clean-install | OS file picker not Maestro/idb-drivable | manual; restart-persistence (✅) + export are the automatable sub-checks |
| Cross-platform two-device Talk (single message, both directions) | Android re-onboarded for MRS-12; one-direction enrichment proven | once-per-release |

## Sign-off

Ship. The nine features + Tier 1 + the per-listing vault pin are live-verified on
`563a9fd1` with the prod relay deployed; agent/services/Talk/approvals all pass the real
signed/relayed paths; durability + fresh install + log hygiene + guided-demo cleanup all
hold. The single ⚠️ is a polluted test-bed for the bus42 transit demo (services proven via
salon), with a noted minor product follow-up (router failover) and CLI/Maestro polish
items — none release-blocking.
