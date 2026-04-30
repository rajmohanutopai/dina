/**
 * Host category lookup tests (TN-ENRICH-001).
 *
 * Pins:
 *   - Each documented entry from plan §3.6.3 produces the
 *     documented `category` + `media_type` (regression-pinned for
 *     YouTube, Medium, Twitter, etc.).
 *   - Unknown hosts return `null` — caller composes the
 *     `category='content', host=<host>` default per plan line 1274.
 *   - Wildcard `*.blog` matches any subdomain ending in `.blog` but
 *     NOT `blog.com`.
 *   - `normalizeHost` strips scheme / path / query / fragment / port
 *     / user-info / leading `www.` / leading `m.` / lowercases.
 *   - Seed list size stays in the plan's ~50 budget so future
 *     expansions stay scoped.
 *   - Frozen entries — caller can't poison the map.
 *
 * Pure data — runs under vitest, no AppView runtime deps.
 */

import { describe, it, expect } from 'vitest'
import { curatedHostCount, lookupHost, normalizeHost } from '@/util/host_category'

// ─── normalizeHost ────────────────────────────────────────────────────────

describe('normalizeHost', () => {
  it('returns null for empty / non-string input', () => {
    expect(normalizeHost(null)).toBeNull()
    expect(normalizeHost(undefined)).toBeNull()
    expect(normalizeHost('')).toBeNull()
    expect(normalizeHost('   ')).toBeNull()
  })

  it('strips https:// scheme', () => {
    expect(normalizeHost('https://youtube.com/watch?v=abc')).toBe('youtube.com')
  })

  it('strips http:// scheme', () => {
    expect(normalizeHost('http://example.com/page')).toBe('example.com')
  })

  it('strips at:// scheme (and other custom schemes)', () => {
    expect(normalizeHost('at://did:plc:author/com.dina.trust.attestation/abc')).toBe(
      'did:plc:author',
    )
  })

  it('strips leading www.', () => {
    expect(normalizeHost('www.youtube.com')).toBe('youtube.com')
  })

  it('strips leading m. (mobile)', () => {
    expect(normalizeHost('m.youtube.com')).toBe('youtube.com')
  })

  it('does NOT strip arbitrary subdomains (e.g. news.mit.edu stays as-is)', () => {
    expect(normalizeHost('news.mit.edu')).toBe('news.mit.edu')
  })

  it('lowercases', () => {
    expect(normalizeHost('YouTube.COM')).toBe('youtube.com')
  })

  it('strips port', () => {
    expect(normalizeHost('example.com:8080/api')).toBe('example.com')
  })

  it('strips user info (user:pass@host)', () => {
    expect(normalizeHost('https://user:pass@example.com/page')).toBe('example.com')
  })

  it('strips path', () => {
    expect(normalizeHost('https://medium.com/@user/post-123')).toBe('medium.com')
  })

  it('strips query string', () => {
    expect(normalizeHost('youtube.com?v=abc')).toBe('youtube.com')
  })

  it('strips fragment', () => {
    expect(normalizeHost('youtube.com#section')).toBe('youtube.com')
  })

  it('handles bare host (no scheme)', () => {
    expect(normalizeHost('youtube.com')).toBe('youtube.com')
  })

  it('returns null for whitespace-only input', () => {
    expect(normalizeHost('  \t  ')).toBeNull()
  })
})

// ─── lookupHost — documented plan §3.6.3 entries ─────────────────────────

describe('lookupHost — plan §3.6.3 documented entries', () => {
  it('youtube.com → video', () => {
    expect(lookupHost('youtube.com')).toEqual({ category: 'content', media_type: 'video' })
  })

  it('youtu.be → video', () => {
    expect(lookupHost('youtu.be')).toEqual({ category: 'content', media_type: 'video' })
  })

  it('medium.com → article', () => {
    expect(lookupHost('medium.com')).toEqual({ category: 'content', media_type: 'article' })
  })

  it('substack.com → article', () => {
    expect(lookupHost('substack.com')).toEqual({ category: 'content', media_type: 'article' })
  })

  it('twitter.com → social_post', () => {
    expect(lookupHost('twitter.com')).toEqual({ category: 'content', media_type: 'social_post' })
  })

  it('x.com → social_post', () => {
    expect(lookupHost('x.com')).toEqual({ category: 'content', media_type: 'social_post' })
  })

  it('bsky.app → social_post', () => {
    expect(lookupHost('bsky.app')).toEqual({ category: 'content', media_type: 'social_post' })
  })
})

// ─── lookupHost — URL inputs (real-world payloads) ───────────────────────

describe('lookupHost — URL inputs', () => {
  it('matches a full YouTube URL with query string', () => {
    expect(lookupHost('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      category: 'content',
      media_type: 'video',
    })
  })

  it('matches a Medium URL with path', () => {
    expect(lookupHost('https://medium.com/@user/some-post-123')).toEqual({
      category: 'content',
      media_type: 'article',
    })
  })

  it('matches a Reddit URL (forum)', () => {
    expect(lookupHost('https://www.reddit.com/r/programming/comments/abc')).toEqual({
      category: 'content',
      media_type: 'forum',
    })
  })

  it('matches a github.com URL (code)', () => {
    expect(lookupHost('https://github.com/torvalds/linux')).toEqual({
      category: 'content',
      media_type: 'code',
    })
  })

  it('matches a stackoverflow URL (forum)', () => {
    expect(lookupHost('https://stackoverflow.com/questions/123')).toEqual({
      category: 'content',
      media_type: 'forum',
    })
  })
})

// ─── lookupHost — wildcards ──────────────────────────────────────────────

describe('lookupHost — wildcard suffixes', () => {
  it('*.blog matches arbitrary blog subdomain', () => {
    expect(lookupHost('mike.blog')).toEqual({ category: 'content', media_type: 'article' })
    expect(lookupHost('kara.blog')).toEqual({ category: 'content', media_type: 'article' })
    expect(lookupHost('foo.bar.blog')).toEqual({ category: 'content', media_type: 'article' })
  })

  it('*.blog does NOT match blog.com (suffix is `.blog`, not `blog`)', () => {
    expect(lookupHost('blog.com')).toBeNull()
  })

  it('*.tumblr.com matches tumblr-hosted blogs', () => {
    expect(lookupHost('https://example.tumblr.com/post/123')).toEqual({
      category: 'content',
      media_type: 'article',
    })
  })

  it('*.substack.com matches substack-hosted publications', () => {
    expect(lookupHost('https://stratechery.substack.com')).toEqual({
      category: 'content',
      media_type: 'article',
    })
  })

  it('exact `substack.com` and wildcard `*.substack.com` both match (different inputs)', () => {
    expect(lookupHost('substack.com')).toEqual({ category: 'content', media_type: 'article' })
    expect(lookupHost('foo.substack.com')).toEqual({ category: 'content', media_type: 'article' })
  })
})

// ─── lookupHost — unknown hosts ──────────────────────────────────────────

describe('lookupHost — unknown hosts', () => {
  it('returns null for an unknown host (caller composes default)', () => {
    expect(lookupHost('random-site-12345.example')).toBeNull()
  })

  it('returns null for null / undefined / empty input', () => {
    expect(lookupHost(null)).toBeNull()
    expect(lookupHost(undefined)).toBeNull()
    expect(lookupHost('')).toBeNull()
  })

  it('does NOT silently fork on a near-miss (notyoutube.com is unknown, not video)', () => {
    expect(lookupHost('notyoutube.com')).toBeNull()
  })
})

// ─── Frozen entries ──────────────────────────────────────────────────────

describe('lookupHost — entries are frozen', () => {
  it('returned entry is frozen (caller mutation cannot poison the map)', () => {
    const entry = lookupHost('youtube.com')
    expect(entry).not.toBeNull()
    if (entry === null) throw new Error('expected entry')
    expect(Object.isFrozen(entry)).toBe(true)
  })

  it('two lookups for the same host return the same frozen reference', () => {
    const a = lookupHost('youtube.com')
    const b = lookupHost('YouTube.COM')
    expect(a).toBe(b)
  })
})

// ─── Curation budget ──────────────────────────────────────────────────────

describe('lookupHost — curation budget', () => {
  it('seed list stays in the plan §3.6.3 ~50 budget (regression guard)', () => {
    const { exact, wildcards } = curatedHostCount()
    // Plan says "~50 entries". Total = exact + wildcard rules.
    // We pin a generous bound so adding entries up to the budget
    // is fine, but a runaway expansion fails the test.
    const total = exact + wildcards
    expect(total).toBeGreaterThan(20)
    expect(total).toBeLessThanOrEqual(80)
  })
})
