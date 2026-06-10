# Services Visibility — Live Multi-Device Test Report

**Date:** 2026-06-10 (12:00–13:05 IST) · **Tester:** Claude (automated, live stack)
**Scope:** the three supported service visibility modes — **public**, **unlisted (link-only)**, **known_only (private/grant-gated)** — tested end-to-end as real users on real devices against the deployed test infrastructure. No mocks, no loopbacks.

## Test bed

| Role | Identity | Where |
|---|---|---|
| User A "Alonso" (rider) | `did:plc:x74nte2zoqnepyvd7kmyvp3p` | iOS sim (iPhone 17 Pro), full Home Node app |
| User B (fresh stranger) | freshly onboarded did:plc | Android emulator (Pixel 10), onboarded during the test |
| Provider "Bus Depot 42" | `did:plc:sluk5vdtwgfmu2ad24pluqnx` (`bus42etalive.test-pds…`) | lite Core :18298 + paired `dina-agent` daemon + `stub_eta_runner` |
| Stranger Dina (harness) | `did:plc:kbxmn2j3sffchi6uf7xwwle3` | throwaway lite Core :18302 (control probes) |
| Infra | test-pds, test-appview, test-mailbox (MsgBox) | deployed cloud |

Provider listings under one DID (multi-listing, per-rkey):
`self` → **public** eta_query · `unlisted-demo` → **unlisted** eta_query (different schema than `self`: `stop_id` vs `location`) · `known-demo` → **known_only** eta_query.

---

## Verdict summary

| # | Scenario | Result |
|---|---|---|
| 1 | **Public** — iOS generic ask → external provider answers | ✅ **PASS** (full live round trip) |
| 2a | **Unlisted** — hidden from search, resolvable by exact link (AppView layer) | ✅ PASS |
| 2b | **Unlisted** — user pastes link in chat → invoke | ❌ **FAIL — P1 bug** (`schema_version_mismatch`) |
| 3a | **Known_only** — invisible on AppView (search + getByUri) | ✅ PASS |
| 3b | **Known_only** — granted contact invokes via offer | ✅ **PASS** (grant honored, ETA delivered) |
| 3c | **Known_only** — un-granted stranger rejected | ✅ PASS (silent drop; differential proven) |
| 4 | **Stranger on Android** — finds + uses public service | ⚠️ **BLOCKED by P1 ghost-listing bug** (see F-1) |

**Core security/privacy posture: all three visibility gates hold.** The failures found are reliability/marketplace-UX bugs, not authorization bugs.

---

## Scenario 1 — PUBLIC: "When does bus 42 reach Castro?" (iOS)

The rider previously had a leftover *own* transit listing that would shadow external routing — handled as a real user would: **My Services → paused "SF Transit Authority Live"** (`05_paused.png`). The unpublish propagated app → durable publish job → PDS delete → jetstream → AppView search within seconds (verified).

Then the ask. Full live chain observed:

```
iOS ask → intent → searchCapabilities → service.search (bus42 ranked 1st)
→ D2D service.query over MsgBox → provider ingress accepts (public)
→ workflow task svc-exec-0b4423… → daemon claims → stub_eta_runner
  params={'route_id':'42','location':{'lat':37.7626,'lng':-122.4352}}  ← real Castro geocode
→ service.response → ETA card resolves
```

**Result card** (`08_resolved.png`): *Route 42 · On route · **3 min to Castro Street (Mission)** · Open in Maps · via SF Transit Authority Live · did:plc:sluk5v…* — correct external attribution. **PASS.**

## Scenario 2 — UNLISTED: link-only

**AppView layer (PASS):** `service.search?capability=eta_query` excludes `unlisted-demo`; `getByUri` with the exact `at://` URI resolves it ("Hidden Link-Only ETA").

**User link-invoke (FAIL — F-2):** pasted into chat: *"A friend shared this private service link: at://…/unlisted-demo — using exactly that service, when does bus 42 reach Castro?"*
Result (`11b_state.png`): red error card **"SF Transit Authority Live: couldn't reach — `schema_version_mismatch`"**.

Root cause (definitive): `query_service`'s schema/name hydration probe uses the **public search lane only** (`searchServices`), which cannot see unlisted listings. It hydrated the schema hash + display name from the public sibling `self` listing; the D2D query correctly routed to `unlisted-demo` (whose schema differs: `stop_id` vs `location`), and the provider correctly rejected the stale hash. Two visible defects from one root: the invoke fails whenever an unlisted listing's schema differs from a public sibling, and the error card displays the *wrong listing's name*.

**Fix direction (not applied):** when the caller supplies an explicit `service_uri`, hydrate via `getByUri` — exactly the way the known_only **offer** already carries its own `service_uri + schema_hash` (which is why Scenario 3b passed).

## Scenario 3 — KNOWN_ONLY: grant-gated

Setup as real users: provider added "Alonso Rider" as a verified contact; Alonso added "Bus Depot 42" by DID through the app (`15_contact_saved.png`); provider issued `POST /v1/service/offer` → `grant-37b6e03a…` delivered as a D2D `service.offer` over MsgBox.

- **Invisible publicly (PASS):** `known-demo` is absent from search AND `getByUri` returns null — the provider core actively logged *"service profile unpublished from PDS"* on the known_only PUT. Off-AppView by construction.
- **Granted contact (PASS):** iOS ask *"Ask Bus Depot 42 when bus 42 will reach stop 5511"* → offer surfaced through `find_preferred_provider` (carrying grant_id + service_uri + schema_hash) → provider ingress authorized the grant → task `svc-exec-7455…` executed → card: *Route 42 · **13 min to your stop*** (`18_known_resolved.png`).
- **Un-granted stranger (PASS, clean differential):** the same Stranger Dina sent two queries with identical capability/params, differing only in target listing:
  - → `self` (public): **accepted + executed** (`success`, ETA text returned) — strangers can use public services, as designed.
  - → `known-demo` (no grant): **never reached the service runtime; requester saw `failed/expired`** after TTL. Silent drop — the listing "doesn't exist" for non-grantees. Privacy-preserving; arguably ideal. (Observation: requester UX is a bare timeout; consider whether an explicit-but-unrevealing error is wanted.)

## Scenario 4 — Fresh stranger on Android (real second device)

Onboarded a brand-new user on the Android emulator live (full flow: handle pick via suggestion, passphrase, recovery-skip, AI auto-connect, PDS provision — `and_03_onboarded.png`). Zero contacts, zero offers, zero listings: the purest "anyone on the network" perspective.

**Ask: "When does bus 42 reach Castro?"** → **"No response from SF Transit Authority Live — Try again in a moment."** (`and_05_state.png`). Retry: the Service Handoff card (`and_07_retry2.png`) shows the routing picked **`did:plc:x74nte…` — the iOS user's PAUSED listing**. Which exposed the headline bug:

### F-1 (P1) · AppView **ghost listing** — paused/deleted listing resurrected in the index
- At 12:23 the pause verifiably removed the listing from `service.search` (checked).
- By 13:01 the same listing was **back at rank 1** in `service.search` AND served by `getByUri` — while the PDS returns **`RecordNotFound`** for it. The index resurrected (or re-served) a record whose source of truth is deleted.
- Consequence chain, observed exactly as a real user: stranger's query routes to the ghost (recency ranking even favors it) → the target Dina no longer offers the service → timeout → dead end.
- Suspects (unverified): jetstream cursor replay re-ingesting the old create; a scorer/refresh job re-upserting from a secondary store; delete-event ordering in the ingester. Needs an AppView-side investigation with the ingester logs for `did:plc:x74nte…` between 12:20–13:05.

### F-3 (P2) · No provider failover, and same-name listings amplify it
Five providers publish eta_query, four share the literal name "SF Transit Authority Live" (test leftovers — but name squatting is a real-world certainty). When the chosen provider doesn't respond, the brain does **not** fall back to the next candidate; "Try again" re-picks the same one. One dead/ghost provider can black-hole a capability for a region.

### Positive note
The **Service Handoff card** UX on Android is excellent evidence design: "Asked the Dina service directory ✓ → Found <name> (did) ✓ → Sent your query to their Dina ✓ → Waiting… · *Private. Only your two Dinas see this*" — exactly the right transparency for a trust product.

---

## All findings

| ID | Sev | Finding | Layer |
|---|---|---|---|
| F-1 | **P1** | AppView serves **ghost listings** deleted from the PDS (resurrected after pause→unpublish); breaks public discovery by routing users to dead targets | AppView ingester/index |
| F-2 | **P1** | Unlisted link-invoke fails with `schema_version_mismatch` — `query_service` hydrates schema/name from the public lane only; must use `getByUri` for explicit URIs | Brain (`service_tools`) |
| F-3 | P2 | No failover to next provider on timeout; ranking has no liveness signal; duplicate display names amplify | Brain routing / AppView ranking |
| F-4 | P2 | Deployed test-appview predates the taxonomy gate — `searchCapabilities` still intent-suggests subject-scoped caps (e.g. `appointment_status`); committed code fixes this, **needs infra redeploy** | Deployment |
| F-5 | P3 | Error card shows the wrong listing name on URI-targeted failures (same root as F-2) | Mobile UX |
| F-6 | obs | Un-granted known_only queries die by silent TTL expiry (good privacy; requester sees only a generic timeout — confirm this is the intended UX) | Design |
| F-7 | infra | Maestro XCTest segfaulted the app once (`XCTAutomationSupport`, crash report `Dina-2026-06-10-122055.ips`) — automation crash, not product; idb coordinate taps used as fallback | Test infra |

## Evidence files (this directory)

`02_listings.png` My Services (3 listings) · `05_paused.png` own listing paused · `08_resolved.png` **public ETA card (3 min, Castro St)** · `11b_state.png` **unlisted schema_version_mismatch** · `15_contact_saved.png` Bus Depot 42 contact · `18_known_resolved.png` **known_only granted ETA (13 min)** · `and_03_onboarded.png` Android fresh onboard · `and_05_state.png` **"No response" dead-end** · `and_07_retry2.png` **Service Handoff card picking the ghost listing**

Logs preserved: `/tmp/bus42_core.log`, `/tmp/bus42_daemon.log`, `/tmp/stranger_core.log`.

## State after the test (cleanup)

- iOS transit listing **unpaused/restored** (also re-syncs the AppView ghost into consistency); "Bus Depot 42" contact kept (genuine).
- Provider :18298 + ETA daemon left running (as found), now with fresh brain/admin keys in `/tmp/dina-cic-service-key-dir` (old ones were lost to a /tmp wipe — re-provisioned during setup). `known-demo` + grant for Alonso remain.
- Stranger Core :18302 stopped; Android left onboarded; temp harness scripts removed.

**No product code was changed by this test.** Findings F-1/F-2 are report-only, per instruction.

---

## Addendum (same day, 14:00–14:45): F-1 + F-2 FIXED, deployed, re-verified live

**F-1 root cause (from deployed ingester logs):** the Jetstream cursor only advanced every
`CURSOR_SAVE_INTERVAL = 100` events. The quiet test firehose never reached that count, so the
in-memory cursor stayed at its boot value — and every idle-timeout reconnect (~5–10 min)
**replayed the entire window since boot**. Replayed create/delete pairs raced through the
concurrent ingestion queue, resurrecting the deleted listing every cycle (the exact 600s
"Record processed" bursts in the logs, ghost's `lastSeen` refreshed each time → rank 1).
**Fix (`appview/src/ingester/jetstream-consumer.ts`):** (1) 30s time-based cursor advancement
for quiet streams, (2) `reconnectWithBackoff` advances the cursor to the safe queue position
*before* resubscribing, (3) cursor never regresses. 4 new unit tests; existing
save-interval contract preserved.

**F-2 root cause (sharper than the original finding):** the unlisted resolve-by-URI branch
*already existed* — but caller-supplied args win over hydration, and the LLM had mixed sources:
service_uri from the pasted link + schema_hash/name from the PUBLIC sibling in search results.
**Fix (`packages/brain/src/reasoning/service_tools.ts`):** when an explicit `service_uri`
resolves to a listing, that LISTING is authoritative for schema hash + display name (override
logged). The known_only offer path (resolve → null) keeps the offer's own hash — pinned by test.

**Deployed** via `deploy_shared_infra.sh update test` (drizzle migrations idempotent, health
checks green), provider Cores + daemons restarted per the MsgBox-bounce runbook.

**Live re-verification:**
- **F-4 ✅** `searchCapabilities` no longer intent-suggests `appointment_status` — taxonomy gate live.
- **F-2 ✅** Same pasted-link ask now resolves: *Route 42 · 12 min to your stop ·
  via **Hidden Link-Only ETA*** (`fix_07_unlisted_result.png`) — correct listing, schema, and name.
- **F-1 ✅** Re-ran the pause experiment (paused 14:23:22, search cleared 14:23:51). The 14:28:23
  idle reconnect re-delivered exactly ONE boundary event (the delete, idempotent) — **no window
  replay, no resurrection**, confirmed absent through a 12-minute multi-cycle soak (old bug
  resurrected within 1–4 cycles).

**Casualty note:** the price/drcarl provider (:18299) could not rejoin after the restart — its
vault directory no longer existed on disk (the old process had been running on state whose dir
was removed earlier; identity seed unrecoverable). Fresh boot refused did:plc fallback (401).
Peripheral to this test; the `drcarlclinic` PDS account would need re-provisioning to revive it.

**Still open:** F-3 (no provider failover / liveness-blind ranking) and the four stale same-name
eta providers polluting test search results.
