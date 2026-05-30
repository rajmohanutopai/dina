import { describe, it, expect } from '@jest/globals'

import {
  validateCardSpec,
  linkDisplayHost,
  isCardStale,
  CARD_MAX_BLOCKS,
  CARD_MAX_TEXT,
  CARD_MAX_ITEMS,
  CARD_MAX_TTL_SECONDS,
  CARD_ICONS,
  CARD_TONES,
  type CardSpec,
} from '../../src/services/card-spec'

describe('validateCardSpec — structure & forward-compat', () => {
  it('accepts the rich restaurant card (S4)', () => {
    const spec = validateCardSpec({
      version: 1,
      blocks: [
        { kind: 'title', text: 'Tartine Bakery', icon: 'store', tone: 'accent' },
        { kind: 'keyValue', label: 'Status', value: 'Open now', tone: 'positive' },
        { kind: 'section', label: 'Ratings' },
        { kind: 'bar', label: 'Food', ratio: 0.92, valueLabel: '4.6', tone: 'positive' },
        { kind: 'bar', label: 'Service', ratio: 0.7, valueLabel: '3.5', tone: 'caution' },
        { kind: 'divider' },
        { kind: 'stat', value: '$$', caption: 'Price level' },
        { kind: 'keyValue', label: 'Cuisine', value: 'Bakery · Cafe' },
        { kind: 'body', text: 'Famous for morning buns.' },
        { kind: 'rating', value: 4.3, count: 1280 },
        { kind: 'chips', items: [{ text: 'Vegan' }, { text: 'Wifi', tone: 'info' }] },
        { kind: 'map', label: 'Open in Maps', lat: 37.7615, lng: -122.4241 },
      ],
    })
    expect(spec).not.toBeNull()
    expect(spec!.version).toBe(1)
    expect(spec!.blocks).toHaveLength(12)
  })

  it('accepts list (S10) and timeline (S7)', () => {
    const spec = validateCardSpec({
      version: 1,
      blocks: [
        {
          kind: 'list',
          rows: [
            { text: 'Corner Market', sub: '0.3 mi', trailing: '$0.79', tone: 'positive' },
            { text: 'Safeway', sub: '1.2 mi', trailing: '—', tone: 'critical' },
          ],
        },
        {
          kind: 'timeline',
          steps: [
            { label: 'Ordered', state: 'done' },
            { label: 'Out for delivery', state: 'active' },
            { label: 'Delivered', state: 'upcoming' },
          ],
        },
      ],
    })
    expect(spec!.blocks).toHaveLength(2)
    expect((spec!.blocks[0] as any).rows).toHaveLength(2)
    expect((spec!.blocks[1] as any).steps[1].state).toBe('active')
  })

  it('rejects non-objects / wrong version / non-array blocks / empty', () => {
    expect(validateCardSpec(null)).toBeNull()
    expect(validateCardSpec({ version: 2, blocks: [{ kind: 'body', text: 'x' }] })).toBeNull()
    expect(validateCardSpec({ version: 1, blocks: 'no' })).toBeNull()
    expect(validateCardSpec({ version: 1, blocks: [] })).toBeNull()
    expect(validateCardSpec({ version: 1, blocks: [{ kind: 'nope' }] })).toBeNull()
  })

  it('DROPS unknown block kinds incl. image (forward-compat)', () => {
    const spec = validateCardSpec({
      version: 1,
      blocks: [
        { kind: 'title', text: 'Keep' },
        { kind: 'image', url: 'https://evil/x.png' },
        { kind: 'chart', data: [1, 2] },
        { kind: 'body', text: 'Keep too' },
      ],
    })
    expect(spec!.blocks.map((b) => b.kind)).toEqual(['title', 'body'])
  })

  it('ignores unknown TOP-LEVEL fields (forward-compat)', () => {
    const spec = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'body', text: 'hi' }],
      profile: 'commerce',
      features: ['x'],
      provenance: { who: 'future' },
    })
    expect(spec).not.toBeNull()
    expect((spec as any).profile).toBeUndefined()
  })
})

describe('validateCardSpec — trust badges are Dina-owned (§7)', () => {
  it('DROPS badge blocks on the untrusted (default) path', () => {
    const spec = validateCardSpec({
      version: 1,
      blocks: [
        { kind: 'badge', text: 'Verified seller', tone: 'positive' },
        { kind: 'keyValue', label: 'Status', value: 'In stock', tone: 'positive' },
      ],
    })
    expect(spec!.blocks.map((b) => b.kind)).toEqual(['keyValue'])
  })

  it('KEEPS badge blocks only when trusted: true', () => {
    const spec = validateCardSpec(
      { version: 1, blocks: [{ kind: 'badge', text: 'Disputed', tone: 'critical' }] },
      { trusted: true },
    )
    expect(spec!.blocks).toEqual([{ kind: 'badge', text: 'Disputed', tone: 'critical' }])
  })
})

describe('validateCardSpec — map carries structured location, never a URL (§8)', () => {
  it('keeps in-range coords; strips a url field if supplied', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'map', label: 'Maps', lat: 37.77, lng: -122.42, url: 'https://evil/maps' }],
    })
    expect(s!.blocks[0]).toEqual({ kind: 'map', label: 'Maps', lat: 37.77, lng: -122.42 })
    expect((s!.blocks[0] as any).url).toBeUndefined()
  })
  it('falls back to query when coords are out of range', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'map', label: 'Maps', lat: 999, lng: 0, query: 'SF Ferry Building' }],
    })
    const m = s!.blocks[0] as any
    expect(m.lat).toBeUndefined()
    expect(m.query).toBe('SF Ferry Building')
  })
  it('drops a map with neither coords nor query', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'map', label: 'Maps' }, { kind: 'title', text: 'keep' }],
    })
    expect(s!.blocks.map((b) => b.kind)).toEqual(['title'])
  })
})

describe('validateCardSpec — link URL hardening (§8)', () => {
  it('keeps a clean absolute https url + forces action open_url', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'link', label: 'Menu', url: 'https://shop.example.com/menu' }],
    })
    expect(s!.blocks[0]).toEqual({
      kind: 'link',
      label: 'Menu',
      url: 'https://shop.example.com/menu',
      action: 'open_url',
    })
  })

  it.each([
    ['http (not https)', 'http://example.com'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<x>'],
    ['file', 'file:///etc/passwd'],
    ['protocol-relative', '//example.com'],
    ['relative', '/path'],
    ['embedded credentials', 'https://user:pass@example.com'],
    ['localhost', 'https://localhost/x'],
    ['.local mDNS', 'https://printer.local/x'],
    ['loopback IP', 'https://127.0.0.1/x'],
    ['private 10/8', 'https://10.0.0.5/x'],
    ['private 192.168', 'https://192.168.1.1/x'],
    ['private 172.16/12', 'https://172.16.0.1/x'],
    ['link-local', 'https://169.254.1.1/x'],
    ['CGNAT', 'https://100.64.0.1/x'],
    ['odd port', 'https://example.com:8443/x'],
    ['bare single-label host', 'https://intranet/x'],
    ['IPv6 literal', 'https://[::1]/x'],
  ])('drops unsafe link: %s', (_label, url) => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'link', label: 'Go', url }, { kind: 'title', text: 'keep' }],
    })
    expect(s!.blocks.map((b) => b.kind)).toEqual(['title'])
  })

  it('allows a public IPv4 literal on :443 (rare but not unsafe)', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'link', label: 'Go', url: 'https://93.184.216.34/x' }],
    })
    expect(s!.blocks).toHaveLength(1)
  })
})

describe('validateCardSpec — media is blob-CID only (§9)', () => {
  it('keeps a well-formed blob media block; no url survives', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [
        {
          kind: 'media',
          did: 'did:plc:abc123',
          cid: 'bafyblobcid',
          alt: 'Product photo',
          aspect: '4:3',
          url: 'https://evil/x.png',
        },
      ],
    })
    expect(s!.blocks[0]).toEqual({
      kind: 'media',
      did: 'did:plc:abc123',
      cid: 'bafyblobcid',
      alt: 'Product photo',
      aspect: '4:3',
    })
    expect((s!.blocks[0] as any).url).toBeUndefined()
  })
  it('drops media missing did/cid/alt or with a bad did', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [
        { kind: 'media', cid: 'x', alt: 'a' },
        { kind: 'media', did: 'not-a-did', cid: 'x', alt: 'a' },
        { kind: 'media', did: 'did:plc:ok', cid: 'x' },
        { kind: 'title', text: 'keep' },
      ],
    })
    expect(s!.blocks.map((b) => b.kind)).toEqual(['title'])
  })
})

describe('validateCardSpec — numeric clamping', () => {
  it.each([
    [-0.5, 0],
    [0.42, 0.42],
    [3.7, 1],
  ])('bar.ratio %p → %p', (input, expected) => {
    const s = validateCardSpec({ version: 1, blocks: [{ kind: 'bar', ratio: input }] })
    expect((s!.blocks[0] as any).ratio).toBe(expected)
  })
  it.each([
    [-1, 0],
    [4.3, 4.3],
    [9, 5],
  ])('rating.value %p → %p', (input, expected) => {
    const s = validateCardSpec({ version: 1, blocks: [{ kind: 'rating', value: input }] })
    expect((s!.blocks[0] as any).value).toBe(expected)
  })
  it('drops bar with non-numeric ratio / rating with non-numeric value', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [
        { kind: 'bar', ratio: 'high' },
        { kind: 'rating', value: 'five' },
        { kind: 'title', text: 'keep' },
      ],
    })
    expect(s!.blocks.map((b) => b.kind)).toEqual(['title'])
  })
})

describe('validateCardSpec — caps & icon/tone', () => {
  it('truncates over-long text + caps blocks + caps items', () => {
    const long = 'a'.repeat(CARD_MAX_TEXT + 500)
    const s1 = validateCardSpec({ version: 1, blocks: [{ kind: 'body', text: long }] })
    expect((s1!.blocks[0] as any).text.length).toBe(CARD_MAX_TEXT)

    const many = Array.from({ length: CARD_MAX_BLOCKS + 10 }, (_, i) => ({
      kind: 'body' as const,
      text: `b${i}`,
    }))
    expect(validateCardSpec({ version: 1, blocks: many })!.blocks).toHaveLength(CARD_MAX_BLOCKS)

    const chips = Array.from({ length: CARD_MAX_ITEMS + 5 }, (_, i) => ({ text: `c${i}` }))
    const cs = validateCardSpec({ version: 1, blocks: [{ kind: 'chips', items: chips }] })
    expect((cs!.blocks[0] as any).items).toHaveLength(CARD_MAX_ITEMS)
  })

  it('drops unknown icon/tone but keeps the block; keeps all valid enums', () => {
    const bad = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'title', text: 'T', icon: 'made_up', tone: 'rainbow' }],
    })
    expect(bad!.blocks[0]).toEqual({ kind: 'title', text: 'T' })
    for (const icon of CARD_ICONS) {
      const s = validateCardSpec({ version: 1, blocks: [{ kind: 'title', text: 'T', icon }] })
      expect((s!.blocks[0] as any).icon).toBe(icon)
    }
    for (const tone of CARD_TONES) {
      const s = validateCardSpec({ version: 1, blocks: [{ kind: 'stat', value: 'v', tone }] })
      expect((s!.blocks[0] as any).tone).toBe(tone)
    }
  })
})

describe('validateCardSpec — staleness fields (§10)', () => {
  it('keeps valid generatedAt/expiresAt/ttl/sourceLabel; clamps ttl', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'stat', value: '$0.79' }],
      generatedAt: '2026-05-30T08:00:00.000Z',
      expiresAt: '2026-05-30T08:05:00.000Z',
      ttlSeconds: CARD_MAX_TTL_SECONDS + 999,
      sourceLabel: '15-min delayed',
    })
    expect(s!.generatedAt).toBe('2026-05-30T08:00:00.000Z')
    expect(s!.expiresAt).toBe('2026-05-30T08:05:00.000Z')
    expect(s!.ttlSeconds).toBe(CARD_MAX_TTL_SECONDS)
    expect(s!.sourceLabel).toBe('15-min delayed')
  })
  it('drops unparseable timestamps + non-positive ttl', () => {
    const s = validateCardSpec({
      version: 1,
      blocks: [{ kind: 'stat', value: 'x' }],
      generatedAt: 'not-a-date',
      ttlSeconds: -5,
    })
    expect(s!.generatedAt).toBeUndefined()
    expect(s!.ttlSeconds).toBeUndefined()
  })
})

describe('isCardStale', () => {
  const base: CardSpec = { version: 1, blocks: [{ kind: 'stat', value: 'x' }] }
  it('false when no expiry info', () => {
    expect(isCardStale(base, Date.parse('2026-05-30T09:00:00Z'))).toBe(false)
  })
  it('true past expiresAt', () => {
    const s: CardSpec = { ...base, expiresAt: '2026-05-30T08:00:00Z' }
    expect(isCardStale(s, Date.parse('2026-05-30T08:00:01Z'))).toBe(true)
    expect(isCardStale(s, Date.parse('2026-05-30T07:59:59Z'))).toBe(false)
  })
  it('true past generatedAt + ttlSeconds', () => {
    const s: CardSpec = { ...base, generatedAt: '2026-05-30T08:00:00Z', ttlSeconds: 60 }
    expect(isCardStale(s, Date.parse('2026-05-30T08:01:01Z'))).toBe(true)
    expect(isCardStale(s, Date.parse('2026-05-30T08:00:30Z'))).toBe(false)
  })
})

describe('linkDisplayHost', () => {
  it('returns host without www; empty on garbage', () => {
    expect(linkDisplayHost('https://www.example.com/p?q=1')).toBe('example.com')
    expect(linkDisplayHost('https://maps.google.com/q')).toBe('maps.google.com')
    expect(linkDisplayHost('HTTPS://UP.example.com')).toBe('up.example.com')
    expect(linkDisplayHost('garbage')).toBe('')
  })
})

it('round-trips a validated spec (idempotent), incl. trusted badge', () => {
  const once = validateCardSpec(
    {
      version: 1,
      blocks: [
        { kind: 'title', text: 'T', icon: 'price', tone: 'accent' },
        { kind: 'badge', text: 'Disputed', tone: 'critical' },
        { kind: 'rating', value: 4, count: 10 },
        { kind: 'link', label: 'Go', url: 'https://x.example.com/a' },
      ],
      generatedAt: '2026-05-30T08:00:00.000Z',
    },
    { trusted: true },
  ) as CardSpec
  expect(validateCardSpec(once, { trusted: true })).toEqual(once)
})
