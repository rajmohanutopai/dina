# How to try Home Node Lite

A walkthrough from a clean checkout to your first request — about 10
minutes. No Docker required for the dev-mode path; Docker lands in
Phase 7 for the production install.

> **Status:** pre-M1. The pieces here run end-to-end, but the Brain
> server's route surface (`/api/v1/ask`, `/reason`, `/process`) is
> still mid-buildout (Phase 5c). This doc walks you through what
> *currently* works, then points at the seams where the Phase 5
> tasks will plug in.

## Prerequisites

- **Node ≥ 22.** The repo pins a floor version in `.nvmrc`;
  `nvm use` handles it for nvm users.
- **macOS (arm64 or x64) or Linux (x64, arm64).** The SQLCipher
  native module ships prebuilt binaries for these four targets, so
  you don't need a C compiler. See
  `packages/storage-node/README.md` for the full matrix.
- **Git.** The repo is at
  [`rajmohan/dina`](https://github.com/rajmohan/dina).

You do **not** need Python, Go, or Docker for the Lite dev path.
The production Go/Python stack sits in the same repo but the Lite
dev workflow below touches none of it.

## Step 1 — Clone and install

```bash
git clone https://github.com/rajmohan/dina.git
cd dina
npm install
```

First-run install fetches the SQLCipher prebuild
(`better-sqlite3-multiple-ciphers`) and the shared workspace
packages. Subsequent installs reuse the cache.

If this finishes without an "npm audit" warning about high or
critical vulnerabilities, the core hardening gate (task 11.13) is
green. You can re-check any time with:

```bash
npm run audit:prod
```

## Step 2 — Run the test suite

Before running either server, prove the workspace is healthy:

```bash
npm test
```

Green means 600+ suites and 12 000+ tests pass — the shared
packages (`@dina/core`, `@dina/brain`, `@dina/storage-node`,
`@dina/protocol`, the test harness, the mobile app) are all
exercised.

Typecheck across the workspace:

```bash
npm run typecheck
```

## Step 3 — Start the Core server

Core requires a vault directory — the folder where identity.sqlite
and the per-persona files will live. You have to set it explicitly;
there's no home-directory default, so Core fails loud at boot if
you forget.

In one terminal:

```bash
cd apps/home-node-lite/core-server
mkdir -p /tmp/dina-dev-vault
DINA_VAULT_DIR=/tmp/dina-dev-vault npm start
```

You should see a line like:

```
{"level":"info","time":"2026-04-22T10:30:01.234Z","msg":"core-server listening","boundAddress":"http://127.0.0.1:8100"}
```

In another terminal, probe the health endpoint:

```bash
curl http://127.0.0.1:8100/healthz
# {"status":"ok","version":"0.0.1"}
```

Core is now running and ready to accept Brain's signed requests.
It will create `/tmp/dina-dev-vault/identity.sqlite` on first boot
with your master seed wrapped under the Argon2id-derived KEK
(see [`docs/security-walkthrough.md`](security-walkthrough.md) for
the key-derivation story). For a persistent dev profile you
probably want `DINA_VAULT_DIR=$HOME/.dina-dev-vault` or similar —
`/tmp` is fine for a quick try but gets cleared on reboot.

Leave the Core terminal open — Brain needs it running.

## Step 4 — Start the Brain server

In a third terminal:

```bash
cd apps/home-node-lite/brain-server
npm start
```

```
{"level":"info","time":"2026-04-22T10:30:10.123Z","msg":"brain-server listening","boundAddress":"http://127.0.0.1:8200"}
```

Probe:

```bash
curl http://127.0.0.1:8200/healthz
# {"status":"ok","role":"brain"}
```

Brain is up on port 8200 and paired with Core on port 8100.

## Step 5 — What currently works end-to-end

The two servers can:

- Respond to health probes.
- Load + validate env-driven config (`DINA_CORE_*`, `DINA_BRAIN_*`).
- Open an encrypted SQLCipher file via `@dina/storage-node` for
  identity + per-persona vaults — 119 tests validating open/close,
  pragma application, CRUD, FTS5, blobs, transactions, persona
  multiplexing, migrations, concurrency, and perf (Phase 3a —
  only cross-package integration under task 3.17 still open).
- Derive persona DEKs via HKDF from the master seed (validated by
  `@dina/crypto-node`'s 114 tests).

The two servers can't *yet*:

- Accept an `/api/v1/ask` request that runs through an LLM and
  returns a reasoned answer. The route surface lands in Phase 5c.
- Pair a device. Pairing lives in Phase 4h and needs the MsgBox
  relay wired up in Phase 4f.
- Publish to AT Protocol. Trust publishing is in Phase 6 (mostly
  done at the library level; Brain wiring lands in Phase 5e).

This is the pre-M1 state. Milestone M1 ("pair + ask + remember +
D2D delivery") lights every one of those paths up end-to-end. The
task plan is at
[`docs/HOME_NODE_LITE_TASKS.md`](HOME_NODE_LITE_TASKS.md).

## Step 6 — Exercise the primitives directly

If you want to see the storage layer work while the server API
fills in, try the `@dina/storage-node` suite:

```bash
cd packages/storage-node
npm test
```

You'll see the adapter open an encrypted DB, verify SQLCipher-v4
compatibility, round-trip Uint8Array blobs, run FTS5 with the
`unicode61 remove_diacritics 1` tokenizer, simulate multi-writer
contention, and finish with a perf smoke that usually reports
**p95 under 1 ms** against a 10 000-row corpus. Budget is 50 ms;
you'll have 70× headroom.

## Step 7 — What to do if something goes wrong

- **`npm install` fails fetching a prebuild**: check your Node
  version (`node --version` — must be ≥ 22) and your architecture
  (`uname -ms`). If you're on `linux-arm` (32-bit Pi) that's also
  supported by `node-llama-cpp` but not by `better-sqlite3-multiple-ciphers`
  — the Lite Home Node currently requires 64-bit.
- **`npm start` says "port already in use"**: another process has
  8100 or 8200. Override via env:

  ```bash
  DINA_BRAIN_PORT=18200 npm start
  ```

- **Core emits `[config_error]`**: the process exits with
  status 78 (`EX_CONFIG`). The log will tell you which env var
  failed validation. See `apps/home-node-lite/core-server/src/config.ts`
  for the full schema.
- **Tests fail with "cannot find module '@dina/core'"**: re-run
  `npm install` at the repo root — workspace linking is managed by
  npm, and partial clones don't have the symlinks in place yet.

## Step 8 — Where to go next

If you want to keep going:

- **Read the architecture**:
  [`ARCHITECTURE.md`](../ARCHITECTURE.md) → *Architectural Decision:
  Two-Stack Implementation* covers why Lite exists next to the
  Go/Python production stack.
- **Read the security model**:
  [`docs/security-walkthrough.md`](security-walkthrough.md) →
  *The Core / Brain Boundary* explains how the security boundary
  shifts between server and mobile.
- **Follow the task plan**:
  [`docs/HOME_NODE_LITE_TASKS.md`](HOME_NODE_LITE_TASKS.md) lists
  every checkbox from scaffolding through M5 parity.
- **Lite-specific quickstart**:
  [`apps/home-node-lite/README.md`](../apps/home-node-lite/README.md)
  has the layout diagram and the port convention.

## Step 9 — Shut down cleanly

`Ctrl-C` in both terminals. Both servers register SIGINT/SIGTERM
handlers and will close Fastify + flush the DB cleanly. You can
verify the clean-close semantics via the concurrent-access tests
(`packages/storage-node/__tests__/concurrent_access.test.ts` — look
for "close with outstanding transaction rolls back + clears state").

No explicit `dina uninstall` yet — delete whichever directory you
set `DINA_VAULT_DIR` to (e.g. `rm -rf /tmp/dina-dev-vault`) to
reset the dev profile. Nothing else touches your filesystem.
