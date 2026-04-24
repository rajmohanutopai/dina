/**
 * useServiceConfigForm — MOBILE-010 tests.
 */

import {
  ServiceConfigNotConfiguredError,
  ServiceConfigValidationError,
  loadServiceConfig,
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
});
