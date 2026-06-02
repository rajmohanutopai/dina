/**
 * useServiceConfigForm — MOBILE-010 tests.
 */

import {
  ServiceConfigNotConfiguredError,
  ServiceConfigValidationError,
  deleteServiceListing,
  listServiceListings,
  loadServiceConfig,
  loadServiceConfigWithRetry,
  resetServiceConfigCoreClient,
  saveServiceConfig,
  setServiceConfigCoreClient,
  type ServiceConfigCoreClient,
  type ServiceListing,
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
  listResult?: ServiceListing[];
}): {
  client: ServiceConfigCoreClient;
  calls: {
    get: number;
    getRkeys: (string | undefined)[];
    put: ServiceConfig[];
    putRkeys: (string | undefined)[];
    list: number;
    delete: string[];
  };
} {
  const calls = {
    get: 0,
    getRkeys: [] as (string | undefined)[],
    put: [] as ServiceConfig[],
    putRkeys: [] as (string | undefined)[],
    list: 0,
    delete: [] as string[],
  };
  const client: ServiceConfigCoreClient = {
    async serviceConfig(rkey?: string) {
      calls.get++;
      calls.getRkeys.push(rkey);
      if (init.getError) throw init.getError;
      return init.getResult ?? null;
    },
    async putServiceConfig(cfg: ServiceConfig, rkey?: string) {
      calls.put.push(cfg);
      calls.putRkeys.push(rkey);
      if (init.putError) throw init.putError;
    },
    async listServiceConfigs() {
      calls.list++;
      return init.listResult ?? [];
    },
    async deleteServiceConfig(rkey: string) {
      calls.delete.push(rkey);
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

  // ─── multi-listing (one DID, many listings keyed by rkey) ───────────────
  describe('multi-listing', () => {
    it('loadServiceConfig forwards the rkey (default self when omitted)', async () => {
      const { client, calls } = stubClient({ getResult: VALID_CONFIG });
      setServiceConfigCoreClient(client);
      await loadServiceConfig('corner-market');
      await loadServiceConfig();
      expect(calls.getRkeys).toEqual(['corner-market', undefined]);
    });

    it('saveServiceConfig forwards the rkey', async () => {
      const { client, calls } = stubClient({});
      setServiceConfigCoreClient(client);
      await saveServiceConfig(VALID_CONFIG, 'corner-market');
      expect(calls.putRkeys).toEqual(['corner-market']);
    });

    it('loadServiceConfigWithRetry forwards rkey to loadServiceConfig', async () => {
      const { client, calls } = stubClient({ getResult: VALID_CONFIG });
      setServiceConfigCoreClient(client);
      await loadServiceConfigWithRetry({ rkey: 'corner-market', delayMs: 0 });
      expect(calls.getRkeys).toEqual(['corner-market']);
    });

    it('listServiceListings returns every listing', async () => {
      const listing: ServiceListing = { rkey: 'self', config: VALID_CONFIG };
      const { client, calls } = stubClient({ listResult: [listing] });
      setServiceConfigCoreClient(client);
      expect(await listServiceListings()).toEqual([listing]);
      expect(calls.list).toBe(1);
    });

    it('deleteServiceListing forwards the rkey', async () => {
      const { client, calls } = stubClient({});
      setServiceConfigCoreClient(client);
      await deleteServiceListing('corner-market');
      expect(calls.delete).toEqual(['corner-market']);
    });

    it('list/delete throw before the client is wired', async () => {
      await expect(listServiceListings()).rejects.toBeInstanceOf(ServiceConfigNotConfiguredError);
      await expect(deleteServiceListing('x')).rejects.toBeInstanceOf(
        ServiceConfigNotConfiguredError,
      );
    });
  });
});
