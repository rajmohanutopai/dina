/**
 * Unit tests for the canonical PeerLens dimension registry + resolver.
 * Spec: docs/SERVICES_LAUNCH_ARCHITECTURE.md Part 2.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveCanonicalDimension,
  resolveCategoryKey,
  dimensionsForCategory,
  buildDimensionAliasMap,
  DIMENSION_BY_CATEGORY,
  GENERIC_DIMENSIONS,
  CATEGORY_ALIASES,
  type CanonicalDimension,
} from '../../src/shared/dimension-registry.js'

describe('dimension-registry — resolveCategoryKey', () => {
  it('lowercases + takes the first slash-segment', () => {
    expect(resolveCategoryKey('Furniture/Chair')).toBe('furniture')
    expect(resolveCategoryKey('  DINING  ')).toBe('dining')
  })

  it('maps category aliases that string-normalization alone would miss', () => {
    // home_furniture has no slash — plain normalization leaves it as-is;
    // the alias table is what maps it to `furniture`.
    expect(resolveCategoryKey('home_furniture')).toBe('furniture')
    expect(resolveCategoryKey('Restaurants')).toBe('dining')
    expect(resolveCategoryKey('furnishings')).toBe('furniture')
  })

  it('passes an unknown category through normalized (→ GENERIC fallback)', () => {
    expect(resolveCategoryKey('spaceships')).toBe('spaceships')
  })
})

describe('dimension-registry — resolveCanonicalDimension', () => {
  it('resolves a canonical dimension to itself within its category', () => {
    expect(resolveCanonicalDimension('furniture', 'lumbar_support')).toBe('lumbar_support')
  })

  it('resolves aliases to canonical within the category', () => {
    expect(resolveCanonicalDimension('furniture', 'back_support')).toBe('lumbar_support')
    expect(resolveCanonicalDimension('furniture', 'lumbar')).toBe('lumbar_support')
    expect(resolveCanonicalDimension('furniture/chair', 'lower_back_comfort')).toBe('lumbar_support')
    expect(resolveCanonicalDimension('dining', 'flavour')).toBe('food_quality')
  })

  it('resolves through a category alias', () => {
    expect(resolveCanonicalDimension('home_furniture', 'back_support')).toBe('lumbar_support')
  })

  it('normalizes case + whitespace on the dimension', () => {
    expect(resolveCanonicalDimension('furniture', '  BACK_SUPPORT ')).toBe('lumbar_support')
  })

  it('returns null for an unknown dimension (DROP, not pass-through)', () => {
    expect(resolveCanonicalDimension('furniture', 'rgb_lighting')).toBeNull()
    expect(resolveCanonicalDimension('furniture', '')).toBeNull()
  })

  it('does NOT bleed dimensions across categories', () => {
    // food_quality is a dining dimension, not a furniture one.
    expect(resolveCanonicalDimension('furniture', 'food_quality')).toBeNull()
  })

  it('uses the GENERIC vocabulary for a category with no specific list', () => {
    expect(resolveCanonicalDimension('spaceships', 'value')).toBe('value')
    expect(resolveCanonicalDimension('spaceships', 'value_for_money')).toBe('value')
    expect(resolveCanonicalDimension('spaceships', 'lumbar_support')).toBeNull()
  })
})

describe('dimension-registry — dimensionsForCategory', () => {
  it('returns the specific list for a known category', () => {
    const dims = dimensionsForCategory('furniture').map((d) => d.canonical)
    expect(dims).toContain('lumbar_support')
    expect(dims).toContain('durability')
  })

  it('returns GENERIC for an unknown category', () => {
    expect(dimensionsForCategory('spaceships')).toBe(GENERIC_DIMENSIONS)
  })
})

describe('dimension-registry — invariants', () => {
  it('registries + alias arrays are deeply frozen', () => {
    expect(Object.isFrozen(DIMENSION_BY_CATEGORY)).toBe(true)
    expect(Object.isFrozen(GENERIC_DIMENSIONS)).toBe(true)
    expect(Object.isFrozen(CATEGORY_ALIASES)).toBe(true)
    expect(Object.isFrozen(DIMENSION_BY_CATEGORY.furniture)).toBe(true)
    expect(Object.isFrozen(DIMENSION_BY_CATEGORY.furniture[0])).toBe(true)
    expect(Object.isFrozen(DIMENSION_BY_CATEGORY.furniture[0].aliases)).toBe(true)
  })

  it('no duplicate vocabulary token within any category', () => {
    for (const [cat, dims] of Object.entries(DIMENSION_BY_CATEGORY)) {
      const seen = new Set<string>()
      for (const dim of dims) {
        for (const tok of [dim.canonical, ...dim.aliases]) {
          expect(seen.has(tok), `dup token "${tok}" in ${cat}`).toBe(false)
          seen.add(tok)
        }
      }
    }
  })

  it('per-category sets stay SMALL at launch (≤ 6 each — additive growth later)', () => {
    for (const dims of Object.values(DIMENSION_BY_CATEGORY)) {
      expect(dims.length).toBeLessThanOrEqual(6)
    }
  })
})

describe('dimension-registry — buildDimensionAliasMap fail-loud', () => {
  it('throws on a duplicate alias within a category', () => {
    const bad: CanonicalDimension[] = [
      { canonical: 'a', aliases: ['x'], description: '' },
      { canonical: 'b', aliases: ['x'], description: '' },
    ]
    expect(() => buildDimensionAliasMap(bad)).toThrow(/maps to both/)
  })
})

describe('dimension-registry — cross-workspace drift gate', () => {
  it('appview copy and @dina/protocol copy are byte-identical', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const a = readFileSync(path.resolve(here, '../../src/shared/dimension-registry.ts'))
    const b = readFileSync(
      path.resolve(here, '../../../packages/protocol/src/services/dimension-registry.ts'),
    )
    expect(a.equals(b)).toBe(true)
  })
})
