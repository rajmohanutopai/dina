# New-provider ingest latency — instrumentation & measurement plan

**Problem.** On the **test** stack, a record (PeerLens review / service profile)
authored by a **brand-new `did:plc`** takes **~30 min** to become visible via the
AppView's discovery/resolve xRPC. Records from an **already-established** `did:plc`
appear in **seconds**. Find where the delay is; decide if it's a code bug (affects
prod) or a test-env timing artifact.

## Topology (confirmed)

```
lite Core ──createAccount/putRecord──▶ test-pds.dinakernel.com (shared PDS)
                                            │ firehose (repo commits)
                                            ▼
                                        relay / BGS
                                            │
                                            ▼  JETSTREAM_URL (env-set; internal in test deploy)
                                     AppView ingester (jetstream-consumer.ts) ── forward cursor, no repo discovery
                                            │ validate / gate / persist
                                            ▼
                                        Postgres ◀── xRPC resolve/search reads (SWR-cached)
```

Both test providers are on the **same PDS** (`bus42demo.…` fast, `drcarlclinic.…`
slow — both `@ test-pds.dinakernel.com`). So "relay hasn't crawled the PDS" is
**falsified**: the relay already streams `test-pds` (bus42 proves it). A new account
emits on that same already-subscribed firehose.

## Falsified so far (don't re-propose)

1. ~~AppView indexing is slow~~ — it's a forward-cursor Jetstream consumer with spool
   replay; no repo scan. (`appview/src/ingester/jetstream-consumer.ts`)
2. ~~`requestCrawl` missing → relay never crawls the repo~~ — same PDS, already
   crawled; `requestCrawl` would be a **no-op for this case**. (Not implemented, on
   purpose.)

## Empirical findings (measured 2026-05-30, this session)

These narrow the field a lot — several earlier hypotheses are now **dead**:

1. **PLC directory is the REAL public `https://plc.directory`** (test mode uses it;
   only PDS/AppView/MsgBox are env-prefixed — `packages/home-node/src/endpoints.ts:52`).
   The new Dr Carl `did:plc` **resolved at `plc.directory` at the exact second of account
   creation** (`/log/audit` → 1 entry, `createdAt 2026-05-30T06:24:28Z`, matching the Core
   boot log). ⇒ **H1 (PLC propagation lag) is FALSIFIED.** PLC had the DID immediately.

2. **The original "~30 min" was largely measurement error / self-inflicted (H3).** That
   window was spent on *failed publish attempts* — wrong brain-key path, daemon
   `No keypair found`, re-pairing to the wrong config dir — not on ingest. The profile only
   became publishable once `put_service_config_drcarl.ts` finally ran correctly. So the
   "new repo = 30 min" framing conflated my botched setup with real latency.

3. **Commit→visible on an established repo is ~SECONDS, measured.** Controlled test:
   patched Dr Carl's profile `description` with a unique marker, PUT it, and polled
   `service.search` every 4 s with a **correctly-matched** marker string →
   **VISIBLE_AFTER_7s (poll #2).** An earlier "absent after 6 min" reading was a **bug in my
   poller** (it grepped for `probe-141945` while the published marker was `probe-142615` —
   the served description already carried the new marker the whole time). The instrumentation
   caught my own measurement error.

4. **The profile-update path has no dedupe/cache that could hide an update.**
   `service-profile.ts:96-153` is a `delete-by-operatorDid` + `insert` in one transaction —
   no CID-skip, no ON CONFLICT, no in-process cache; `service-search.ts` reads the table
   directly (no `withSWR`). ⇒ **H5 (update-skip / search staleness) FALSIFIED.**

**Conclusion: there is no real 30-minute ingest latency.** The number was an artifact of
(a) a botched provider setup that delayed the *first successful PUT* by ~30 min, and (b) a
typo'd verification poll. Measured steady-state commit→discoverable is **~7 s**, and PLC had
the new DID **at creation**. The "new repo is mysteriously slow" framing does **not** hold up.

## Hypotheses — final status

- **H1 (PLC propagation)** — ❌ FALSIFIED. `plc.directory` (the real public PLC, used in both
  test & release) resolved the new did:plc at the second of `createAccount`.
- **H2 (relay/firehose new-repo cadence)** — ❌ not supported. 7 s commit→visible leaves no
  room for a minutes-scale relay delay on this stack. (A genuinely cold *new PDS host* on the
  real network is a separate question, untested, but irrelevant here — shared PDS.)
- **H3 (measurement error / setup failure)** — ✅ CONFIRMED as the dominant cause.
- **H5 (update-skip / cache)** — ❌ FALSIFIED by reading the handler + endpoint.

## What remains genuinely unknown (small)

- The **first-ever record** on a brand-new repo wasn't cleanly timed in isolation (the 30 min
  was contaminated by setup failures). If you want certainty, the harness below does it: spin
  ONE throwaway did:plc with the `watch` command running first, and read T0→T3. Expectation
  given the above: seconds.

> ⚠️ PLC URL for the harness is **`https://plc.directory`** (not `test-plc…`).

## Original hypotheses (pre-measurement, kept for the record)

- **H1 — PLC directory propagation.** A brand-new `did:plc` may not resolve at the
  test PLC directory for minutes after `createAccount`. The ingester's
  `namespace-signature-gate.ts` fetches the author DID-doc (PLC) and **fails closed**
  (`signature_invalid`) on fetch failure, with a 5-min did-doc cache TTL
  (`did-doc-cache.ts`). **Caveat:** records *without* a `namespace` **skip that gate**
  (gate docstring lines 46–49) — PeerLens reviews / service profiles are likely
  namespace-less, so verify whether ANY stage resolves the author DID before persist
  (`pds-suspension-gate.ts`, `did_profiles` population, `record-validator.ts`).
- **H2 — relay/BGS new-account handling.** The relay may process a newly-seen repo's
  first `#account`/`#identity` event (or backfill) on a slower cadence than
  steady-state commits. Upstream of the AppView; likely infra-config, not in this repo.
- **H3 — measurement error.** "~30 min" was wall-clock, not instrumented. Confirm.

## Measurement (do this BEFORE any fix)

### Harness: `bus42-agent/measure_ingest_latency.py` (stdlib only)

Times the reachable hops:
- **T0** caller "now" (or pass `--t0-epoch` = Core boot-log "PDS identity
  loaded/provisioned" unix ts)
- **T1** new did:plc resolves in PLC directory (`GET {plc}/{did}` → 200)
- **T3** AppView `service.search?capability=…` lists the did

```bash
# terminal 1 — start watching, THEN provision the node in terminal 2:
cd bus42-agent
python measure_ingest_latency.py watch \
  --did did:plc:NEWLYCREATED \
  --capability appointment_status \
  --plc-url https://<REAL-test-plc-host> \
  --appview-url https://test-appview.dinakernel.com
```

Reading it:
- **T0→T1 dominates** ⇒ PLC propagation (H1).
- **T0→T1 small, T1→T3 dominates** ⇒ downstream of PLC: relay/firehose (H2) or the
  ingester. Split T1→T3 with the firehose tap or the deployed ingester logs below.

> ⚠️ The real PLC-directory host is unknown — `test-plc.dinakernel.com` returned no
> response in testing. Read it off a running Core's `plcDirectoryUrl` config or its
> boot `plc_probe` log line. Without `--plc-url`, the harness still measures T0→T3.

## Deployed-side logging to ADD (takes effect on next test-appview deploy)

These are the per-record timestamps that split **T2 (firehose arrival) → T3
(persisted/visible)** and prove/disprove H1 at the gate. Additive structured logs
only — must not change behavior; keep ingester tests green.

### 1. `appview/src/ingester/jetstream-consumer.ts` — per-record arrival + outcome

In `handleEvent(event)` (the commit-handling branch), once the collection + author
DID are known, log on **entry** and **persisted**:

```ts
const tArrival = Date.now()
logger.info({
  ev: 'ingest.record.arrival',
  did: event.did,                 // author repo DID
  collection: commit.collection,  // e.g. com.dinakernel.peerlens.review
  rkey: commit.rkey,
  op: commit.operation,           // create/update/delete
  time_us: event.time_us,         // jetstream event time (relay clock)
  recvAtMs: tArrival,             // our wall clock at receipt
  lagFromEventMs: event.time_us ? tArrival - Math.round(event.time_us / 1000) : null,
}, 'ingest: record arrived from firehose')
// ... after successful persist:
logger.info({
  ev: 'ingest.record.persisted',
  did: event.did, collection: commit.collection, rkey: commit.rkey,
  processMs: Date.now() - tArrival,
}, 'ingest: record persisted')
```

`lagFromEventMs` is the **relay→AppView** delivery lag (T2 side). A new repo whose
FIRST event arrives 30 min after it was written shows a huge `lagFromEventMs` ⇒ the
lag is upstream (relay/firehose, H2), not the AppView. A near-zero `lagFromEventMs`
but a record that still isn't visible ⇒ it was rejected by a gate (see #2/#3).

### 2. `appview/src/ingester/namespace-signature-gate.ts` — DID-doc fetch timing

Wrap the `didResolver(did)` call with timing + outcome so a PLC-propagation stall is
visible (directly tests H1 for namespaced records):

```ts
const tFetch = Date.now()
let doc
try { doc = await ctx.didResolver(did) }
catch (e) {
  ctx.logger?.info({ ev: 'gate.diddoc.fetch_failed', did, ms: Date.now() - tFetch,
                     err: String(e) }, 'namespace gate: DID-doc fetch failed (fail-closed)')
  throw e
}
ctx.logger?.info({ ev: 'gate.diddoc.fetched', did, ms: Date.now() - tFetch,
                   cache: /* hit|miss if available */ undefined }, 'namespace gate: DID-doc resolved')
```

### 3. `appview/src/ingester/rejection-writer.ts` — make every rejection loud

Ensure each rejection logs `{ev:'ingest.record.rejected', did, collection, reason, detail}`
at `info` (not just DB write). If new-provider records are being **rejected** (e.g.
`signature_invalid` because PLC hadn't propagated, or a suspension-gate deferral),
this is where it shows — and explains a 0-rows-then-appears-30-min-later pattern as
"rejected on first pass, accepted once PLC caught up + cache expired (5 min)."

### 4. `appview/src/ingester/pds-suspension-gate.ts` + `did_profiles`

Check whether either resolves the author DID before persisting a review/profile, and
if so add the same fetch-timing log. This is the make-or-break for H1 on
**namespace-less** records (the likely PeerLens path).

## Firehose tap (optional, for the T1→T3 split without a redeploy)

If you can obtain the deployed `JETSTREAM_URL` (or a public test jetstream), a tiny
`websockets` subscriber (the `bus42-agent/venv` has the lib) that prints every event
for the target DID with arrival wall-clock gives **T2** directly:
`T1→T2` = relay/firehose lag (H2); `T2→T3` = AppView ingester lag. Without the URL,
the deployed logs (#1) provide the same arrival timestamp.

## Two questions for a parallel code reviewer (Codex)

1. In the ingester dispatch path, does **any** stage resolve the **author DID** (PLC
   fetch) or populate `did_profiles` **before** a PeerLens-review / service-profile row
   is persisted — and does it **defer / fail-closed** when the DID isn't yet in PLC or
   its 5-min cache? (Make-or-break for H1.)
2. Does the **relay/BGS** upstream of `JETSTREAM_URL` treat a **newly-seen repo** (new
   account on an already-crawled PDS) on a slower discovery/backfill path than
   steady-state commits? (H2; may be infra config, not this repo.)
