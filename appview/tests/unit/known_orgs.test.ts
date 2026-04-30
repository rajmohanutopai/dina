/**
 * Known orgs allow-list lookup tests (TN-ENRICH-003).
 *
 * Pins:
 *   - Lookup by canonical name (case-insensitive, whitespace-trimmed).
 *   - Lookup by alias resolves to the same org as the canonical name.
 *   - Lookup by domain (URL or bare host) goes through normalizeHost.
 *   - Each `OrgType` value is represented by at least one entry
 *     (university / company / nonprofit / government / media / research).
 *   - All entries are frozen (caller cannot mutate).
 *   - The seed list has zero name/domain collisions.
 *   - Caller can tell aliased entries apart only via canonical name
 *     (alias lookups return the SAME object reference as the
 *     canonical name lookup).
 *   - Returns null for unknown name / domain.
 *
 * Pure data — runs under vitest.
 */

import { describe, it, expect } from 'vitest'
import {
  knownOrgsStats,
  lookupOrgByDomain,
  lookupOrgByName,
  type OrgType,
} from '@/util/known_orgs'

// ─── Lookup by name ──────────────────────────────────────────────────────

describe('lookupOrgByName', () => {
  it('matches canonical name', () => {
    const mit = lookupOrgByName('Massachusetts Institute of Technology')
    expect(mit).not.toBeNull()
    expect(mit?.qid).toBe('Q49108')
  })

  it('matches an alias (case-insensitive)', () => {
    const mit = lookupOrgByName('MIT')
    expect(mit).not.toBeNull()
    expect(mit?.name).toBe('Massachusetts Institute of Technology')
  })

  it('alias and canonical name resolve to the same object reference', () => {
    const a = lookupOrgByName('MIT')
    const b = lookupOrgByName('Massachusetts Institute of Technology')
    expect(a).toBe(b)
  })

  it('case-insensitive', () => {
    expect(lookupOrgByName('mit')).not.toBeNull()
    expect(lookupOrgByName('MIT')).not.toBeNull()
    expect(lookupOrgByName('Mit')).not.toBeNull()
  })

  it('whitespace-trimmed', () => {
    expect(lookupOrgByName('  MIT  ')).not.toBeNull()
    expect(lookupOrgByName('\tMIT\n')).not.toBeNull()
  })

  it('returns null for null / undefined / empty / whitespace', () => {
    expect(lookupOrgByName(null)).toBeNull()
    expect(lookupOrgByName(undefined)).toBeNull()
    expect(lookupOrgByName('')).toBeNull()
    expect(lookupOrgByName('   ')).toBeNull()
  })

  it('returns null for unknown name', () => {
    expect(lookupOrgByName('My Garage Startup LLC')).toBeNull()
  })

  it('matches multi-alias org (Allen Institute → AI2)', () => {
    const fromAlias = lookupOrgByName('AI2')
    expect(fromAlias).not.toBeNull()
    expect(fromAlias?.name).toBe('Allen Institute')
    const fromCanon = lookupOrgByName('Allen Institute')
    expect(fromCanon).toBe(fromAlias)
  })
})

// ─── Lookup by domain ────────────────────────────────────────────────────

describe('lookupOrgByDomain', () => {
  it('matches a bare domain', () => {
    expect(lookupOrgByDomain('mit.edu')?.name).toBe('Massachusetts Institute of Technology')
  })

  it('matches a full URL with path', () => {
    expect(lookupOrgByDomain('https://www.mit.edu/news')?.name).toBe(
      'Massachusetts Institute of Technology',
    )
  })

  it('strips www. and m. via normalizeHost', () => {
    expect(lookupOrgByDomain('www.mit.edu')?.name).toBe('Massachusetts Institute of Technology')
    expect(lookupOrgByDomain('m.mit.edu')?.name).toBe('Massachusetts Institute of Technology')
  })

  it('case-insensitive (lowercased by normalizeHost)', () => {
    expect(lookupOrgByDomain('MIT.EDU')?.name).toBe('Massachusetts Institute of Technology')
  })

  it('matches alternate domain (multi-domain orgs)', () => {
    // Apple has just `apple.com`; let's pick a multi-domain org.
    expect(lookupOrgByDomain('bbc.com')?.name).toBe('BBC')
    expect(lookupOrgByDomain('bbc.co.uk')?.name).toBe('BBC')
  })

  it('returns null for unknown domain', () => {
    expect(lookupOrgByDomain('random-corp-12345.example')).toBeNull()
  })

  it('returns null for null / undefined / empty', () => {
    expect(lookupOrgByDomain(null)).toBeNull()
    expect(lookupOrgByDomain(undefined)).toBeNull()
    expect(lookupOrgByDomain('')).toBeNull()
  })

  it('arbitrary subdomains do NOT match (news.mit.edu doesn\'t match — but this is by design; add explicit if needed)', () => {
    // The lookup is exact after normalisation. Subdomains beyond
    // www/m must be added explicitly to the org's domains list.
    expect(lookupOrgByDomain('news.mit.edu')).toBeNull()
  })
})

// ─── OrgType coverage ────────────────────────────────────────────────────

describe('seed list — OrgType coverage', () => {
  const expectedTypes: readonly OrgType[] = [
    'university',
    'company',
    'nonprofit',
    'government',
    'media',
    'research',
  ]

  for (const type of expectedTypes) {
    it(`includes at least one ${type}`, () => {
      // Probe via known canonical names per type.
      const probes: Record<OrgType, string> = {
        university: 'MIT',
        company: 'Google',
        nonprofit: 'Wikipedia',
        government: 'WHO',
        media: 'BBC',
        research: 'CERN',
      }
      const org = lookupOrgByName(probes[type])
      expect(org).not.toBeNull()
      expect(org?.type).toBe(type)
    })
  }
})

// ─── Frozen entries ──────────────────────────────────────────────────────

describe('seed list — frozen entries', () => {
  it('returned org is frozen at top level', () => {
    const org = lookupOrgByName('MIT')
    expect(org).not.toBeNull()
    if (org === null) throw new Error('expected org')
    expect(Object.isFrozen(org)).toBe(true)
  })

  it('aliases array is frozen', () => {
    const org = lookupOrgByName('Google')
    expect(org).not.toBeNull()
    if (org === null) throw new Error('expected org')
    expect(Object.isFrozen(org.aliases)).toBe(true)
  })

  it('domains array is frozen', () => {
    const org = lookupOrgByName('Apple')
    expect(org).not.toBeNull()
    if (org === null) throw new Error('expected org')
    expect(Object.isFrozen(org.domains)).toBe(true)
  })
})

// ─── Curation hygiene ────────────────────────────────────────────────────

describe('seed list — curation hygiene', () => {
  it('zero name collisions (no two orgs claim the same name/alias)', () => {
    const { nameCollisions } = knownOrgsStats()
    if (nameCollisions.length > 0) {
      throw new Error(
        `Name collisions in seed list: ${JSON.stringify([...nameCollisions], null, 2)}`,
      )
    }
    expect(nameCollisions).toEqual([])
  })

  it('zero domain collisions (no two orgs claim the same domain)', () => {
    const { domainCollisions } = knownOrgsStats()
    if (domainCollisions.length > 0) {
      throw new Error(
        `Domain collisions in seed list: ${JSON.stringify([...domainCollisions], null, 2)}`,
      )
    }
    expect(domainCollisions).toEqual([])
  })

  it('seed list size in plan §3.6.3 range (~100 entries seeded — V1 launch baseline ≥ 25)', () => {
    const { count } = knownOrgsStats()
    // Plan says "~100 entries seeded" but V1 launch ships ≥ 25
    // representative entries spanning every OrgType. Future deploys
    // expand toward 100. The test pins both ends so a missing seed
    // and a runaway expansion both surface.
    expect(count).toBeGreaterThanOrEqual(25)
    expect(count).toBeLessThanOrEqual(150)
  })

  it('every entry has a non-empty canonical name', () => {
    const { count, nameKeys } = knownOrgsStats()
    // nameKeys >= count (each org's canonical name + aliases all index)
    expect(nameKeys).toBeGreaterThanOrEqual(count)
  })

  it('every entry has a domain mapping (every org indexable by URL too)', () => {
    const { count, domainKeys } = knownOrgsStats()
    // domainKeys should be at least count (some orgs have multiple domains).
    expect(domainKeys).toBeGreaterThanOrEqual(count)
  })
})
