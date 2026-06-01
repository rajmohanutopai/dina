/**
 * useServiceConfigForm — MOBILE-010 tests.
 */

import {
  ServiceConfigNotConfiguredError,
  ServiceConfigValidationError,
  loadServiceConfig,
  loadServiceConfigWithRetry,
  resetServiceConfigCoreClient,
  saveServiceConfig,
  setServiceConfigCoreClient,
  type ServiceConfigCoreClient,
} from '../../src/hooks/useServiceConfigForm';
import type { ServiceConfig } from '../../../core/src/service/service_config';

const VALID_CONFIG: ServiceConfig = {
  name: 'Transit Provider',
  isDiscoverable: true,
  description: 'Bus routes and ETAs',
  capabilities: {
    eta_query: {
      mcpServer: 'transit-stub',
      mcpTool: 'eta_query',
      responsePolicy: 'auto',
    },
  },
};

function stubClient(init: {
  getResult?: ServiceConfig | null;
  getError?: Error;
  putError?: Error;
}): { client: ServiceConfigCoreClient; calls: { get: number; put: ServiceConfig[] } } {
  const calls = { get: 0, put: [] as ServiceConfig[] };
  const client: ServiceConfigCoreClient = {
    async serviceConfig() {
      calls.get++;
      if (init.getError) throw init.getError;
      return init.getResult ?? null;
    },
    async putServiceConfig(cfg: ServiceConfig) {
      calls.put.push(cfg);
      if (init.putError) throw init.putError;
    },
  };
  return { client, calls };
}

describe('useServiceConfigForm', () => {
  beforeEach(() => resetServiceConfigCoreClient());

  it('throws when used before setServiceConfigCoreClient is called', async () => {
    await expect(loadServiceConfig()).rejects.toBeInstanceOf(ServiceConfigNotConfiguredError);
    await expect(saveServiceConfig(VALID_CONFIG)).rejects.toBeInstanceOf(
      ServiceConfigNotConfiguredError,
    );
  });

  it('loadServiceConfig returns null when Core has nothing set', async () => {
    const { client } = stubClient({ getResult: null });
    setServiceConfigCoreClient(client);
    const cfg = await loadServiceConfig();
    expect(cfg).toBeNull();
  });

  it('loadServiceConfig returns the Core-supplied config', async () => {
    const { client } = stubClient({ getResult: VALID_CONFIG });
    setServiceConfigCoreClient(client);
    const cfg = await loadServiceConfig();
    expect(cfg).toEqual(VALID_CONFIG);
  });

  it('saveServiceConfig validates client-side before the network call', async () => {
    const { client, calls } = stubClient({});
    setServiceConfigCoreClient(client);
    const invalid = { ...VALID_CONFIG, isDiscoverable: 'nope' as unknown as boolean };
    await expect(saveServiceConfig(invalid)).rejects.toBeInstanceOf(ServiceConfigValidationError);
    expect(calls.put).toHaveLength(0);
  });

  it('saveServiceConfig forwards to putServiceConfig when valid', async () => {
    const { client, calls } = stubClient({});
    setServiceConfigCoreClient(client);
    await saveServiceConfig(VALID_CONFIG);
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0]).toEqual(VALID_CONFIG);
  });

  it('surfaces validation message in the ServiceConfigValidationError', async () => {
    const { client } = stubClient({});
    setServiceConfigCoreClient(client);
    const missingName = { ...VALID_CONFIG, name: '' };
    await expect(saveServiceConfig(missingName)).rejects.toThrow(/name is required/);
  });

  it('propagates underlying put errors verbatim', async () => {
    const { client } = stubClient({ putError: new Error('500 backend down') });
    setServiceConfigCoreClient(client);
    await expect(saveServiceConfig(VALID_CONFIG)).rejects.toThrow('500 backend down');
  });

  // ─── loadServiceConfigWithRetry — boot-window tolerance ──────────────────
  // The service-config Core client is wired during node boot; a screen can
  // mount while it's momentarily null (first boot / re-boot / dev Fast-Refresh).
  // The retry wrapper rides through that window instead of surfacing a sticky
  // "couldn't load" error. `sleep` is injected so the tests don't wait real time.

  describe('loadServiceConfigWithRetry', () => {
    it('returns on the first try when the client is already wired (no sleeps)', async () => {
      const { client, calls } = stubClient({ getResult: VALID_CONFIG });
      setServiceConfigCoreClient(client);
      let slept = 0;
      const cfg = await loadServiceConfigWithRetry({
        delayMs: 0,
        sleep: async () => {
          slept++;
        },
      });
      expect(cfg).toEqual(VALID_CONFIG);
      expect(calls.get).toBe(1);
      expect(slept).toBe(0);
    });

    it('retries through the boot window: null now, wired a beat later → returns config', async () => {
      resetServiceConfigCoreClient(); // client starts null (mid-boot)
      const { client } = stubClient({ getResult: VALID_CONFIG });
      let slept = 0;
      const cfg = await loadServiceConfigWithRetry({
        maxAttempts: 6,
        delayMs: 0,
        // Simulate boot finishing: wire the client after the 2nd retry sleep.
        sleep: async () => {
          slept++;
          if (slept === 2) setServiceConfigCoreClient(client);
        },
      });
      expect(cfg).toEqual(VALID_CONFIG);
      expect(slept).toBe(2); // attempts 1+2 saw null; attempt 3 succeeded
    });

    it('gives up after maxAttempts when the client never wires', async () => {
      resetServiceConfigCoreClient(); // never set
      let slept = 0;
      await expect(
        loadServiceConfigWithRetry({
          maxAttempts: 3,
          delayMs: 0,
          sleep: async () => {
            slept++;
          },
        }),
      ).rejects.toBeInstanceOf(ServiceConfigNotConfiguredError);
      expect(slept).toBe(2); // sleeps between attempts 1→2 and 2→3; attempt 3 throws
    });

    it('does NOT retry on non-NotConfigured errors — propagates immediately', async () => {
      const { client, calls } = stubClient({ getError: new Error('500 backend down') });
      setServiceConfigCoreClient(client);
      let slept = 0;
      await expect(
        loadServiceConfigWithRetry({
          maxAttempts: 6,
          delayMs: 0,
          sleep: async () => {
            slept++;
          },
        }),
      ).rejects.toThrow('500 backend down');
      expect(calls.get).toBe(1);
      expect(slept).toBe(0);
    });
  });
});
