/**
 * Key-health probe — classification + cache.
 *
 * The probe exists because the free model-LIST verify cannot see credit
 * exhaustion: a valid key 200s on list while every generateContent 429s
 * RESOURCE_EXHAUSTED (live incident 2026-06-10). These tests pin the
 * classification of each provider outcome and the TTL/coalescing cache.
 */

import {
  checkKeyHealth,
  clearKeyHealthCache,
  getCachedKeyHealth,
  refreshKeyHealth,
  reportKeyHealthIncident,
  subscribeKeyHealth,
} from '../../src/ai/key_health';

interface FetchResult {
  status: number;
  text: () => Promise<string>;
}

function fetchReturning(status: number, body: unknown): jest.Mock<Promise<FetchResult>> {
  return jest.fn(async () => ({
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
}

const GEMINI_DEPLETED = {
  error: {
    code: 429,
    message:
      'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',
    status: 'RESOURCE_EXHAUSTED',
  },
};

afterEach(() => clearKeyHealthCache());

describe('checkKeyHealth — classification', () => {
  it('200 → ok', async () => {
    const f = fetchReturning(200, { candidates: [] });
    const h = await checkKeyHealth('gemini', 'AIza-test', f);
    expect(h.status).toBe('ok');
  });

  it('gemini 429 RESOURCE_EXHAUSTED (prepayment depleted) → credits_exhausted with detail', async () => {
    const f = fetchReturning(429, GEMINI_DEPLETED);
    const h = await checkKeyHealth('gemini', 'AIza-test', f);
    expect(h.status).toBe('credits_exhausted');
    expect(h.detail).toMatch(/prepayment credits are depleted/i);
  });

  it('openai 429 insufficient_quota → credits_exhausted', async () => {
    const f = fetchReturning(429, {
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
      },
    });
    const h = await checkKeyHealth('openai', 'sk-test', f);
    expect(h.status).toBe('credits_exhausted');
  });

  it('openrouter 402 → credits_exhausted', async () => {
    const f = fetchReturning(402, { error: { message: 'Insufficient credits' } });
    const h = await checkKeyHealth('openrouter', 'sk-or-test', f);
    expect(h.status).toBe('credits_exhausted');
  });

  it('gemini 400 API key not valid → invalid_key', async () => {
    const f = fetchReturning(400, {
      error: {
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
      },
    });
    const h = await checkKeyHealth('gemini', 'AIza-bad', f);
    expect(h.status).toBe('invalid_key');
  });

  it('401/403 → invalid_key', async () => {
    expect((await checkKeyHealth('openai', 'sk-x', fetchReturning(401, {}))).status).toBe(
      'invalid_key',
    );
    expect((await checkKeyHealth('claude', 'sk-ant-x', fetchReturning(403, {}))).status).toBe(
      'invalid_key',
    );
  });

  it('5xx and plain non-quota 429 → unreachable (transient, not a key verdict)', async () => {
    expect((await checkKeyHealth('gemini', 'AIza-x', fetchReturning(503, {}))).status).toBe(
      'unreachable',
    );
    const plainRateLimit = fetchReturning(429, {
      error: { message: 'Rate limit reached, retry shortly.' },
    });
    expect((await checkKeyHealth('openai', 'sk-x', plainRateLimit)).status).toBe('unreachable');
  });

  it('network failure → unreachable', async () => {
    const f = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const h = await checkKeyHealth('gemini', 'AIza-x', f as never);
    expect(h.status).toBe('unreachable');
  });
});

describe('refreshKeyHealth — cache + coalescing', () => {
  it('caches within the TTL (one fetch for two calls) and force bypasses', async () => {
    const f = fetchReturning(429, GEMINI_DEPLETED);
    await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: f });
    await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1);
    expect(getCachedKeyHealth('gemini')?.status).toBe('credits_exhausted');

    await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: f, force: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('an ERROR verdict expires after ERROR_CACHE_TTL_MS so recovery clears the pill on the next visit (live incident: user paid, pill stuck)', async () => {
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      // First probe: credits exhausted → cached error verdict.
      const exhausted = fetchReturning(429, GEMINI_DEPLETED);
      await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: exhausted });
      expect(getCachedKeyHealth('gemini')?.status).toBe('credits_exhausted');

      // 16s later (past the 15s error TTL, far inside the 5min ok TTL) the
      // user has topped up — the revisit re-probes WITHOUT force and clears.
      nowSpy.mockReturnValue(t0 + 16_000);
      const healthy = fetchReturning(200, { candidates: [] });
      await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: healthy });
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(getCachedKeyHealth('gemini')?.status).toBe('ok');

      // The now-HEALTHY verdict gets the long TTL: another visit 16s later
      // does NOT re-probe.
      nowSpy.mockReturnValue(t0 + 32_000);
      const again = fetchReturning(200, { candidates: [] });
      await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: again });
      expect(again).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reportKeyHealthIncident (chat-failure bridge) lights the pill immediately + notifies subscribers', async () => {
    const events: number[] = [];
    const unsub = subscribeKeyHealth(() => events.push(1));
    try {
      reportKeyHealthIncident(
        'gemini',
        'credits_exhausted',
        'Your prepayment credits are depleted.',
      );
      expect(getCachedKeyHealth('gemini')).toMatchObject({
        status: 'credits_exhausted',
        detail: 'Your prepayment credits are depleted.',
      });
      expect(events.length).toBeGreaterThan(0);

      // The incident participates in the normal cache: within the error TTL a
      // probe is NOT re-issued (the incident IS the fresh verdict)…
      const f = fetchReturning(200, {});
      await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: f });
      expect(f).not.toHaveBeenCalled();

      // …and after the short error TTL the next visit re-probes and clears.
      const t0 = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0 + 16_000);
      try {
        await refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: f });
        expect(f).toHaveBeenCalledTimes(1);
        expect(getCachedKeyHealth('gemini')?.status).toBe('ok');
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      unsub();
    }
  });

  it('coalesces concurrent probes into one request', async () => {
    // Gate the FETCH itself (the executor assigns `release` synchronously),
    // so both refresh calls are in flight before the probe can complete.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const f = jest.fn(async () => {
      await gate;
      return { status: 200, text: async () => '{}' };
    });
    const p1 = refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: f as never });
    const p2 = refreshKeyHealth('gemini', 'AIza-test', { fetchImpl: f as never });
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
  });
});
