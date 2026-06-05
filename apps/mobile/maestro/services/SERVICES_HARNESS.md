# MRS-10 / MRS-11 — Services provider harness

The services scenarios are the only MRS checks that need a **second, full
Dina** (the provider) plus the cloud test infra. The app-side assertion is
automated (`bus_eta.yaml` → `chat-card-service-response`); the **provider
side is a multi-process harness** built from the validated demo scripts in
`demo/dina-services-demo/`. This file is the runbook the master runner
(`run_mrs.sh` Phase 5) points at when no provider is live on `:18298`.

## What a provider is

1. A **provider lite-Core** (`apps/home-node-lite/core-server`) on `:18298`,
   booted in `test` endpoint mode against the cloud test infra
   (`test-pds`, `test-appview`, `wss://test-mailbox.dinakernel.com/ws`), with
   its identity provisioned and its brain service key written where
   `put_service_config.ts` expects it (`/tmp/dina-cic-service-key-dir`).
2. A **published `eta_query` listing** on the test-AppView, written with
   `put_service_config.ts` (so the requester's Dina can DISCOVER it).
3. A **paired `eta-agent`** (already paired — `demo/dina-services-demo/eta-agent/.dina/`)
   running the **stub_eta daemon** (`run_daemon.py`, which registers
   `stub_eta_runner` then enters the canonical `dina-agent` claim loop). It
   claims `service_query_execution` tasks and returns a canned ETA.

## Boot recipe

```bash
cd demo/dina-services-demo

# 1) Boot the provider lite-Core on :18298 (test mode, MsgBox on, PDS
#    provision). Mirror the env in apps/mobile/maestro/harness/
#    live_d2d_send_to_mobile.ts, but DINA_CORE_PORT=18298 and a provider
#    vault dir. Wait for /healthz + a provisioned DID.

# 2) Publish the eta_query listing to the test-AppView:
npx tsx put_service_config.ts          # writes ServiceConfig → publisher fires

# 3) Run the provider daemon (claims tasks, returns canned ETA):
#    config is read from eta-agent/.dina/cli (paired device).
DINA_CONFIG_DIR="$PWD/eta-agent/.dina/cli" STUB_ETA_DELAY_SECONDS=5 \
  python run_daemon.py
```

With the provider warm, run the app side:

```bash
# real discovery + D2D path (NOT the in-app demo loopback)
EXPO_PUBLIC_DINA_DEMO="" maestro test apps/mobile/maestro/services/bus_eta.yaml
# or, from the runner:
PROVIDER_CORE_URL=http://127.0.0.1:18298 apps/mobile/maestro/run_mrs.sh --only services
```

## MRS-11 — known_only authorization (harness-side)

The positive **app-side** invocation of a `known_only` service is **not
built** on mobile (per `project_service_visibility_model`). What's automated
is the authorization invariant, asserted harness-side: a `known_only`
listing (`put_service_config_unlisted.ts` / the known_only variant) is
**absent from public AppView search**, and a cross-DID caller that isn't on
the grant's `allowed_did` list is **rejected**. The app-side positive invoke
stays a manual/N-A check.

## Why this isn't a one-command gate

The provider boot depends on cloud infra timing (AppView ingestion lag before
a fresh listing is discoverable, MsgBox WS warm-up) and a one-time paired
eta-agent. It was validated live on the sim **2026-05-25** via these scripts.
The runner treats it as a conditional phase: if a provider answers on
`:18298` it runs `bus_eta.yaml`; otherwise it SKIPs with a pointer here, so
the rest of the suite never blocks on it.
