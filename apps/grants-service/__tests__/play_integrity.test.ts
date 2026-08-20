/**
 * Play Integrity adapter — the Android DeviceState. Covers the verdict
 * policy (genuine device passes, emulator fails), Device Recall as the
 * once-per-device bit, freshness/package binding, and the
 * invalid-vs-unavailable split that decides whether a device is bricked
 * or retries. Google is mocked via an injected fetch keyed on the action.
 */

import { PlayIntegrityClient, meetsDeviceBar } from '../src/play_integrity';

const NOW = 1_750_000_000_000;
const PKG = 'com.dinakernel.mobile';

interface PayloadOverrides {
  packageName?: string;
  timestampMillis?: number;
  deviceVerdict?: string[];
  recallBitFirst?: boolean;
}

function decodedPayload(o: PayloadOverrides = {}): unknown {
  return {
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: o.packageName ?? PKG,
        timestampMillis: String(o.timestampMillis ?? NOW),
      },
      appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: PKG },
      deviceIntegrity: {
        deviceRecognitionVerdict: o.deviceVerdict ?? ['MEETS_DEVICE_INTEGRITY'],
      },
      deviceRecall: { values: { bitFirst: o.recallBitFirst ?? false } },
    },
  };
}

interface RelayBehavior {
  decode?: { status: number; body: unknown };
  decodeThrows?: boolean;
  write?: { status: number };
  minterThrows?: boolean;
}

function client(behavior: RelayBehavior): {
  pi: PlayIntegrityClient;
  seen: { decodeAuth?: string; decodeUrl?: string; writeBody?: unknown; writeUrl?: string };
} {
  const seen: {
    decodeAuth?: string;
    decodeUrl?: string;
    writeBody?: unknown;
    writeUrl?: string;
  } = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (url.includes(':decodeIntegrityToken')) {
      if (behavior.decodeThrows === true) throw new Error('network');
      seen.decodeAuth = headers.Authorization;
      seen.decodeUrl = url;
      const d = behavior.decode ?? { status: 200, body: decodedPayload() };
      return new Response(typeof d.body === 'string' ? d.body : JSON.stringify(d.body), {
        status: d.status,
      });
    }
    // writeDeviceRecall
    seen.writeUrl = url;
    seen.writeBody = JSON.parse(String(init.body));
    return new Response('{}', { status: behavior.write?.status ?? 200 });
  }) as unknown as typeof fetch;

  const tokenMinter = {
    getAccessToken: async (): Promise<string> => {
      if (behavior.minterThrows === true) throw new Error('token exchange down');
      return 'ya29.access';
    },
  };

  const pi = new PlayIntegrityClient({
    packageName: PKG,
    tokenMinter,
    fetchImpl,
    now: () => NOW,
  });
  return { pi, seen };
}

describe('meetsDeviceBar', () => {
  it('a genuine device meets the DEVICE bar', () => {
    expect(meetsDeviceBar(['MEETS_DEVICE_INTEGRITY'], 'MEETS_DEVICE_INTEGRITY')).toBe(true);
  });
  it('STRONG satisfies a DEVICE bar (higher label counts)', () => {
    expect(meetsDeviceBar(['MEETS_STRONG_INTEGRITY'], 'MEETS_DEVICE_INTEGRITY')).toBe(true);
  });
  it('BASIC-only does NOT meet the DEVICE bar (emulator/rooted)', () => {
    expect(meetsDeviceBar(['MEETS_BASIC_INTEGRITY'], 'MEETS_DEVICE_INTEGRITY')).toBe(false);
  });
  it('an empty verdict meets nothing', () => {
    expect(meetsDeviceBar([], 'MEETS_DEVICE_INTEGRITY')).toBe(false);
    expect(meetsDeviceBar(undefined, 'MEETS_BASIC_INTEGRITY')).toBe(false);
  });
});

describe('PlayIntegrityClient.check', () => {
  it('a genuine device with an unset recall bit → unclaimed', async () => {
    const { pi, seen } = client({});
    const state = await pi.check('tok');
    expect(state).toEqual({ claimed: false });
    // The decode call is authed with the minted token and targets our pkg.
    expect(seen.decodeAuth).toBe('Bearer ya29.access');
    expect(seen.decodeUrl).toContain(`${PKG}:decodeIntegrityToken`);
  });

  it('reads Device Recall bit0 as "already claimed"', async () => {
    const { pi } = client({ decode: { status: 200, body: decodedPayload({ recallBitFirst: true }) } });
    expect(await pi.check('tok')).toEqual({ claimed: true });
  });

  it('an emulator (empty verdict) is INVALID — the anti-farm gate', async () => {
    const { pi } = client({ decode: { status: 200, body: decodedPayload({ deviceVerdict: [] }) } });
    expect(await pi.check('tok')).toBe('invalid');
  });

  it('a BASIC-only verdict is INVALID under the default DEVICE bar', async () => {
    const { pi } = client({
      decode: { status: 200, body: decodedPayload({ deviceVerdict: ['MEETS_BASIC_INTEGRITY'] }) },
    });
    expect(await pi.check('tok')).toBe('invalid');
  });

  it('a token minted for a different package is INVALID', async () => {
    const { pi } = client({
      decode: { status: 200, body: decodedPayload({ packageName: 'com.evil.app' }) },
    });
    expect(await pi.check('tok')).toBe('invalid');
  });

  it('a stale token (older than the freshness window) is INVALID (replay)', async () => {
    const { pi } = client({
      decode: { status: 200, body: decodedPayload({ timestampMillis: NOW - 20 * 60 * 1000 }) },
    });
    expect(await pi.check('tok')).toBe('invalid');
  });

  it('a decode 400 (malformed token) is INVALID → terminal', async () => {
    const { pi } = client({ decode: { status: 400, body: { error: 'bad token' } } });
    expect(await pi.check('tok')).toBe('invalid');
  });

  it.each([401, 403, 429, 500, 503])(
    'a decode %i (our misconfig / outage) is UNAVAILABLE → device retries',
    async (status) => {
      const { pi } = client({ decode: { status, body: {} } });
      expect(await pi.check('tok')).toBe('unavailable');
    },
  );

  it('a decode network error is UNAVAILABLE', async () => {
    const { pi } = client({ decodeThrows: true });
    expect(await pi.check('tok')).toBe('unavailable');
  });

  it('a failure to mint the access token is UNAVAILABLE (not the device fault)', async () => {
    const { pi } = client({ minterThrows: true });
    expect(await pi.check('tok')).toBe('unavailable');
  });

  it('a 200 with no tokenPayloadExternal is INVALID', async () => {
    const { pi } = client({ decode: { status: 200, body: { nothing: true } } });
    expect(await pi.check('tok')).toBe('invalid');
  });

  it('STRONG bar rejects a device that only MEETS_DEVICE_INTEGRITY', async () => {
    const tokenMinter = { getAccessToken: async () => 'ya29.access' };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(decodedPayload({ deviceVerdict: ['MEETS_DEVICE_INTEGRITY'] })), {
        status: 200,
      })) as unknown as typeof fetch;
    const pi = new PlayIntegrityClient({
      packageName: PKG,
      tokenMinter,
      fetchImpl,
      now: () => NOW,
      minDeviceVerdict: 'MEETS_STRONG_INTEGRITY',
    });
    expect(await pi.check('tok')).toBe('invalid');
  });
});

describe('PlayIntegrityClient.setClaimed', () => {
  it('writes Device Recall bit0 for our package', async () => {
    const { pi, seen } = client({});
    await pi.setClaimed('tok');
    expect(seen.writeUrl).toContain(`${PKG}:writeDeviceRecall`);
    expect(seen.writeBody).toEqual({ integrityToken: 'tok', newValues: { bitFirst: true } });
  });

  it('throws when the recall write fails (surfaces the bounded double-grant path)', async () => {
    const { pi } = client({ write: { status: 500 } });
    await expect(pi.setClaimed('tok')).rejects.toThrow(/writeDeviceRecall failed/);
  });
});
