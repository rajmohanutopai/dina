# Home Node Lite — container footprint

Measurement methodology for the pre-M1 Docker images. Keeps drift
visible across Phase 7 tuning + the M4 perf-hardening work
(`docs/HOME_NODE_LITE_TASKS.md` Phase 11a).

## Measurement protocol

1. Build images: `docker build -f apps/home-node-lite/docker/Dockerfile.core -t dina-lite-core:dev .` (and `brain`).
2. Bring stack up with default compose env.
3. Wait 10s post-boot → snapshot.
4. Wait 40s total post-boot (30s idle) → snapshot.
5. Issue 50 `GET /healthz` requests to each service, back-to-back → snapshot.
6. `docker stats --no-stream --format '…'` on both containers.

All measurements: macOS host, Docker Desktop 29.2.1, `node:22-alpine`
base, built locally (no ghcr pull). Runner container limits
unrestricted. Single-run, not averaged — re-take for any regression
investigation.

## Baseline (2026-04-22, pre-M1)

| Container       | Image size | Boot RAM     | Idle (40s)   | Under load (50 probes each) | CPU idle |
|-----------------|------------|--------------|--------------|------------------------------|----------|
| `dina-core-lite`  | **362 MB** | 95.25 MiB    | 95.89 MiB    | 97.61 MiB                    | ≤ 0.3 %  |
| `dina-brain-lite` | **359 MB** | 70.47 MiB    | 73.48 MiB    | 74.87 MiB                    | ≤ 0.3 %  |
| **Combined**      | **721 MB** | **166 MiB**  | **170 MiB**  | **172 MiB**                  | —        |

## Interpretation

**Memory.** 170 MiB combined at idle is well under task 11.1's
`<250 MB Core+Brain, x86_64` target. The numbers will grow when the
M1 Brain routes wire LLM providers (persistent sockets + provider
client instantiation add 20–40 MB typically), but the current
headroom is comfortable.

**Image size.** 362 MB core + 359 MB brain is larger than the Go/
Python baseline (192 MB core, 579 MB brain in the production stack)
because both Lite images ship the full `node_modules` workspace
including `tsx` + dev dependencies. This is the tradeoff the
Dockerfile's M1+ optimisation TODO calls out: once the monorepo
gets a composite `tsc --build` graph emitting per-package `dist/`,
`npm prune --omit=dev` at the build-stage drops ~100 MB per image.

**CPU.** Both services idle under 0.3%. Healthz-probe flood doesn't
move the needle; Fastify + `wget --spider` is cheap.

## Trends to watch

- **Image size drift.** A 50 MB jump in either image likely indicates
  a new native module pulled in via storage-node or crypto-node.
  Investigate with `docker history` on the image.
- **Boot RAM drift.** A 30+ MB jump suggests an unconstrained cache
  or a leaky provider client instantiated at boot. Pprof via
  `--inspect=0.0.0.0:9229` + Chrome DevTools memory snapshot.
- **Idle RAM over 40s.** Should be stable ±5 MiB. Growth = leak.
  Likely suspects: unconstrained pino buffer, timer churn in the
  notify bridge, WebSocket reconnect state.

## Re-measuring

The formal benchmark lives at:

```
apps/home-node-lite/docker/security-checks/benchmark.sh
```

Covers task 11.1 (memory idle < 250 MB) and task 11.2 (cold-start <
3s). Pass/fail exit code so CI can gate on it.

```bash
# Defaults — 30 s idle before RSS sample; 250 MB memory budget;
# 3000 ms cold-start budget per service.
./apps/home-node-lite/docker/security-checks/benchmark.sh

# Relax for slow CI arches
DINA_BENCH_COLDSTART_BUDGET_MS=6000 \
DINA_BENCH_MEMORY_BUDGET_MB=400 \
./apps/home-node-lite/docker/security-checks/benchmark.sh

# Machine-readable output for CI dashboards
DINA_BENCH_JSON=/tmp/bench.json \
./apps/home-node-lite/docker/security-checks/benchmark.sh
```

### Measured against both budgets (2026-04-22, 10 s idle)

| Metric                                  | Target   | Measured      | Margin |
|-----------------------------------------|----------|---------------|--------|
| Core cold-start (boot → /healthz 200)   | < 3000 ms | **1132 ms**  | 2.6 × |
| Brain cold-start                        | < 3000 ms | **570 ms**   | 5.3 × |
| Core + Brain idle RSS                   | < 250 MB | **167.71 MiB**| 1.5 × |

Both budgets pass with comfortable headroom. Run the benchmark on
every Docker image change so regressions surface in the PR + the
margin doesn't silently shrink as the LLM-routing + MsgBox-client +
auth-middleware subsystems land in M1–M5.

## Raspberry Pi 5 8GB acceptance (Phase 11d, tasks 11.17–11.20)

The Pi 5 is Dina's lowest-spec supported hardware class. Every x86_64
budget above relaxes for ARM; the relaxed budgets are per-task below.
Each task's "How to run" gives the exact command for a Pi 5 shell
session — the scripts already exist and work on any platform; Pi
scope is about running them on real Pi hardware with the relaxed
budgets set via env.

| Task  | What                         | x86_64 budget | **Pi 5 budget**   | How to run |
|-------|------------------------------|---------------|-------------------|------------|
| 11.17 | First-boot wall-clock (cold-start → /healthz 200) | < 3000 ms | **< 10000 ms** | `./apps/home-node-lite/docker/security-checks/pi5-smoke.sh` |
| 11.18 | Combined Core+Brain idle RSS | < 250 MB      | **< 400 MB**      | same script (11.17 + 11.18 bundled) |
| 11.19 | FTS5 p95 / HNSW p95 at 10K items | FTS5 < 50 ms, HNSW < 100 ms | **FTS5 < 200 ms, HNSW < 400 ms** | see §*11.19 — FTS/HNSW on Pi* below |
| 11.20 | 24h stability — no memory growth > 20% | same budget     | **same budget**     | see §*11.20 — 24h stability on Pi* below |

The Pi gates are looser on absolute numbers (11.17/11.18/11.19) but
**identical on growth-rate invariants** (11.20 — a memory leak is a
leak regardless of arch). Numbers below the Pi budgets but above the
x86_64 ones are acceptable for M5 ship; numbers above the Pi budgets
block the Pi-class release claim.

### 11.19 — FTS/HNSW on Pi

The Jest perf smokes in `@dina/storage-node` + `@dina/core` already
honour env-var budget overrides. Run on a Pi 5 shell:

```bash
cd /path/to/dina
PERF_P95_MS=200 \
HNSW_P95_MS=400 \
HNSW_ROW_COUNT=10000 \
  npm test --workspaces --if-present -- \
  --testPathPatterns "perf_smoke|hnsw_perf_smoke"
```

The env knobs (already existing, documented in each probe file's
header):
- `PERF_P95_MS` — FTS5 budget in ms (default 50, Pi 200)
- `HNSW_P95_MS` — HNSW budget in ms (default 100, Pi 400)
- `HNSW_ROW_COUNT` — corpus size (default 10000, keep at 10k for the
  task-11.19 gate)
- `PERF_SMOKE=0` / `HNSW_PERF_SMOKE=0` — opt-out per probe (don't set
  for the Pi acceptance run; opt-outs are for constrained CI, not
  hardware validation)

Expected output: the `[perf_smoke]` + `[hnsw_perf]` summary lines
report `p50`, `p95`, `p99` + the budget. Record both p95 values in
the post-soak report (task 11.4 pair / milestone v1.0.0 gate).

### 11.20 — 24h stability on Pi

`soak-runner.sh` (task 11.7, iter 58) is platform-agnostic — runs on
Pi unchanged. On a Pi 5 shell:

```bash
cd /path/to/dina
DINA_SOAK_MEMORY_GROWTH_CEILING=20 \
  ./apps/home-node-lite/docker/security-checks/soak-runner.sh
```

The three gates (memory growth ≤ 20%, no unhandled rejections,
throughput-probe PASS) apply identically on Pi — the invariant is
"no regression over 24h," which doesn't change with architecture.
Only the *initial* RSS baseline shifts with ARM's slightly larger
base; the *growth percentage* is arch-neutral.

**Pi-specific run notes:**

- Use NVMe or at minimum a UHS-I A2 SD card; slower storage makes
  the 24h WAL-reclamation and file I/O under load meaningfully
  different from x86_64 SSD and can mask real issues.
- Run under Raspberry Pi OS 64-bit (aarch64). The probes assume
  64-bit; `uname -m` should report `aarch64`.
- Keep thermals in the green — a throttled Pi changes the numbers
  and invalidates the run. `vcgencmd measure_temp` should stay
  below 70 °C for the full 24h.
- The soak produces a `memory.tsv` + throughput log under
  `/tmp/dina-soak-<date>/`. Both go into the task 11.4 post-soak
  report.

## See also

- Dockerfile TODOs: `apps/home-node-lite/docker/Dockerfile.core`
  + `Dockerfile.brain` (M1+ optimisation block at top)
- Phase 11a benchmark targets:
  `docs/HOME_NODE_LITE_TASKS.md` — 11.1 (memory idle), 11.3
  (throughput 50 req/s), 11.6 (end-to-end latency)
- Go/Python production footprint for comparison:
  `docker stats dina-core dina-brain` against an `./install.sh`
  install.
