/**
 * AppView security hardening tests (TN-TEST-082).
 *
 * The backlog entry asks for adversarial coverage of:
 *
 *   1. **Signature forgery** — record-validator + namespace-key
 *      verification (TN-ING-003, still pending). Out of scope here:
 *      the inbound auth surface for AppView's xRPC is open-read by
 *      design (it's a public indexer), so there's no bearer to
 *      forge; record signatures are validated at the AT-protocol
 *      commit layer upstream of AppView. The relevant "forgery"
 *      surface is the rate-limit + IP-bucket boundary, where a
 *      forged proxy header would let an attacker bypass per-IP
 *      caps. That's what HIGH-01 hardens; this file pins it.
 *
 *   2. **Rate-limit bypass** — covered exhaustively here:
 *      - Trust-proxy boundary: XFF ignored when TRUST_PROXY=0.
 *      - XFF header parsing: leftmost (client) wins; whitespace +
 *        repeated commas tolerated; malformed falls back to socket.
 *      - Per-IP isolation: one IP exhausting their cap doesn't
 *        affect other IPs.
 *      - Per-method isolation: an IP exhausting `search` still has
 *        the full cap for `subjectGet`.
 *      - Window roll-over: cap resets at the next 60s boundary.
 *      - Rate-limit env override cannot LOWER the static tier.
 *
 *   3. **Flag spam** — covered by the ingester rate limiter:
 *      `tests/unit/02-ingester-components.test.ts` UT-RL-011..018
 *      pin per-collection daily caps including `com.dina.trust.flag`
 *      at 10/day. This file references that coverage so any future
 *      "where's the flag-spam defence?" search lands here.
 *
 *   4. **Bearer mismatch** — AppView's xRPC surface is open-read
 *      (no bearer auth required). The PDS side enforces commit-level
 *      signatures. A "bearer mismatch" surface doesn't exist on
 *      AppView; this scenario lives in the Core↔Brain integration
 *      tests (a different test tier).
 *
 * Pure unit tests against the extracted client-ip helper +
 * rate-limit middleware — no Postgres / Docker required.
 */

import { describe, expect, it } from 'vitest'

import {
  UNKNOWN_IP_BUCKET,
  extractClientIp,
} from '@/api/middleware/client-ip'
import {
  PER_METHOD_LIMITS_RPM,
  checkPerMethodRateLimit,
  createRateLimitCache,
  getMethodLimit,
} from '@/api/middleware/rate-limit'
import { getCollectionDailyCap } from '@/ingester/rate-limiter'

// ─── Trust-proxy boundary (HIGH-01) ──────────────────────────────────────

describe('extractClientIp — TRUST_PROXY=false: XFF ignored (no bypass)', () => {
  it('XFF spoofing has zero effect when proxy not trusted', () => {
    // The attacker sends `X-Forwarded-For: 1.2.3.4` per request,
    // hoping each request looks like a different client. With
    // TRUST_PROXY=false, this is silently ignored — every request
    // keys on the actual TCP peer (`remoteAddress`).
    expect(
      extractClientIp({
        trustProxy: false,
        forwardedFor: '1.2.3.4',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('10.0.0.1')
  })

  it('hostile multi-entry XFF still ignored', () => {
    // Even a fully-formed-looking `client, proxy1, proxy2` XFF is
    // ignored — the trust boundary is binary, not heuristic.
    expect(
      extractClientIp({
        trustProxy: false,
        forwardedFor: '1.2.3.4, 192.168.1.1, 10.0.0.5',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('10.0.0.1')
  })

  it('returns "unknown" when XFF spoof + no remoteAddress (degraded but safe)', () => {
    // Detached socket case + hostile XFF. We refuse the spoof and
    // fall through to the unknown bucket. The attacker sharing a
    // bucket with other detached-socket clients is the price.
    expect(
      extractClientIp({
        trustProxy: false,
        forwardedFor: '1.2.3.4',
        remoteAddress: undefined,
      }),
    ).toBe(UNKNOWN_IP_BUCKET)
  })
})

describe('extractClientIp — TRUST_PROXY=true: XFF parsing', () => {
  it('takes the leftmost (=client) entry of a comma-list', () => {
    // RFC 7239 / standard XFF semantics: the leftmost entry is the
    // original client; subsequent entries are intermediate proxies.
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: '203.0.113.5, 10.0.0.1, 10.0.0.2',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('203.0.113.5')
  })

  it('trims whitespace around the client entry', () => {
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: '   203.0.113.5   , 10.0.0.1',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('203.0.113.5')
  })

  it('tolerates leading-empty entries (skips to first non-empty)', () => {
    // `,,1.2.3.4` is malformed but seen in the wild. We skip the
    // empties rather than treating them as the client.
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: ',, 203.0.113.5, 10.0.0.1',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('203.0.113.5')
  })

  it('falls back to remoteAddress when XFF is all-empty / all-whitespace', () => {
    // ` , , ` would otherwise loop forever or pick whitespace —
    // fallback semantics make the boundary safe.
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: ' , , ',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('10.0.0.1')
  })

  it('falls back to remoteAddress when XFF header absent', () => {
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: undefined,
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('10.0.0.1')
  })

  it('falls back to remoteAddress when XFF is empty string', () => {
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: '',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('10.0.0.1')
  })

  it('preserves IPv6 brackets in the returned IP (no parsing)', () => {
    // The output is a cache-key string, not a parsed IP — IPv6
    // bracket form `[::1]:8080` survives unchanged. Stripping the
    // port would shift the attack surface to the parser; we'd
    // rather have a slightly-noisy bucket key than a parser bug.
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: '[2001:db8::1]:443',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('[2001:db8::1]:443')
  })

  it('preserves IPv4-mapped IPv6 (no parsing)', () => {
    expect(
      extractClientIp({
        trustProxy: true,
        forwardedFor: '::ffff:203.0.113.5',
        remoteAddress: '10.0.0.1',
      }),
    ).toBe('::ffff:203.0.113.5')
  })
})

describe('extractClientIp — degraded paths', () => {
  it('returns UNKNOWN_IP_BUCKET when neither source produces an IP', () => {
    expect(
      extractClientIp({
        trustProxy: false,
        forwardedFor: undefined,
        remoteAddress: undefined,
      }),
    ).toBe(UNKNOWN_IP_BUCKET)
  })

  it('UNKNOWN_IP_BUCKET is exactly "unknown" (cache-key string pinned)', () => {
    expect(UNKNOWN_IP_BUCKET).toBe('unknown')
  })

  it('non-string remoteAddress (defensive) treated as missing', () => {
    expect(
      extractClientIp({
        trustProxy: false,
        forwardedFor: undefined,
        // @ts-expect-error — runtime guard
        remoteAddress: 42,
      }),
    ).toBe(UNKNOWN_IP_BUCKET)
  })
})

// ─── Rate-limit bypass attempts (per-IP / per-method isolation) ──────────

describe('rate-limit isolation — bypass-resistance', () => {
  const NOW = 1_000_000

  it('per-IP isolation: ip-A exhausting cap does not affect ip-B', () => {
    // The classic bypass attempt is "spread requests across many
    // IPs". With proxy-trust off, this requires actual TCP peers,
    // which is much harder. The test pins that the limiter buckets
    // are correctly keyed by IP.
    const cache = createRateLimitCache()
    const limit = getMethodLimit('com.dina.trust.search') // 60

    // ip-A burns the bucket
    for (let i = 0; i < limit; i++) {
      const r = checkPerMethodRateLimit(cache, '1.1.1.1', 'com.dina.trust.search', NOW)
      expect(r.ok).toBe(true)
    }
    // ip-A's next request is denied
    expect(
      checkPerMethodRateLimit(cache, '1.1.1.1', 'com.dina.trust.search', NOW).ok,
    ).toBe(false)

    // ip-B is still fresh (proves bucket isolation)
    expect(
      checkPerMethodRateLimit(cache, '2.2.2.2', 'com.dina.trust.search', NOW).ok,
    ).toBe(true)
  })

  it('per-method isolation: search exhaustion does not affect subjectGet', () => {
    // Another bypass surface: rotate methodId. The limiter keys on
    // `(ip, method)`, so an attacker exhausting `search` still hits
    // its OWN cap on `subjectGet` (and vice versa). Defends against
    // the "what if I just use a different endpoint" approach.
    const cache = createRateLimitCache()
    const ip = '1.1.1.1'
    const searchLimit = getMethodLimit('com.dina.trust.search') // 60

    for (let i = 0; i < searchLimit; i++) {
      checkPerMethodRateLimit(cache, ip, 'com.dina.trust.search', NOW)
    }
    expect(
      checkPerMethodRateLimit(cache, ip, 'com.dina.trust.search', NOW).ok,
    ).toBe(false)

    // subjectGet is a separate bucket — fresh.
    expect(
      checkPerMethodRateLimit(cache, ip, 'com.dina.trust.subjectGet', NOW).ok,
    ).toBe(true)
  })

  it('UNKNOWN_IP_BUCKET clients share one bucket (intentional — degraded clients pay together)', () => {
    // When extraction can't determine the IP, both clients land in
    // the "unknown" bucket. Sharing the cap is the conservative
    // choice — better than letting an attacker on a detached socket
    // reset the bucket per request.
    const cache = createRateLimitCache()
    const limit = getMethodLimit('com.dina.trust.search')

    // First client (call them A) exhausts the unknown bucket
    for (let i = 0; i < limit; i++) {
      checkPerMethodRateLimit(cache, UNKNOWN_IP_BUCKET, 'com.dina.trust.search', NOW)
    }
    // A is now denied
    expect(
      checkPerMethodRateLimit(cache, UNKNOWN_IP_BUCKET, 'com.dina.trust.search', NOW).ok,
    ).toBe(false)
    // Another "unknown" client (call them B) is also denied — they
    // share the bucket. This is BY DESIGN: see the helper docstring.
    expect(
      checkPerMethodRateLimit(cache, UNKNOWN_IP_BUCKET, 'com.dina.trust.search', NOW).ok,
    ).toBe(false)
  })

  it('window roll-over: bucket resets at +60s', () => {
    const cache = createRateLimitCache()
    const ip = '1.1.1.1'
    const limit = getMethodLimit('com.dina.trust.search')

    for (let i = 0; i < limit; i++) {
      checkPerMethodRateLimit(cache, ip, 'com.dina.trust.search', NOW)
    }
    expect(
      checkPerMethodRateLimit(cache, ip, 'com.dina.trust.search', NOW).ok,
    ).toBe(false)

    // Step the clock past the 60s window — bucket rolls over.
    expect(
      checkPerMethodRateLimit(cache, ip, 'com.dina.trust.search', NOW + 60_001).ok,
    ).toBe(true)
  })

  it('env override CANNOT lower the static tier (HIGH-01 invariant)', () => {
    // Ops mistake guard: setting `RATE_LIMIT_RPM=10` cannot make
    // `attestationStatus` (cap 600) into a 10/min limit. Env raises
    // ceilings (test-mode bypass) but NEVER lowers them.
    expect(getMethodLimit('com.dina.trust.attestationStatus', 10)).toBe(600)
    expect(getMethodLimit('com.dina.trust.search', 10)).toBe(60)
  })
})

// ─── Tier table integrity ───────────────────────────────────────────────

describe('PER_METHOD_LIMITS_RPM — tier integrity', () => {
  it('every entry is a positive finite number', () => {
    for (const [method, cap] of Object.entries(PER_METHOD_LIMITS_RPM)) {
      expect(
        typeof cap === 'number' && Number.isFinite(cap) && cap > 0,
        `${method}=${cap} must be positive finite`,
      ).toBe(true)
    }
  })

  it('table is frozen at runtime (defends against import-time mutation)', () => {
    expect(Object.isFrozen(PER_METHOD_LIMITS_RPM)).toBe(true)
  })

  it('outbox-polling tier (attestationStatus) is the highest', () => {
    // The mobile outbox watcher polls every 5s = 12/min minimum;
    // the 600 tier covers ramp + retries. If a future refactor drops
    // it to a lower tier the outbox starts 429-ing, breaking publish
    // recovery. Pin it.
    const allCaps = Object.values(PER_METHOD_LIMITS_RPM)
    expect(PER_METHOD_LIMITS_RPM['com.dina.trust.attestationStatus']).toBe(
      Math.max(...allCaps),
    )
  })
})

// ─── Cross-reference to flag-spam coverage ──────────────────────────────

describe('flag-spam (TN-TEST-082 — cross-cutting reference)', () => {
  // The full per-collection daily cap behaviour-coverage lives in
  // `tests/unit/02-ingester-components.test.ts` (UT-RL-011..018):
  // 10-passes-11th-rejected boundary, per-collection independence,
  // per-DID independence, etc. This security-test file pins the
  // CAP VALUE itself so a future refactor that lowers the cap to
  // (say) 1/day breaks loudly here in addition to the behaviour
  // tests — single-bucket boundary tests stay green, but the
  // discoverable security-tests file makes the intent obvious.

  it('com.dina.trust.flag cap is 10/day (Plan §6.4 — strictest tier)', () => {
    expect(getCollectionDailyCap('com.dina.trust.flag')).toBe(10)
  })

  it('cap tiers are ordered by abuse risk: flag(10) < endorsement(30) < attestation(60)', () => {
    // Plan §6.4 ramps caps with abuse-cost: flags are the highest
    // risk (one bad actor can swarm-tag a target), endorsements are
    // medium (a fake reputation booster), attestations are lowest
    // (the bread-and-butter publishing path). Pinning the ordering
    // catches any refactor that flips the tier rationale.
    const flag = getCollectionDailyCap('com.dina.trust.flag')!
    const endorsement = getCollectionDailyCap('com.dina.trust.endorsement')!
    const attestation = getCollectionDailyCap('com.dina.trust.attestation')!
    expect(flag).toBeLessThan(endorsement)
    expect(endorsement).toBeLessThan(attestation)
    expect(flag).toBe(10)
    expect(endorsement).toBe(30)
    expect(attestation).toBe(60)
  })

  it('un-capped collections (vouch, reaction, reply, reportRecord) return null', () => {
    // The cap table is selective — capping every collection would
    // cripple legitimate publishing. Vouches / reactions / replies
    // have their own per-DID hourly gate and don't need a daily cap.
    expect(getCollectionDailyCap('com.dina.trust.vouch')).toBeNull()
    expect(getCollectionDailyCap('com.dina.trust.reaction')).toBeNull()
    expect(getCollectionDailyCap('com.dina.trust.reply')).toBeNull()
    expect(getCollectionDailyCap('com.dina.trust.reportRecord')).toBeNull()
  })

  it('unknown / unmapped collection returns null (no surprise cap)', () => {
    // A new lexicon landing without a deliberate cap update gets
    // null (no cap) rather than an inherited cap. Forces the operator
    // to consciously decide whether the new collection needs spam
    // defence at the rate-limiter layer.
    expect(getCollectionDailyCap('com.dina.trust.somethingNew')).toBeNull()
  })
})
