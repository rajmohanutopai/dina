# Home Node Lite — Docker security checks

Post-install verification scripts for the hardening measures declared
in `apps/home-node-lite/docker-compose.lite.yml`. Each script verifies
at **runtime** that the compose directive is actually in effect — not
just that it was written — catching the class of bug where a compose
edit drops a directive and nobody notices until a container escape.

Run the stack (`./apps/home-node-lite/install-lite.sh` or
`docker compose -f apps/home-node-lite/docker-compose.lite.yml up -d`),
then execute whichever scripts you need.

| Script                           | Task  | Verifies                                                  |
|----------------------------------|-------|-----------------------------------------------------------|
| `verify-key-isolation.sh`        | 11.11 | Brain's mount namespace cannot reach Core's key file      |
| `pen-test-key-paths.sh`          | 11.12 | PID-ns, /proc/environ, symlink, /dev/mem, /dev/net/tun, cap-inventory (also covers **11.14** cap_drop=ALL via `/proc/self/status` CapInh/Prm/Eff/Bnd/Amb = 0) |
| `verify-read-only-rootfs.sh`     | 11.15 | Root FS mounted read-only; tmpfs `/tmp` + vault volume remain writable |
| `verify-seccomp.sh`              | 11.16 | Docker default seccomp profile denies mount / unshare / ptrace / kmem / dev-mem |
| `benchmark.sh`                   | 11.1 / 11.2 | Idle RSS + cold-start wall-clock (measurement + budget assertions) |
| `probe-throughput.py`            | 11.3  | Sustained open-loop load at target RPS; asserts delivered rate ≥ 95% of target + error rate ≤ 1% |
| `probe-ask-latency-vs-go.py`     | 11.6  | Side-by-side latency sampling on Lite + Go URLs; asserts `Lite.p95 ≤ 2× Go.p95` |
| `probe-wal-reclamation.sh`       | 11.9  | Samples SQLite WAL size over a window; asserts peak ≤ ceiling |
| `probe-ws-reconnect.sh`          | 11.10 | WS reconnect under `tc netem` loss/drop (Linux + root only) |
| `soak-runner.sh`                 | 11.7  | 24h soak harness — orchestrates throughput + memory-growth + unhandled-rejection gates |
| `pi5-smoke.sh`                   | 11.17 / 11.18 | Pi 5 8GB first-boot wall-clock + idle memory; Pi-tuned budgets (ARM64 Linux only) |
| `smoke-clean-host.sh`            | 7.32  | Clean-host `docker compose up` full cycle                |

All scripts are POSIX `sh`-compatible, exit `0` on pass, non-zero on
fail, and honour `DINA_CORE_CONTAINER` / `DINA_BRAIN_CONTAINER` env
overrides so an operator running multiple Lite stacks side-by-side
can pin the probe to a specific container name.

## Conventions

- **ENOENT-not-EACCES distinction** — where relevant (e.g. key
  isolation), the probe distinguishes "path doesn't exist in this
  mount namespace" (ideal — Brain can't even see Core's vault dir)
  from "path exists but is denied" (acceptable but weaker). See
  `verify-key-isolation.sh`.
- **Writable escape hatches are probed positively** — every script
  that asserts a lock-down also checks the paths that SHOULD still be
  writable (e.g. tmpfs /tmp, vault volume). Catches over-locked
  configs that would break startup in prod.
- **Probe both containers** — when the threat model is symmetric
  (seccomp, read-only FS), both Core and Brain are checked. When
  asymmetric (key isolation probes Brain's view of Core's secrets),
  the script's banner explains the direction.

## Why these scripts and not unit tests

Runtime compose directives land in Linux kernel state (mount flags,
capability bitmasks, seccomp filters) — no pure-unit test harness can
reach them without spinning up a container. Keeping verification as
shell scripts that `docker exec` into the live container matches the
kernel-state reality directly; the alternative (mocked container
runtime) would just be testing the mock.

The scripts are invoked from `apps/home-node-lite/README.md`'s
"Verifying the install" section and wired into the Phase 11 release
checklist.
