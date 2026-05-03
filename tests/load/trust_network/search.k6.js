// Trust-network search xRPC load test (TN-TEST-081).
//
// Pins Plan §13.6 capacity targets:
//   - search throughput: 50 RPS sustained
//   - search p95 latency: ≤ 250 ms
//
// Strategy:
//   - `arrival-rate` executor pinned at 50 RPS for 60s. Open-loop
//     workload — k6 generates a request every 20ms regardless of
//     prior latency, which is the realistic "users + bots are
//     calling" model. Closed-loop (constant-vus) would silently
//     adapt to slowdowns and hide tail-latency degradation.
//   - 2x preAllocated VUs so a slow request doesn't block the
//     scheduler; max headroom prevents queuing artifacts.
//   - Threshold on `http_req_duration{status:200}` p95 — un-tagged
//     duration would let a fast 500 mask a slow 200.
//   - Threshold on `http_req_failed` < 1% — load tests aren't
//     correctness tests, but a high error rate invalidates the
//     latency numbers (could be measuring fast 4xx).
//
// Corpus expectation: at least a few thousand attestations so
// `ts_rank` + cursor pagination see realistic plan shapes. With an
// empty DB, this script will pass thresholds trivially because every
// query returns 0 rows in microseconds — that's not a useful
// regression guard. The seed step (TODO, separate task) populates
// 1M attestations per Plan §13.6.

import http from 'k6/http'
import { check } from 'k6'
import { Trend } from 'k6/metrics'

import { APPVIEW_URL, XRPC_PREFIX, pickViewerDid } from './lib/config.js'
import { pickSearchParams, buildSearchQuery } from './lib/queries.js'

// Custom trend metric so the report breaks down search latency
// per-call independently from any other request the harness makes
// (e.g. /health probes). Tagged with `path` so the dashboard can
// pivot on which search shape is slow.
const searchLatency = new Trend('search_xrpc_duration_ms', true)

export const options = {
  scenarios: {
    search_50rps: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 100, // 2x 50rps headroom — scheduler must not block.
      maxVUs: 200,
    },
  },
  thresholds: {
    // Plan §13.6: search p95 ≤ 250ms.
    'http_req_duration{status:200}': ['p(95)<250'],
    // Sanity: error rate must stay below 1% — fast-fail responses
    // would otherwise hide latency regressions on the success path.
    'http_req_failed': ['rate<0.01'],
    // Custom trend matches the http duration but lets dashboards
    // distinguish search from other endpoints in the same run.
    'search_xrpc_duration_ms': ['p(95)<250'],
  },
}

export default function () {
  const vu = __VU
  const iter = __ITER
  const params = pickSearchParams(vu, iter)
  const viewerDid = (iter % 3) === 0 ? pickViewerDid(vu, iter) : undefined
  const qs = buildSearchQuery({ ...params, viewerDid })
  const url = `${APPVIEW_URL}${XRPC_PREFIX}/com.dina.trust.search?${qs}`

  const res = http.get(url, {
    tags: { name: 'search.xrpc' },
    timeout: '5s',
  })

  searchLatency.add(res.timings.duration)

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response is JSON': (r) => {
      try {
        JSON.parse(r.body)
        return true
      } catch {
        return false
      }
    },
    'has results array': (r) => {
      try {
        const body = JSON.parse(r.body)
        return Array.isArray(body.results)
      } catch {
        return false
      }
    },
  })
}
