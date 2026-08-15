/**
 * Unit tests for the canonical capability registry + resolver.
 * Spec: docs/SERVICES_LAUNCH_ARCHITECTURE.md Part 1, Layer 1.
 */

import { describe, expect, it } from 'vitest'
import {
  resolveCanonicalCapability,
  resolveSearchableCapability,
  classifyCapability,
  isCustomCapability,
  normalizeCapability,
  getCapabilityEntry,
  allCanonicalCapabilities,
  buildAliasMap,
  canonicalizeForIndex,
  CAPABILITY_REGISTRY,
  type CanonicalCapability,
} from '../../src/shared/capability-registry.js'

describe('capability-registry — resolveCanonicalCapability', () => {
  it('resolves a canonical name to itself (idempotent)', () => {
    expect(resolveCanonicalCapability('eta_query')).toBe('eta_query')
    expect(resolveCanonicalCapability('appointment_status')).toBe('appointment_status')
  })

  it('resolves every alias to its canonical', () => {
    expect(resolveCanonicalCapability('bus_eta')).toBe('eta_query')
    expect(resolveCanonicalCapability('transit_eta')).toBe('eta_query')
    expect(resolveCanonicalCapability('arrival_time')).toBe('eta_query')
    expect(resolveCanonicalCapability('next_bus')).toBe('eta_query')
    expect(resolveCanonicalCapability('appointment_query')).toBe('appointment_status')
    expect(resolveCanonicalCapability('appt_status')).toBe('appointment_status')
    expect(resolveCanonicalCapability('booking_status')).toBe('appointment_status')
  })

  it('normalizes case + surrounding whitespace before resolving', () => {
    expect(resolveCanonicalCapability('  BUS_ETA  ')).toBe('eta_query')
    expect(resolveCanonicalCapability('Eta_Query')).toBe('eta_query')
  })

  it('returns null for an unknown capability (NOT a pass-through)', () => {
    expect(resolveCanonicalCapability('weird_thing')).toBeNull()
    expect(resolveCanonicalCapability('order_pizza')).toBeNull()
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(resolveCanonicalCapability('')).toBeNull()
    expect(resolveCanonicalCapability('   ')).toBeNull()
  })
})

describe('capability-registry — normalizeCapability', () => {
  it('trims and lowercases', () => {
    expect(normalizeCapability('  Bus_ETA ')).toBe('bus_eta')
  })
})

describe('capability-registry — getCapabilityEntry', () => {
  it('returns the entry (description + domain) for a canonical', () => {
    const e = getCapabilityEntry('eta_query')
    expect(e?.canonical).toBe('eta_query')
    expect(e?.domain).toBe('transit')
    expect(e?.description).toMatch(/arrival/i)
  })

  it('returns the entry for an alias too', () => {
    expect(getCapabilityEntry('bus_eta')?.canonical).toBe('eta_query')
  })

  it('returns null for an unknown', () => {
    expect(getCapabilityEntry('nope')).toBeNull()
  })
})

describe('capability-registry — invariants', () => {
  it('every alias is unique across the registry (no double-mapping)', () => {
    // The module throws at load on a duplicate alias; this asserts the
    // shipped registry has none, and locks that invariant.
    const seen = new Set<string>()
    for (const entry of CAPABILITY_REGISTRY) {
      for (const alias of [entry.canonical, ...entry.aliases]) {
        expect(seen.has(alias), `duplicate vocabulary token: ${alias}`).toBe(false)
        seen.add(alias)
      }
    }
  })

  it('no alias collides with any canonical of a DIFFERENT entry', () => {
    const canonicals = new Set(CAPABILITY_REGISTRY.map((e) => e.canonical))
    for (const entry of CAPABILITY_REGISTRY) {
      for (const alias of entry.aliases) {
        if (canonicals.has(alias)) {
          expect(alias).toBe(entry.canonical) // only allowed if it IS this entry's canonical (it isn't, aliases exclude canonical)
        }
      }
    }
  })

  it('allCanonicalCapabilities returns the launch set', () => {
    const domains = allCanonicalCapabilities().map((e) => e.domain)
    expect(domains).toContain('transit')
    expect(domains).toContain('appointments')
  })

  it('the shipped registry is deeply frozen (shared source of truth is immutable)', () => {
    expect(Object.isFrozen(CAPABILITY_REGISTRY)).toBe(true)
    expect(Object.isFrozen(CAPABILITY_REGISTRY[0])).toBe(true)
    expect(Object.isFrozen(CAPABILITY_REGISTRY[0].aliases)).toBe(true)
  })
})

describe('capability-registry — buildAliasMap fail-loud invariant', () => {
  /**
   * A minimal registry entry. `buildAliasMap` reads only `canonical` and
   * `aliases`; the rest exist because `CanonicalCapability` requires them.
   * Built through one helper so a new required field is added in ONE place —
   * these fixtures had gone stale against three fields the type gained, and
   * nothing noticed because no typecheck covered `tests/`.
   */
  const entry = (canonical: string, aliases: string[]): CanonicalCapability => ({
    canonical,
    aliases,
    categoryIds: [],
    description: '',
    domain: 'd',
    intentRoutable: true,
    privacyClass: 'public',
    requiresSubjectAuthorization: false,
  })

  it('throws when two entries claim the same alias', () => {
    expect(() => buildAliasMap([entry('a', ['x']), entry('b', ['x'])])).toThrow(/maps to both/)
  })

  it('throws when one entry\'s alias collides with another\'s canonical', () => {
    expect(() => buildAliasMap([entry('a', []), entry('b', ['a'])])).toThrow(/maps to both/)
  })

  it('tolerates an alias listed identically twice within one entry (no false positive)', () => {
    expect(buildAliasMap([entry('a', ['x', 'x'])]).get('x')).toBe('a')
  })
})

describe('capability-registry — canonicalizeForIndex (Layer 2)', () => {
  it('canonicalizes the array (alias→canonical) and dedupes', () => {
    const r = canonicalizeForIndex(['bus_eta', 'eta_query', 'BUS_ETA'], undefined, undefined)
    expect(r.capabilities).toEqual(['eta_query'])
    expect(r.unknown).toEqual([])
  })

  it('re-keys schemas + policy from the published alias to the canonical (P1b)', () => {
    const r = canonicalizeForIndex(
      ['bus_eta'],
      { bus_eta: { schema_hash: 'h1' } },
      { bus_eta: 'auto' },
    )
    expect(r.capabilitySchemas).toEqual({ eta_query: { schema_hash: 'h1' } })
    expect(r.responsePolicy).toEqual({ eta_query: 'auto' })
  })

  it('re-keys when the map key differs in case from the capability string', () => {
    const r = canonicalizeForIndex(['bus_eta'], { Bus_ETA: { schema_hash: 'h' } }, { 'BUS_eta': 'auto' })
    expect(r.capabilitySchemas).toEqual({ eta_query: { schema_hash: 'h' } })
    expect(r.responsePolicy).toEqual({ eta_query: 'auto' })
  })

  it('collects unknown capabilities separately and excludes them from the public array', () => {
    const r = canonicalizeForIndex(['plumbing', 'eta_query', 'plumbing'], undefined, undefined)
    expect(r.capabilities).toEqual(['eta_query'])
    expect(r.unknown).toEqual(['plumbing']) // deduped
  })

  it('first occurrence wins when two aliases of the same canonical are listed', () => {
    const r = canonicalizeForIndex(
      ['bus_eta', 'eta_query'],
      { bus_eta: { schema_hash: 'first' }, eta_query: { schema_hash: 'second' } },
      { bus_eta: 'auto', eta_query: 'manual' },
    )
    expect(r.capabilities).toEqual(['eta_query'])
    expect(r.capabilitySchemas).toEqual({ eta_query: { schema_hash: 'first' } })
    expect(r.responsePolicy).toEqual({ eta_query: 'auto' })
  })

  it('skips empty/whitespace capabilities', () => {
    const r = canonicalizeForIndex(['eta_query', '   ', ''], undefined, undefined)
    expect(r.capabilities).toEqual(['eta_query'])
    expect(r.unknown).toEqual([])
  })

  it('handles undefined inputs gracefully', () => {
    const r = canonicalizeForIndex(undefined, undefined, undefined)
    expect(r.capabilities).toEqual([])
    expect(r.capabilitySchemas).toEqual({})
    expect(r.responsePolicy).toEqual({})
    expect(r.unknown).toEqual([])
  })

  it('omits a map entry when the provider published no schema/policy for that capability', () => {
    const r = canonicalizeForIndex(['eta_query'], {}, {})
    expect(r.capabilities).toEqual(['eta_query'])
    expect(r.capabilitySchemas).toEqual({})
    expect(r.responsePolicy).toEqual({})
  })
})

describe('capability-registry — open vocabulary (namespaced custom capabilities)', () => {
  it('isCustomCapability accepts dotted names, rejects flat / malformed', () => {
    expect(isCustomCapability('com.acme.widget_price')).toBe(true)
    expect(isCustomCapability('acme.widget')).toBe(true)
    // flat registry-style names are NOT custom (no dot)
    expect(isCustomCapability('eta_query')).toBe(false)
    expect(isCustomCapability('plumbing')).toBe(false)
    // malformed: leading/trailing dot, empty segment, illegal chars
    expect(isCustomCapability('.acme.widget')).toBe(false)
    expect(isCustomCapability('acme..widget')).toBe(false)
    expect(isCustomCapability('acme.widget.')).toBe(false)
    expect(isCustomCapability('acme.wid get')).toBe(false)
  })

  it('classifyCapability splits canonical / custom / unknown', () => {
    expect(classifyCapability('bus_eta')).toEqual({ kind: 'canonical', canonical: 'eta_query' })
    expect(classifyCapability('com.acme.widget_price')).toEqual({
      kind: 'custom',
      canonical: 'com.acme.widget_price',
    })
    expect(classifyCapability('plumbing')).toEqual({ kind: 'unknown' })
    expect(classifyCapability('  COM.Acme.Widget  ')).toEqual({
      kind: 'custom',
      canonical: 'com.acme.widget',
    })
  })

  it('resolveSearchableCapability resolves canonical AND custom, null on unknown', () => {
    expect(resolveSearchableCapability('bus_eta')).toBe('eta_query')
    expect(resolveSearchableCapability('com.acme.widget_price')).toBe('com.acme.widget_price')
    expect(resolveSearchableCapability('plumbing')).toBeNull()
    // resolveCanonicalCapability stays registry-only (custom → null there)
    expect(resolveCanonicalCapability('com.acme.widget_price')).toBeNull()
  })

  it('canonicalizeForIndex ADMITS a namespaced custom capability (not unknown)', () => {
    const out = canonicalizeForIndex(
      ['eta_query', 'com.acme.widget_price', 'plumbing'],
      { 'com.acme.widget_price': { schema_hash: 'cw' } },
      { 'com.acme.widget_price': 'auto', eta_query: 'auto' },
    )
    expect(out.capabilities).toEqual(['eta_query', 'com.acme.widget_price'])
    expect(out.capabilitySchemas).toEqual({ 'com.acme.widget_price': { schema_hash: 'cw' } })
    expect(out.responsePolicy).toEqual({ eta_query: 'auto', 'com.acme.widget_price': 'auto' })
    // truly-unknown (flat, non-registry) still dropped + reported
    expect(out.unknown).toEqual(['plumbing'])
  })
})
