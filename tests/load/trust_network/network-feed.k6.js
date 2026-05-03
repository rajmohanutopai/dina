// Trust-network networkFeed xRPC load test (TN-TEST-081).
//
// The feed query is structurally more expensive than search or
// getProfile: it runs a depth-1 BFS over `trust_edges` per request
// to compute the viewer's 1-hop set, then a paginated
// `attestations.author_did IN (...)` query. p95 SLA is relaxed
// accordingly to 400ms vs the 250ms bar for search.
//
// Plan §6.4 + observability §3 group networkFeed under "viewer-
// scoped reads" — slower per-request but lower volume (mobile
// pulls the feed on tab focus, not per scroll). 20 RPS sustained
// is the production target floor.
//
// Pinned: 20 RPS sustained, p95 ≤ 400ms, error rate < 1%.

import http from 'k6/http'
import { check } from 'k6'
import { Trend } from 'k6/metrics'

import { APPVIEW_URL, XRPC_PREFIX, pickViewerDid } from './lib/config.js'

const feedLatency = new Trend('network_feed_xrpc_duration_ms', true)

export const options = {
  scenarios: {
    network_feed_20rps: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 40,
      maxVUs: 80,
    },
  },
  thresholds: {
    'http_req_duration{status:200}': ['p(95)<400'],
    'http_req_failed': ['rate<0.01'],
    'network_feed_xrpc_duration_ms': ['p(95)<400'],
  },
}

export default function () {
  const viewerDid = pickViewerDid(__VU, __ITER)
  const url = `${APPVIEW_URL}${XRPC_PREFIX}/com.dina.trust.networkFeed?viewerDid=${encodeURIComponent(viewerDid)}&limit=25`

  const res = http.get(url, {
    tags: { name: 'networkFeed.xrpc' },
    timeout: '3s',
  })

  feedLatency.add(res.timings.duration)

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
    'has attestations array': (r) => {
      try {
        const body = JSON.parse(r.body)
        return Array.isArray(body.attestations)
      } catch {
        return false
      }
    },
  })
}
