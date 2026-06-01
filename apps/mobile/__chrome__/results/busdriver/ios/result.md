# Scenario: Services / Bus-driver (§3.9, MT-24) — iOS driver (`idb`)

**Date:** 2026-05-25 · iPhone 17 Pro sim · `com.dinakernel.mobile` (Alonso) ·
directory = test-appview.dinakernel.com · relay = test-mailbox.dinakernel.com.

## Result: PASS — full proper path, no in-boundary demo hooks

Stood up the real provider stack (see `docs/BUSDRIVER_SERVICES_SCENARIO.md`
for the full guide + rebuild recipe), then asked from Alonso on the sim.

**Provider stack (rebuilt — the original was wiped when /tmp cleared on reboot):**
- Provider lite Core `did:plc:6zyy3bu2njkhdjbosxdqrzri` ("Demo ETA Provider"),
  on :18298, MsgBox-connected, `eta_query` published to test-appview.
- dina-services-demo `dina-agent` daemon paired via MsgBox, running `stub_eta_runner`
  (the edge OpenClaw stand-in — `eta_minutes = random.randint(2,14)`,
  reverse-geocodes the location to a real stop).

**Asked:** *"When does bus 42 reach Castro?"*

| Step | Evidence | Pass |
|---|---|---|
| vault miss → service intent | classified `eta_query` | ✅ |
| directory discovery | handoff card: "Found Demo ETA Provider — did:plc:6zyy3b…" (the **live** node; the stale `6sk7wch` was correctly bypassed) | ✅ |
| D2D dispatch | "Sent your query to their Dina — route 42" (via MsgBox) | ✅ |
| provider claim | daemon: `Claimed svc-exec-18e80d41 — eta_query`, params `{route_id:42, location:{37.7626,-122.4351}}` | ✅ |
| edge execution | `stub_eta_runner` → 11 min, reverse-geocode → "Jane Warner Plaza (Mission)" | ✅ |
| service.response | Core: `sendEnvelope OK type=rpc ... delivered=true` | ✅ |
| **ETA card in chat** | **"🚌 Route 42 — 11 min to Jane Warner Plaza (Mission)" + "Open in Maps" + "via Demo ETA Provider · did:plc:6zyy3b…"** | ✅ |

This is the MT-24 pipeline end-to-end with production code on every hop inside
the system boundary (discovery → sign → MsgBox relay → delegation task →
agent claim → response bridge). The only out-of-boundary piece is
`stub_eta_runner` standing in for OpenClaw + a real transit API.

## Artefacts
`11_asked_live.png` (question) · `12_handoff.png` (handoff card: found live
provider 6zyy3b → dispatch) · `13_eta_card.png` (**the answer card**).
Earlier `01–06` capture the pre-rebuild requester-only run (timed out cleanly
against the offline provider).

## Note — the variable ETA script
`stub_eta_runner.py:163` = `random.randint(2,14)` (the "random 2–12" memory).
A second, schedule-based transit tool (`demo/transit/server.py`, 0–12 min from
real SF stops incl. Castro) is what a full OpenClaw provider would run instead;
19/19 of its tests pass.
