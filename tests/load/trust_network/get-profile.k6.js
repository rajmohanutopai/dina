// Trust-network getProfile xRPC load test (TN-TEST-081).
//
// Plan §13.6 doesn't explicitly target getProfile latency, but the
// xRPC catalogue (`docs/trust-network/observability.md` §3) groups
// it with `resolve` under the "trust-data point reads" tier. Apply
// the same SLA as search (≤ 250ms p95) at a lower throughput
// because profile lookups are a much smaller fraction of read
// traffic in production (mobile fetches one profile per detail
// view, vs many searches per browse session).
//
// Pinned: 30 RPS sustained, p95 ≤ 250ms, error rate < 1%.

import http from 'k6/http'
import { check } from 'k6'
import { Trend } from 'k6/metrics'

import { APPVIEW_URL, XRPC_PREFIX } from './lib/config.js'

const profileLatency = new Trend('get_profile_xrpc_duration_ms', true)

// Profile lookups expect realistic-looking DIDs. The seed step
// populates `did:plc:loadtest-author-NNNN` keys with N attestations
// each so the scorer aggregator runs through all 6 confidence
// buckets. Until the seed lands this script falls back to a
// rotating set of DIDs that may or may not exist in the corpus —
// non-existent DIDs return an empty profile shape (not 404), so
// the latency numbers are still measurable.
const PROFILE_DIDS = []
for (let i = 1; i <= 100; i++) {
  PROFILE_DIDS.push(`did:plc:loadtest-author-${String(i).padStart(4, '0')}`)
}

export const options = {
  scenarios: {
    get_profile_30rps: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 60,
      maxVUs: 120,
    },
  },
  thresholds: {
    'http_req_duration{status:200}': ['p(95)<250'],
    'http_req_failed': ['rate<0.01'],
    'get_profile_xrpc_duration_ms': ['p(95)<250'],
  },
}

export default function () {
  const did = PROFILE_DIDS[(__VU + __ITER) % PROFILE_DIDS.length]
  const url = `${APPVIEW_URL}${XRPC_PREFIX}/com.dina.trust.getProfile?did=${encodeURIComponent(did)}`

  const res = http.get(url, {
    tags: { name: 'getProfile.xrpc' },
    timeout: '3s',
  })

  profileLatency.add(res.timings.duration)

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
  })
}
