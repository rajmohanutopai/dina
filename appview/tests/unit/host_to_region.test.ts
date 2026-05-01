/**
 * `host_to_region` — TLD heuristic + per-host override coverage
 * (TN-V2-META-007 / TN-V2-TEST-003).
 *
 * Scope:
 *   - Override map takes priority over TLD heuristic.
 *   - ccTLD heuristic resolves the documented codes (with the
 *     `.uk` → `GB` exception explicitly pinned).
 *   - Edge inputs (null, empty, unknown TLD, URL with path) all
 *     map to a defined null vs. matched value — no exceptions.
 */

import { describe, expect, it } from 'vitest'

import { hostToRegion, curatedRegionCount } from '@/util/host_to_region'

describe('hostToRegion — per-host overrides (priority)', () => {
  it('amazon.com → US (`.com` is region-neutral; override required)', () => {
    expect(hostToRegion('amazon.com')).toBe('US')
    expect(hostToRegion('https://amazon.com/dp/B07X1234Y5')).toBe('US')
    expect(hostToRegion('https://www.amazon.com/dp/X')).toBe('US')
  })

  it('amazon.co.uk → GB (override matches the TLD heuristic anyway, locking it in)', () => {
    expect(hostToRegion('amazon.co.uk')).toBe('GB')
  })

  it('amazon.de → DE / amazon.fr → FR / amazon.in → IN', () => {
    expect(hostToRegion('amazon.de')).toBe('DE')
    expect(hostToRegion('amazon.fr')).toBe('FR')
    expect(hostToRegion('amazon.in')).toBe('IN')
  })

  it('amazon.co.jp → JP (ccTLD `.jp` would also give JP, override pins it)', () => {
    expect(hostToRegion('amazon.co.jp')).toBe('JP')
  })

  it('amazon.com.au → AU / amazon.com.br → BR / amazon.com.mx → MX', () => {
    expect(hostToRegion('amazon.com.au')).toBe('AU')
    expect(hostToRegion('amazon.com.br')).toBe('BR')
    expect(hostToRegion('amazon.com.mx')).toBe('MX')
  })

  it('etsy.com / ebay.com / bestbuy.com / target.com / walmart.com → US (overrides on `.com`)', () => {
    for (const host of ['etsy.com', 'ebay.com', 'bestbuy.com', 'target.com', 'walmart.com']) {
      expect(hostToRegion(host)).toBe('US')
    }
  })

  it('flipkart.com → IN (Indian commerce on `.com`; override required)', () => {
    expect(hostToRegion('flipkart.com')).toBe('IN')
  })

  it('rakuten.co.jp → JP', () => {
    expect(hostToRegion('rakuten.co.jp')).toBe('JP')
  })

  it('mercadolivre.com.br → BR', () => {
    expect(hostToRegion('mercadolivre.com.br')).toBe('BR')
  })
})

describe('hostToRegion — ccTLD heuristic', () => {
  it('.uk → GB (TLD code differs from country code)', () => {
    // Pinned in its own test because the TLD/country-code mismatch
    // is the most common bug class for region inference.
    expect(hostToRegion('bbc.co.uk')).toBe('GB')
    expect(hostToRegion('https://www.theguardian.co.uk/news')).toBe('GB')
  })

  it('European ccTLDs resolve to their ISO codes', () => {
    expect(hostToRegion('zalando.de')).toBe('DE')
    expect(hostToRegion('lemonde.fr')).toBe('FR')
    expect(hostToRegion('repubblica.it')).toBe('IT')
    expect(hostToRegion('elpais.es')).toBe('ES')
    expect(hostToRegion('volkskrant.nl')).toBe('NL')
    expect(hostToRegion('aftonbladet.se')).toBe('SE')
    expect(hostToRegion('vg.no')).toBe('NO')
  })

  it('Asian ccTLDs resolve', () => {
    expect(hostToRegion('hotstar.in')).toBe('IN')
    expect(hostToRegion('asahi.jp')).toBe('JP')
    expect(hostToRegion('naver.kr')).toBe('KR')
    expect(hostToRegion('weibo.cn')).toBe('CN')
    expect(hostToRegion('singpost.sg')).toBe('SG')
  })

  it('Oceania ccTLDs resolve', () => {
    expect(hostToRegion('abc.au')).toBe('AU')
    expect(hostToRegion('rnz.nz')).toBe('NZ')
  })

  it('Americas ccTLDs resolve', () => {
    expect(hostToRegion('cbc.ca')).toBe('CA')
    expect(hostToRegion('uol.br')).toBe('BR')
    expect(hostToRegion('clarin.ar')).toBe('AR')
  })

  it('returns null for unknown TLDs (no greedy fallback to US)', () => {
    // A `.com` host without an override has no region signal.
    // Returning null lets the caller distinguish "no signal" from
    // "signal is US"; never silently default to US.
    expect(hostToRegion('news.example.com')).toBeNull()
    expect(hostToRegion('https://github.com/foo/bar')).toBeNull()
    expect(hostToRegion('news.example.io')).toBeNull()
    expect(hostToRegion('site.xyz')).toBeNull()
  })
})

describe('hostToRegion — input edge cases', () => {
  it('null / undefined / empty / non-string → null', () => {
    expect(hostToRegion(null)).toBeNull()
    expect(hostToRegion(undefined)).toBeNull()
    expect(hostToRegion('')).toBeNull()
    expect(hostToRegion('   ')).toBeNull()
  })

  it('strips scheme + path + query before looking up', () => {
    expect(hostToRegion('https://www.amazon.co.uk/dp/X?ref=foo')).toBe('GB')
    expect(hostToRegion('http://etsy.com/listing/123')).toBe('US')
  })

  it('strips port', () => {
    expect(hostToRegion('amazon.com:443')).toBe('US')
    expect(hostToRegion('https://etsy.com:8443/dp')).toBe('US')
  })

  it('case-insensitive on host', () => {
    expect(hostToRegion('AMAZON.CO.UK')).toBe('GB')
    expect(hostToRegion('Etsy.Com')).toBe('US')
  })

  it('strips leading m. (mobile subdomain)', () => {
    expect(hostToRegion('m.flipkart.com')).toBe('IN')
  })

  it('host with no dots → null', () => {
    expect(hostToRegion('localhost')).toBeNull()
    expect(hostToRegion('myhost')).toBeNull()
  })

  it('trailing dot does not break lookup', () => {
    // `normalizeHost` doesn't strip trailing dots; `lastIndexOf('.')`
    // returning the trailing dot would yield an empty TLD slice.
    // Behaviour: empty TLD → null (no region). Pin it so we don't
    // regress to throwing or matching a random map entry.
    expect(hostToRegion('amazon.com.')).toBeNull()
  })
})

describe('hostToRegion — purity + budget', () => {
  it('repeated calls return the same answer (no hidden state)', () => {
    const a1 = hostToRegion('amazon.com')
    const a2 = hostToRegion('amazon.com')
    const b1 = hostToRegion('bbc.co.uk')
    const b2 = hostToRegion('bbc.co.uk')
    expect(a1).toBe(a2)
    expect(b1).toBe(b2)
    expect(a1).toBe('US')
    expect(b1).toBe('GB')
  })

  it('returns ISO 3166-1 alpha-2 codes (uppercase, 2 chars) for every defined entry', () => {
    const samples = [
      'amazon.com', 'amazon.co.uk', 'amazon.de', 'flipkart.com', 'etsy.com',
      'bbc.co.uk', 'lemonde.fr', 'naver.kr', 'cbc.ca', 'abc.au',
    ]
    for (const host of samples) {
      const r = hostToRegion(host)
      expect(r).toMatch(/^[A-Z]{2}$/)
    }
  })

  it('curated map count is reasonable (budget pin)', () => {
    const { overrides, tlds } = curatedRegionCount()
    // Pin a soft upper bound so the map doesn't bloat by accident.
    // If you legitimately need more entries, raise the bound and
    // call out the addition in the PR.
    expect(overrides).toBeGreaterThan(15)
    expect(overrides).toBeLessThan(60)
    expect(tlds).toBeGreaterThan(30)
    expect(tlds).toBeLessThan(80)
  })
})
