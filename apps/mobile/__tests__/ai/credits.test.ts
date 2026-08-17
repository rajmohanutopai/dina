/**
 * Starter Credits client — config clamping, the claim state machine
 * (terminal vs transient refusals, attestation-unavailable, key
 * custody), balance + exhaustion latch, and the provider-layer
 * precedence rule (BYOK over grant).
 */

import { setGenericPassword } from 'react-native-keychain';

import {
  CREDITS_DEFAULT_CONFIG,
  __resetCreditsCachesForTest,
  clampCreditsConfig,
  clearCreditsState,
  dismissLowBalanceCard,
  fetchCreditsConfig,
  getGrantCredential,
  getGrantKey,
  loadCreditsState,
  refreshBalance,
  runClaimFlow,
} from '../../src/ai/credits';

function fetchJson(status: number, body: unknown): typeof fetch {
  return jest.fn(async () => ({
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

/** Sequenced fetch: each call pops the next response. */
function fetchSeq(responses: { status: number; body: unknown }[]): typeof fetch {
  const queue = [...responses];
  return jest.fn(async () => {
    const r = queue.shift();
    if (r === undefined) throw new Error('unexpected extra fetch');
    return { status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
}

const GOOD_CONFIG = {
  enabled: true,
  grant_usd: 0.25,
  model_pin: 'deepseek/deepseek-v4-pro',
  est_conversations: 40,
};
const GOOD_GRANT = {
  key: 'sk-or-v1-granted',
  limit_usd: 0.25,
  model_pin: 'deepseek/deepseek-v4-pro',
};

beforeEach(async () => {
  __resetCreditsCachesForTest();
  await clearCreditsState();
  __resetCreditsCachesForTest();
});

describe('clampCreditsConfig (compiled-in hardening)', () => {
  it('passes a sane config through', () => {
    expect(clampCreditsConfig(GOOD_CONFIG)).toEqual({
      enabled: true,
      grantUsd: 0.25,
      modelPin: 'deepseek/deepseek-v4-pro',
      estConversations: 40,
    });
  });

  it('rejects a model pin outside the compiled allowlist', () => {
    const c = clampCreditsConfig({ ...GOOD_CONFIG, model_pin: 'evil/exfiltrator-1' });
    expect(c.modelPin).toBe(CREDITS_DEFAULT_CONFIG.model_pin);
  });

  it('clamps hostile numerics field-wise', () => {
    const c = clampCreditsConfig({
      ...GOOD_CONFIG,
      grant_usd: 9999,
      est_conversations: -3,
    });
    expect(c.grantUsd).toBe(CREDITS_DEFAULT_CONFIG.grant_usd);
    expect(c.estConversations).toBe(CREDITS_DEFAULT_CONFIG.est_conversations);
  });

  it('treats garbage as disabled-with-defaults', () => {
    const c = clampCreditsConfig('garbage');
    expect(c.enabled).toBe(false);
    expect(c.modelPin).toBe(CREDITS_DEFAULT_CONFIG.model_pin);
  });
});

describe('fetchCreditsConfig', () => {
  it('never reports enabled when the service is unreachable', async () => {
    const failing = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const c = await fetchCreditsConfig('ios', failing);
    expect(c.enabled).toBe(false);
  });

  it('clamps the remote payload', async () => {
    const c = await fetchCreditsConfig('ios', fetchJson(200, { ...GOOD_CONFIG, model_pin: 'evil/x' }));
    expect(c.enabled).toBe(true);
    expect(c.modelPin).toBe(CREDITS_DEFAULT_CONFIG.model_pin);
  });
});

describe('runClaimFlow', () => {
  const att = { getDeviceCheckToken: async () => 'dc-token' };

  it('happy path: stores the key, pins the model, status=claimed', async () => {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 200, body: GOOD_GRANT },
    ]);
    const status = await runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0] });
    expect(status).toBe('claimed');
    expect(await getGrantKey()).toBe('sk-or-v1-granted');
    expect((await loadCreditsState()).modelPin).toBe('deepseek/deepseek-v4-pro');
  });

  it('attestation unavailable (sim/dev) → status=unavailable, no network claim', async () => {
    const f = fetchSeq([{ status: 200, body: GOOD_CONFIG }]);
    const status = await runClaimFlow('ios', {
      getDeviceCheckToken: async () => null,
      fetchImpl: f,
      backoffMs: [0],
    });
    expect(status).toBe('unavailable');
    expect(await getGrantKey()).toBeNull();
  });

  it('terminal refusal stops permanently — next run does not re-claim', async () => {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 409, body: { error: 'already_claimed' } },
    ]);
    const status = await runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0, 0, 0] });
    expect(status).toBe('terminal_refused');

    // Second run short-circuits before any fetch.
    const f2 = jest.fn() as unknown as typeof fetch;
    const status2 = await runClaimFlow('ios', { ...att, fetchImpl: f2, backoffMs: [0] });
    expect(status2).toBe('terminal_refused');
    expect(f2).not.toHaveBeenCalled();
  });

  it('already_claimed but the granted key survived locally → re-adopts it (status=claimed)', async () => {
    // A re-onboard wipes our local STATUS but the Keychain grant key persists.
    // The server 409s the duplicate claim; we must adopt the surviving grant
    // instead of dead-ending the returning user.
    await setGenericPassword('dina', 'sk-or-v1-survivor', { service: 'dina.credits.key' });
    __resetCreditsCachesForTest(); // forget cachedKey so getGrantKey re-reads the seeded key
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 409, body: { error: 'already_claimed' } },
    ]);
    const status = await runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0] });
    expect(status).toBe('claimed');
    expect(await getGrantKey()).toBe('sk-or-v1-survivor');
  });

  it('transient refusals retry through the backoff schedule then give up (status unchanged)', async () => {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 429, body: { error: 'rate_limited' } },
      { status: 503, body: { error: 'grants_paused' } },
    ]);
    const sleeps: number[] = [];
    const status = await runClaimFlow('ios', {
      ...att,
      fetchImpl: f,
      backoffMs: [0, 10],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(status).toBe('unclaimed'); // retried next boot
    expect(sleeps).toEqual([10]);
  });

  it('config disabled → stays unclaimed without attempting attestation', async () => {
    let attestationCalls = 0;
    const f = fetchSeq([{ status: 200, body: { ...GOOD_CONFIG, enabled: false } }]);
    const status = await runClaimFlow('ios', {
      getDeviceCheckToken: async () => {
        attestationCalls += 1;
        return 'dc';
      },
      fetchImpl: f,
      backoffMs: [0],
    });
    expect(status).toBe('unclaimed');
    expect(attestationCalls).toBe(0);
  });

  it('a malformed grant body is treated as transient, never stored', async () => {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 200, body: { key: '' } },
    ]);
    const status = await runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0] });
    expect(status).toBe('unclaimed');
    expect(await getGrantKey()).toBeNull();
  });

  it('a grant with an off-allowlist pin stores the key but pins the compiled default', async () => {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 200, body: { ...GOOD_GRANT, model_pin: 'evil/x' } },
    ]);
    await runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0] });
    const cred = await getGrantCredential();
    expect(cred).toEqual({
      key: 'sk-or-v1-granted',
      modelPin: CREDITS_DEFAULT_CONFIG.model_pin,
    });
  });
});

describe('claim extras (review fixes)', () => {
  const att = { getDeviceCheckToken: async () => 'dc-token' };

  it('onClaimed fires exactly once when the key lands', async () => {
    const onClaimed = jest.fn();
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 200, body: GOOD_GRANT },
    ]);
    await runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0], onClaimed });
    expect(onClaimed).toHaveBeenCalledTimes(1);
  });

  it('attestation_unavailable (transient Apple outage) does NOT latch terminal', async () => {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 503, body: { error: 'attestation_unavailable' } },
    ]);
    const status = await runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0] });
    expect(status).toBe('unclaimed'); // retried next launch
  });

  it('concurrent runs coalesce onto one in-flight claim', async () => {
    let claims = 0;
    const f = (async (url: string) => {
      if (String(url).includes('getConfig')) return { status: 200, json: async () => GOOD_CONFIG };
      claims += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { status: 200, json: async () => GOOD_GRANT };
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0] }),
      runClaimFlow('ios', { ...att, fetchImpl: f, backoffMs: [0] }),
    ]);
    expect(a).toBe('claimed');
    expect(b).toBe('claimed');
    expect(claims).toBe(1);
  });
});

describe('balance + exhaustion latch', () => {
  async function claim(): Promise<void> {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 200, body: GOOD_GRANT },
    ]);
    await runClaimFlow('ios', {
      getDeviceCheckToken: async () => 'dc',
      fetchImpl: f,
      backoffMs: [0],
    });
  }

  it('reads remaining and estimates conversations', async () => {
    await claim();
    const bal = await refreshBalance(fetchJson(200, { data: { limit_remaining: 0.126 } }));
    // 0.126 / 0.002 avg-per-conversation (Flash 0731 measured rate) = 63.
    expect(bal).toEqual({ remainingUsd: 0.126, estConversationsLeft: 63, exhausted: false });
  });

  it('latches exhaustion at the dust threshold and persists it', async () => {
    await claim();
    const bal = await refreshBalance(fetchJson(200, { data: { limit_remaining: 0.0001 } }));
    expect(bal?.exhausted).toBe(true);
    expect((await loadCreditsState()).exhausted).toBe(true);
  });

  it('returns null without a grant key (BYOK-only users never poll)', async () => {
    const f = jest.fn() as unknown as typeof fetch;
    expect(await refreshBalance(f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('low-balance dismissal persists forever', async () => {
    await claim();
    await dismissLowBalanceCard();
    expect((await loadCreditsState()).lowBalanceDismissed).toBe(true);
  });
});

describe('custody', () => {
  it('clearCreditsState wipes key and state (identity erase)', async () => {
    const f = fetchSeq([
      { status: 200, body: GOOD_CONFIG },
      { status: 200, body: GOOD_GRANT },
    ]);
    await runClaimFlow('ios', {
      getDeviceCheckToken: async () => 'dc',
      fetchImpl: f,
      backoffMs: [0],
    });
    expect(await getGrantKey()).not.toBeNull();
    await clearCreditsState();
    expect(await getGrantKey()).toBeNull();
    expect((await loadCreditsState()).status).toBe('unclaimed');
  });
});
