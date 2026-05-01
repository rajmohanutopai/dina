/**
 * handle_picker — Bluesky-style availability check + suggestions.
 *
 * Covers the public API surface end to end with mocked fetch + injected
 * RNG/year so the suggestion order is deterministic.
 */

import {
  checkHandleAvailability,
  generateCandidates,
  pickHandle,
  sanitizeHandlePrefix,
  validateHandleFormat,
  type PickerOptions,
} from '../../src/identity/handle_picker';

const PDS_URL = 'https://test-pds.dinakernel.com';
const PDS_HOST = 'test-pds.dinakernel.com';

/**
 * Build a fetch mock that maps `handle` query params to a HTTP status
 * (and optional `did` body). Captures calls for later assertions.
 */
function buildFetch(
  responses: Record<string, { status: number; did?: string }>,
): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (jest.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const handleParam = decodeURIComponent(
      new URL(url).searchParams.get('handle') ?? '',
    );
    calls.push(handleParam);
    const r = responses[handleParam] ?? { status: 400 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => (r.did !== undefined ? { did: r.did } : {}),
      text: async () => JSON.stringify(r.did !== undefined ? { did: r.did } : {}),
    } as unknown as Response;
  }) as unknown) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

/** Fixed RNG — emits the next pre-seeded value each call. Wraps. */
function fixedRandom(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };
}

describe('sanitizeHandlePrefix', () => {
  it.each<[string, string]>([
    ['Raju', 'raju'],
    ['  Hello World  ', 'helloworld'],
    ['raju.h', 'rajuh'],
    ['rajuh@gmail.com', 'rajuhgmailcom'],
    ['---raju---', 'raju'],
    ['José', 'jose'],
    ['ÄLISsa', 'alissa'],
    ['rj', 'rj'],
    ['', ''],
    ['!!!', ''],
    ['a-b-c', 'a-b-c'],
  ])('sanitises %j → %j', (input, expected) => {
    expect(sanitizeHandlePrefix(input)).toBe(expected);
  });

  it('clamps long input to 30 chars', () => {
    const long = 'a'.repeat(50);
    expect(sanitizeHandlePrefix(long)).toBe('a'.repeat(30));
  });

  it('does not leave a leading or trailing hyphen after slicing', () => {
    // A 32-char name where char 31 is '-' — slice exposes it.
    const tricky = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo';
    const result = sanitizeHandlePrefix(tricky);
    expect(result).not.toMatch(/^-/);
    expect(result).not.toMatch(/-$/);
  });
});

describe('validateHandleFormat', () => {
  it('accepts a well-formed handle', () => {
    expect(validateHandleFormat('raju.test-pds.dinakernel.com', PDS_HOST)).toEqual(
      { ok: true },
    );
  });

  it('rejects empty string', () => {
    const r = validateHandleFormat('', PDS_HOST);
    expect(r.ok).toBe(false);
  });

  it('rejects handle that does not end with the PDS host', () => {
    const r = validateHandleFormat('raju.bsky.social', PDS_HOST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/test-pds\.dinakernel\.com/);
  });

  it('rejects too-short prefix', () => {
    const r = validateHandleFormat('ab.test-pds.dinakernel.com', PDS_HOST);
    expect(r.ok).toBe(false);
  });

  it('rejects leading hyphen', () => {
    const r = validateHandleFormat('-raju.test-pds.dinakernel.com', PDS_HOST);
    expect(r.ok).toBe(false);
  });

  it('rejects trailing hyphen', () => {
    const r = validateHandleFormat('raju-.test-pds.dinakernel.com', PDS_HOST);
    expect(r.ok).toBe(false);
  });

  it('rejects underscore', () => {
    const r = validateHandleFormat('ra_ju.test-pds.dinakernel.com', PDS_HOST);
    expect(r.ok).toBe(false);
  });

  it('rejects reserved prefix "admin"', () => {
    const r = validateHandleFormat('admin.test-pds.dinakernel.com', PDS_HOST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/reserved/);
  });

  it('rejects reserved prefix "dina"', () => {
    const r = validateHandleFormat('dina.test-pds.dinakernel.com', PDS_HOST);
    expect(r.ok).toBe(false);
  });
});

describe('checkHandleAvailability', () => {
  it('returns "taken" with did when PDS responds 200', async () => {
    const { fetch, calls } = buildFetch({
      'raju.test-pds.dinakernel.com': { status: 200, did: 'did:plc:abc123' },
    });
    const r = await checkHandleAvailability('raju.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(r.kind).toBe('taken');
    expect(r.did).toBe('did:plc:abc123');
    expect(calls).toEqual(['raju.test-pds.dinakernel.com']);
  });

  it('returns "available" when PDS responds 400 (Unable to resolve handle)', async () => {
    const { fetch } = buildFetch({
      'raju.test-pds.dinakernel.com': { status: 400 },
    });
    const r = await checkHandleAvailability('raju.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(r.kind).toBe('available');
  });

  it('returns "available" when PDS responds 404', async () => {
    const { fetch } = buildFetch({
      'raju.test-pds.dinakernel.com': { status: 404 },
    });
    const r = await checkHandleAvailability('raju.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(r.kind).toBe('available');
  });

  it('returns "unknown" on HTTP 500', async () => {
    const { fetch } = buildFetch({
      'raju.test-pds.dinakernel.com': { status: 500 },
    });
    const r = await checkHandleAvailability('raju.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(r.kind).toBe('unknown');
    expect(r.reason).toMatch(/500/);
  });

  it('returns "unknown" on network error', async () => {
    const fetchFn = (jest.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown) as typeof globalThis.fetch;
    const r = await checkHandleAvailability('raju.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch: fetchFn,
    });
    expect(r.kind).toBe('unknown');
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it('returns "invalid" without calling fetch when format check fails', async () => {
    const { fetch, calls } = buildFetch({});
    const r = await checkHandleAvailability('raju.bsky.social', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(r.kind).toBe('invalid');
    expect(calls).toEqual([]);
  });

  it('treats 200 with no did body as taken (defensive)', async () => {
    const { fetch } = buildFetch({
      'raju.test-pds.dinakernel.com': { status: 200 }, // no did
    });
    const r = await checkHandleAvailability('raju.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(r.kind).toBe('taken');
    expect(r.did).toBeUndefined();
  });
});

describe('generateCandidates', () => {
  it('produces deterministic output with injected random + year', () => {
    const a = generateCandidates('raju', { random: fixedRandom([0.1, 0.5, 0.9]), year: 2026 });
    const b = generateCandidates('raju', { random: fixedRandom([0.1, 0.5, 0.9]), year: 2026 });
    expect(a).toEqual(b);
  });

  it('does not include the bare base as a candidate', () => {
    const cands = generateCandidates('raju', { random: () => 0.5, year: 2026 });
    expect(cands).not.toContain('raju');
  });

  it('includes a 2-digit year-suffixed candidate', () => {
    const cands = generateCandidates('raju', { random: () => 0.5, year: 2026 });
    expect(cands).toContain('raju26');
  });

  it('includes prepend variants', () => {
    const cands = generateCandidates('raju', { random: () => 0.5, year: 2026 });
    expect(cands).toContain('theraju');
    expect(cands).toContain('realraju');
  });

  it('includes hyphenated word variants', () => {
    const cands = generateCandidates('raju', { random: () => 0.5, year: 2026 });
    const hyphenated = cands.filter((c) => c.startsWith('raju-'));
    expect(hyphenated.length).toBeGreaterThan(0);
  });

  it('emits no duplicates', () => {
    const cands = generateCandidates('raju', { random: () => 0.0, year: 2026 });
    expect(new Set(cands).size).toBe(cands.length);
  });
});

describe('pickHandle', () => {
  it('returns no alternatives when preferred is available', async () => {
    const { fetch, calls } = buildFetch({
      'raju.test-pds.dinakernel.com': { status: 400 }, // available
    });
    const result = await pickHandle('raju.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(result.preferred.kind).toBe('available');
    expect(result.alternatives).toEqual([]);
    expect(calls).toEqual(['raju.test-pds.dinakernel.com']);
  });

  it('returns up to 3 available alternatives when preferred is taken', async () => {
    // Preferred taken; first two suggestion candidates also taken;
    // remaining ones available. The picker should batch-check all of
    // them in parallel and surface the first 3 that came back free.
    const { fetch, calls } = buildFetch({
      // Preferred — taken.
      'raju.test-pds.dinakernel.com': { status: 200, did: 'did:plc:taken1' },
      // Suggestions — first two taken, rest available (default 400 from buildFetch).
      'raju42.test-pds.dinakernel.com': { status: 200, did: 'did:plc:taken2' },
      'theraju.test-pds.dinakernel.com': { status: 200, did: 'did:plc:taken3' },
    });
    const result = await pickHandle(
      'raju.test-pds.dinakernel.com',
      {
        pdsURL: PDS_URL,
        pdsHost: PDS_HOST,
        fetch,
        random: fixedRandom([0.4, 0.4, 0.4]), // pickInt(2,99) → 41 → "raju41"... let candidates fall through
        yearOverride: 2026,
      },
      3,
    );
    expect(result.preferred.kind).toBe('taken');
    expect(result.alternatives.length).toBeLessThanOrEqual(3);
    expect(result.alternatives.length).toBeGreaterThan(0);
    for (const alt of result.alternatives) {
      expect(alt.kind).toBe('available');
      expect(alt.handle.endsWith('.test-pds.dinakernel.com')).toBe(true);
    }
    // Preferred check + N suggestion checks — must include the preferred.
    expect(calls[0]).toBe('raju.test-pds.dinakernel.com');
    expect(calls.length).toBeGreaterThan(1);
  });

  it('returns empty alternatives when prefix is too short to seed candidates', async () => {
    // A handle that's syntactically too short — alt generation needs a
    // base of at least MIN_PREFIX_CHARS. Empty list is the right
    // outcome; UI should ask the user to type a longer name.
    const { fetch } = buildFetch({});
    const result = await pickHandle('ab.test-pds.dinakernel.com', {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
    });
    expect(result.preferred.kind).toBe('invalid');
    expect(result.alternatives).toEqual([]);
  });

  it('still generates alternatives when preferred is unknown (PDS unreachable)', async () => {
    // Preferred check fails 500, but suggestion checks succeed. The
    // picker shouldn't bail early — it should still surface
    // alternatives so the install can proceed best-effort.
    const responses: Record<string, { status: number; did?: string }> = {
      'raju.test-pds.dinakernel.com': { status: 500 },
    };
    const { fetch } = buildFetch(responses);
    const result = await pickHandle(
      'raju.test-pds.dinakernel.com',
      {
        pdsURL: PDS_URL,
        pdsHost: PDS_HOST,
        fetch,
        random: fixedRandom([0.5]),
        yearOverride: 2026,
      },
      3,
    );
    expect(result.preferred.kind).toBe('unknown');
    // Default 400s from buildFetch make all candidates "available".
    expect(result.alternatives.length).toBe(3);
  });

  it('does not surface unknown candidates as alternatives', async () => {
    // Make every suggestion 500 — no alternative should be returned,
    // because we don't trust unknown availability for what we suggest.
    const { fetch } = buildFetch({});
    // Override default behaviour: every call returns 500.
    const fetchFn = (jest.fn(async () => {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }) as unknown) as typeof globalThis.fetch;
    const result = await pickHandle(
      'raju.test-pds.dinakernel.com',
      {
        pdsURL: PDS_URL,
        pdsHost: PDS_HOST,
        fetch: fetchFn,
        random: () => 0.5,
        yearOverride: 2026,
      },
      3,
    );
    expect(result.preferred.kind).toBe('unknown');
    expect(result.alternatives).toEqual([]);
    void fetch; // unused — kept for symmetry with other tests
  });
});

describe('integration shape', () => {
  it('the full pipeline works on a realistic flow', async () => {
    // User typed "Raju" → sanitised to "raju" → checked → taken →
    // alternatives surfaced → one of them is selected and looks
    // structurally valid.
    const sanitized = sanitizeHandlePrefix('Raju');
    expect(sanitized).toBe('raju');

    const handle = `${sanitized}.${PDS_HOST}`;
    const { fetch } = buildFetch({
      [handle]: { status: 200, did: 'did:plc:exists' },
      // First few candidates also taken so we hit deeper into the list.
      'raju42.test-pds.dinakernel.com': { status: 200, did: 'did:plc:two' },
      'theraju.test-pds.dinakernel.com': { status: 200, did: 'did:plc:three' },
    });
    const opts: PickerOptions = {
      pdsURL: PDS_URL,
      pdsHost: PDS_HOST,
      fetch,
      random: fixedRandom([0.41]), // 0.41 * 98 = 40.18 → +2 → 42
      yearOverride: 2026,
    };
    const r = await pickHandle(handle, opts, 3);
    expect(r.preferred.kind).toBe('taken');
    expect(r.alternatives.length).toBe(3);
    for (const alt of r.alternatives) {
      const formatOk = validateHandleFormat(alt.handle, PDS_HOST);
      expect(formatOk.ok).toBe(true);
    }
  });
});
