#!/usr/bin/env bash
# Home Node Lite — image-level perf benchmark.
#
# Covers:
#   - Task 11.1 Memory idle < 250 MB (Core + Brain combined, x86_64)
#   - Task 11.2 Cold-start < 3 s per service
#
# Shape: boot each container in isolation with a timer, idle for 30 s,
# sample docker stats, tear down. Isolating per-service makes the
# cold-start measurement independent of inter-service wait (Brain's
# `depends_on: service_healthy` in compose would otherwise dominate).
#
# Pre-requisites:
#   - docker (≥ 24.0)
#   - curl
#   - Images built:
#       ghcr.io/rajmohan/dina-home-node-lite-core:dev
#       ghcr.io/rajmohan/dina-home-node-lite-brain:dev
#     (install-lite.sh or the ts-docker-build workflow produces these)
#
# Results are emitted as table + JSON on stdout. Exit 0 on PASS, 1 on
# any target miss.
#
# Env overrides (handy for slower CI arches or intentional loosening):
#   - DINA_BENCH_MEMORY_BUDGET_MB   default 250
#   - DINA_BENCH_COLDSTART_BUDGET_MS default 3000
#   - DINA_BENCH_IDLE_SEC            default 30 (how long to let the
#                                    container settle before RSS sample)
#   - DINA_BENCH_JSON                set to a file path to additionally
#                                    write machine-readable results

set -euo pipefail

MEMORY_BUDGET_MB="${DINA_BENCH_MEMORY_BUDGET_MB:-250}"
COLDSTART_BUDGET_MS="${DINA_BENCH_COLDSTART_BUDGET_MS:-3000}"
IDLE_SEC="${DINA_BENCH_IDLE_SEC:-30}"
JSON_OUT="${DINA_BENCH_JSON:-}"

CORE_IMAGE="ghcr.io/rajmohan/dina-home-node-lite-core:dev"
BRAIN_IMAGE="ghcr.io/rajmohan/dina-home-node-lite-brain:dev"

if [ -t 1 ]; then
  GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*" >&2; FAILED=1; }
info() { printf "%s\n" "$*"; }

FAILED=0

# ─── Preflight ─────────────────────────────────────────────────────────
for tool in docker curl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "required tool not on PATH: $tool" >&2; exit 2;
  }
done

for img in "$CORE_IMAGE" "$BRAIN_IMAGE"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "image not built yet: $img" >&2
    echo "  run: docker build -f apps/home-node-lite/docker/Dockerfile.{core,brain} -t $img ." >&2
    exit 2
  fi
done

# ─── Single-service cold-start + idle-memory measurement ───────────────
# Returns a `name|coldstart_ms|rss_mib` triple via stdout.
measure_service() {
  local name="$1"  image="$2"  port="$3"  host_port="$4"  env_host="$5"
  local container="dina-bench-${name}"

  # Ensure clean slate.
  docker rm -f "$container" >/dev/null 2>&1 || true

  # Cold-start: time from docker run to first /healthz 200.
  local start_ns end_ns elapsed_ms
  start_ns=$(date +%s%N)
  docker run -d --name "$container" \
    -p "${host_port}:${port}" \
    -e "${env_host}=0.0.0.0" \
    "$image" >/dev/null

  local deadline_ms=$((COLDSTART_BUDGET_MS * 5))   # measure up to 5x budget for telemetry
  while true; do
    if curl -sf "http://127.0.0.1:${host_port}/healthz" >/dev/null 2>&1; then
      break
    fi
    now_ns=$(date +%s%N)
    elapsed_ms=$(( (now_ns - start_ns) / 1000000 ))
    if [ "$elapsed_ms" -gt "$deadline_ms" ]; then
      docker rm -f "$container" >/dev/null
      echo "${name}|TIMEOUT|0"
      return 1
    fi
    sleep 0.05
  done
  end_ns=$(date +%s%N)
  local coldstart_ms=$(( (end_ns - start_ns) / 1000000 ))

  # Idle for the configured duration, then sample RSS via docker stats.
  sleep "$IDLE_SEC"
  # MemUsage format: "95.25MiB / 5.786GiB". The RIGHT side's GiB is the
  # container's memory cap, not the usage — check the LEFT token only.
  local raw usage_token rss_mib
  raw=$(docker stats --no-stream --format '{{.MemUsage}}' "$container")
  usage_token=$(echo "$raw" | awk '{print $1}')          # e.g. "95.25MiB"
  if echo "$usage_token" | grep -q 'GiB'; then
    rss_mib=$(echo "$usage_token" | sed 's/GiB//' | awk '{printf "%.2f", $1 * 1024}')
  elif echo "$usage_token" | grep -q 'MiB'; then
    rss_mib=$(echo "$usage_token" | sed 's/MiB//')
  elif echo "$usage_token" | grep -q 'KiB'; then
    rss_mib=$(echo "$usage_token" | sed 's/KiB//' | awk '{printf "%.2f", $1 / 1024}')
  else
    rss_mib="unknown"
  fi

  docker rm -f "$container" >/dev/null

  echo "${name}|${coldstart_ms}|${rss_mib}"
}

# ─── Run both measurements ─────────────────────────────────────────────
info "${BOLD}Home Node Lite — perf benchmark${RESET}"
info "budgets: cold-start < ${COLDSTART_BUDGET_MS} ms, memory Core+Brain < ${MEMORY_BUDGET_MB} MB"
info "sampling: ${IDLE_SEC} s idle before RSS read"
info ""

# Separate host ports so both containers can run side-by-side later if
# we want to measure under concurrent-idle.
core_result=$(measure_service core  "$CORE_IMAGE"  8100 18100 DINA_CORE_HOST)  || fail "Core timeout"
brain_result=$(measure_service brain "$BRAIN_IMAGE" 8200 18200 DINA_BRAIN_HOST) || fail "Brain timeout"

IFS='|' read -r cname ccold crss  <<<"$core_result"
IFS='|' read -r bname bcold brss  <<<"$brain_result"

printf '%-8s  %-16s  %-12s\n' "service" "cold-start (ms)" "idle RSS (MiB)"
printf '%-8s  %-16s  %-12s\n' "--------" "----------------" "--------------"
printf '%-8s  %-16s  %-12s\n' "$cname" "$ccold" "$crss"
printf '%-8s  %-16s  %-12s\n' "$bname" "$bcold" "$brss"

# Combined memory (MiB, so keep floating-point-safe via awk).
combined_rss=$(awk -v a="$crss" -v b="$brss" 'BEGIN{printf "%.2f", a+b}')
printf '%-8s  %-16s  %-12s\n' "combined" "-"  "$combined_rss"
info ""

# ─── Assertions ─────────────────────────────────────────────────────────
if [ "$ccold" = "TIMEOUT" ]; then
  fail "Core never became healthy"
elif [ "$ccold" -lt "$COLDSTART_BUDGET_MS" ]; then
  ok "Core cold-start ${ccold} ms < ${COLDSTART_BUDGET_MS} ms (task 11.2)"
else
  fail "Core cold-start ${ccold} ms ≥ ${COLDSTART_BUDGET_MS} ms (task 11.2)"
fi

if [ "$bcold" = "TIMEOUT" ]; then
  fail "Brain never became healthy"
elif [ "$bcold" -lt "$COLDSTART_BUDGET_MS" ]; then
  ok "Brain cold-start ${bcold} ms < ${COLDSTART_BUDGET_MS} ms (task 11.2)"
else
  fail "Brain cold-start ${bcold} ms ≥ ${COLDSTART_BUDGET_MS} ms (task 11.2)"
fi

# Memory comparison via awk (bash arithmetic can't do floats reliably).
under_budget=$(awk -v c="$combined_rss" -v b="$MEMORY_BUDGET_MB" 'BEGIN{ print (c+0 < b+0) ? "yes" : "no" }')
if [ "$under_budget" = "yes" ]; then
  ok "Core+Brain idle RSS ${combined_rss} MiB < ${MEMORY_BUDGET_MB} MB (task 11.1)"
else
  fail "Core+Brain idle RSS ${combined_rss} MiB ≥ ${MEMORY_BUDGET_MB} MB (task 11.1)"
fi

# ─── JSON output ───────────────────────────────────────────────────────
if [ -n "$JSON_OUT" ]; then
  cat >"$JSON_OUT" <<EOF
{
  "budgets": { "memory_mb": ${MEMORY_BUDGET_MB}, "coldstart_ms": ${COLDSTART_BUDGET_MS} },
  "idle_sec": ${IDLE_SEC},
  "services": {
    "core":  { "coldstart_ms": ${ccold}, "idle_rss_mib": ${crss} },
    "brain": { "coldstart_ms": ${bcold}, "idle_rss_mib": ${brss} }
  },
  "combined_rss_mib": ${combined_rss},
  "pass": $([ "$FAILED" = 0 ] && echo true || echo false)
}
EOF
  info "${BOLD}JSON results written to ${JSON_OUT}${RESET}"
fi

info ""
if [ "$FAILED" = 0 ]; then
  printf "${GREEN}${BOLD}PASS${RESET} — both budgets met\n"
  exit 0
else
  printf "${RED}${BOLD}FAIL${RESET} — budget(s) exceeded\n" >&2
  exit 1
fi
