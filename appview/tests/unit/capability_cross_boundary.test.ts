/**
 * Cross-boundary capability convergence — the end-to-end chain the
 * Services layers exist to guarantee (SERVICES_LAUNCH_ARCHITECTURE.md
 * Part 1):
 *
 *   provider publishes under an ALIAS  (e.g. `bus_eta`)
 *     → L2 ingest canonicalization     (canonicalizeForIndex → `eta_query`)
 *     → L3/L4 search + discovery        (resolveCanonicalCapability / index)
 *     → consumer's query is CANONICAL   (`eta_query`)
 *     → L5 provider ingress accepts it  (resolveCanonicalCapability folds
 *                                        the provider's own alias config to
 *                                        the same canonical)
 *
 * The guarantee rests on ONE shared registry used at every hop. AppView
 * indexes/searches with `appview/src/shared/capability-registry.ts`; Core's
 * D2D ingress (`isCapabilityConfigured`) resolves with the byte-identical
 * `@dina/protocol` copy (drift gate: capability_registry_drift.test.ts).
 * This test exercises the chain through the AppView copy and asserts the
 * convergence property the cross-stack relies on: an alias anywhere folds
 * to the same canonical everywhere, so consumer and provider meet even
 * when they spelled the capability differently.
 */

import { describe, expect, it } from 'vitest'
import {
  canonicalizeForIndex,
  resolveCanonicalCapability,
} from '../../src/shared/capability-registry.js'

/**
 * Mirror of Core's `isCapabilityConfigured` canonical-match logic
 * (service_config.ts, L5) over a plain config map — the same shared
 * resolver, so this faithfully models the ingress decision without
 * standing up Core. Exact-match fast path, then canonical match.
 */
function ingressAccepts(
  configuredCapabilities: Record<string, unknown>,
  inboundCapability: string,
): boolean {
  if (Object.prototype.hasOwnProperty.call(configuredCapabilities, inboundCapability)) {
    return true
  }
  const inboundCanonical = resolveCanonicalCapability(inboundCapability)
  if (inboundCanonical === null) return false
  for (const configured of Object.keys(configuredCapabilities)) {
    if (resolveCanonicalCapability(configured) === inboundCanonical) return true
  }
  return false
}

describe('capability cross-boundary convergence (Layers 2→5)', () => {
  it('alias-at-ingest → canonical-in-index → canonical-query → alias-config ingress accepts', () => {
    // 1. Provider publishes a service profile advertising the ALIAS.
    const published = canonicalizeForIndex(['bus_eta'], {}, {})
    // 2. L2 — the index stores the CANONICAL, not the alias.
    expect(published.capabilities).toEqual(['eta_query'])
    expect(published.unknown).toEqual([])

    // 3. The consumer's discovery surfaces the canonical capability; its
    //    query carries the canonical name.
    const consumerQuery = 'eta_query'

    // 4. The SAME provider configured ITSELF under a (different) alias —
    //    `transit_eta`. L5 ingress must still accept the canonical query.
    const providerConfig = { transit_eta: { responsePolicy: 'auto' } }
    expect(ingressAccepts(providerConfig, consumerQuery)).toBe(true)
  })

  it('two different aliases of one canonical meet (consumer alias ↔ provider alias)', () => {
    // Consumer somehow still holds an alias, provider holds another — both
    // fold to `eta_query`, so they meet.
    const providerConfig = { bus_eta: { responsePolicy: 'auto' } }
    expect(ingressAccepts(providerConfig, 'arrival_time')).toBe(true)
    expect(ingressAccepts(providerConfig, 'transit_eta')).toBe(true)
  })

  it('a DIFFERENT canonical does NOT cross (no accidental convergence)', () => {
    const providerConfig = { eta_query: { responsePolicy: 'auto' } }
    // appointment_status is a different canonical — must be rejected.
    expect(ingressAccepts(providerConfig, 'appointment_status')).toBe(false)
    expect(ingressAccepts(providerConfig, 'appt_status')).toBe(false)
  })

  it('an unknown (out-of-registry) capability is dropped at ingest AND not accepted by alias-match', () => {
    // L2: a capability the registry doesn't know is dropped from the
    // indexed array and reported as unknown (never indexed raw).
    const published = canonicalizeForIndex(['totally_made_up'], {}, {})
    expect(published.capabilities).toEqual([])
    expect(published.unknown).toEqual(['totally_made_up'])

    // L5: a registry-known config does not accept the unknown via the
    // canonical path (it resolves to null → no canonical match). Only an
    // exact string match would accept it (custom out-of-registry caps).
    expect(ingressAccepts({ eta_query: {} }, 'totally_made_up')).toBe(false)
    expect(ingressAccepts({ totally_made_up: {} }, 'totally_made_up')).toBe(true) // exact custom
  })
})
