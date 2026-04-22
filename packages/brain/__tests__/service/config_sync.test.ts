/**
 * Tests for ConfigSync — the config-changed → PDS publish bridge.
 *
 * Covers:
 *   - Publisher.sync is invoked with the converted ServicePublisherConfig.
 *   - isDiscoverable=false triggers unpublish (not publish).
 *   - null config triggers unpublish.
 *   - In-flight sync folds concurrent updates into a single trailing run.
 *   - Errors surface via onError and do not propagate to the event source.
 *   - start/stop/flush lifecycle.
 */

import { ConfigSync, toPublisherConfig } from '../../src/service/config_sync';
import type { ServiceConfig } from '../../../core/src/service/service_config';
import type { ServicePublisher, ServicePublisherConfig } from '../../src/service/service_publisher';

/** Deferred: expose a Promise plus an external `resolve` handle. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A stub ServicePublisher that tracks calls and lets tests control timing.
 *
 * `nextPublishBlock` makes the next publish wait on an externally-resolvable
 * promise — used to deterministically interleave bursts without `setTimeout`.
 */
class StubPublisher {
  publishedConfigs: ServicePublisherConfig[] = [];
  unpublishCount = 0;
  nextPublishError: Error | null = null;
  nextUnpublishError: Error | null = null;
  /** If set, the next publish awaits this before resolving. */
  nextPublishBlock: Promise<void> | null = null;

  async publish(config: ServicePublisherConfig): Promise<{ uri: string; cid: string }> {
    if (this.nextPublishError !== null) {
      const err = this.nextPublishError;
      this.nextPublishError = null;
      throw err;
    }
    this.publishedConfigs.push(config);
    if (this.nextPublishBlock !== null) {
      const block = this.nextPublishBlock;
      this.nextPublishBlock = null;
      await block;
    }
    return { uri: 'at://did/col/self', cid: 'cidx' };
  }

  async unpublish(): Promise<void> {
    if (this.nextUnpublishError !== null) {
      const err = this.nextUnpublishError;
      this.nextUnpublishError = null;
      throw err;
    }
    this.unpublishCount += 1;
  }
}

function stubPublisher(): ServicePublisher {
  return new StubPublisher() as unknown as ServicePublisher;
}

function makeSource() {
  let listener: ((cfg: ServiceConfig | null) => void) | null = null;
  return {
    source: {
      onServiceConfigChanged(l: (cfg: ServiceConfig | null) => void) {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    emit(cfg: ServiceConfig | null) {
      if (listener !== null) listener(cfg);
    },
    hasListener: () => listener !== null,
  };
}

const serviceCfg: ServiceConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  description: 'Route 42 operator',
  capabilities: {
    eta_query: {
      mcpServer: 'transit',
      mcpTool: 'get_eta',
      responsePolicy: 'auto',
      schemaHash: 'abc',
    },
    route_info: {
      mcpServer: 'transit',
      mcpTool: 'get_route',
      responsePolicy: 'review',
    },
  },
  capabilitySchemas: {
    eta_query: {
      params: { type: 'object' },
      result: { type: 'object' },
      schemaHash: 'abc',
    },
  },
};

describe('toPublisherConfig', () => {
  it('converts capability map to name array + responsePolicy map', () => {
    const out = toPublisherConfig(serviceCfg);
    expect(out.isDiscoverable).toBe(true);
    expect(out.name).toBe('Bus 42');
    expect(out.description).toBe('Route 42 operator');
    expect(out.capabilities.sort()).toEqual(['eta_query', 'route_info']);
    expect(out.responsePolicy).toEqual({
      eta_query: 'auto',
      route_info: 'review',
    });
    expect(out.capabilitySchemas).toEqual(serviceCfg.capabilitySchemas);
  });

  it('omits description when absent', () => {
    const { description: _d, ...rest } = serviceCfg;
    const out = toPublisherConfig(rest);
    expect(Object.prototype.hasOwnProperty.call(out, 'description')).toBe(false);
  });

  it('omits capabilitySchemas when absent', () => {
    const { capabilitySchemas: _c, ...rest } = serviceCfg;
    const out = toPublisherConfig(rest);
    expect(out.capabilitySchemas).toBeUndefined();
  });
});

describe('ConfigSync', () => {
  describe('construction', () => {
    it('requires publisher and source', () => {
      const { source } = makeSource();
      expect(
        () => new ConfigSync({ publisher: undefined as unknown as ServicePublisher, source }),
      ).toThrow(/publisher/);
      expect(
        () =>
          new ConfigSync({
            publisher: stubPublisher(),
            source: undefined as unknown as { onServiceConfigChanged: () => () => void },
          }),
      ).toThrow(/source/);
    });
  });

  describe('start/stop lifecycle', () => {
    it('start is idempotent', () => {
      const { source } = makeSource();
      const publisher = stubPublisher();
      const sync = new ConfigSync({ publisher, source });

      sync.start();
      sync.start();
      sync.stop();
    });

    it('stop unsubscribes from the source', () => {
      const { source, hasListener } = makeSource();
      const sync = new ConfigSync({ publisher: stubPublisher(), source });

      sync.start();
      expect(hasListener()).toBe(true);
      sync.stop();
      expect(hasListener()).toBe(false);
    });

    it('stop is safe when never started', () => {
      const { source } = makeSource();
      const sync = new ConfigSync({ publisher: stubPublisher(), source });
      expect(() => sync.stop()).not.toThrow();
    });
  });

  describe('publish flow', () => {
    it('publishes the converted config on isDiscoverable=true', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
      });
      sync.start();
      emit(serviceCfg);
      await sync.flush();

      expect(stub.publishedConfigs).toHaveLength(1);
      expect(stub.publishedConfigs[0].name).toBe('Bus 42');
      expect(stub.publishedConfigs[0].capabilities.sort()).toEqual(['eta_query', 'route_info']);
      expect(stub.unpublishCount).toBe(0);
    });

    it('calls unpublish when isDiscoverable flips to false', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
      });
      sync.start();
      emit({ ...serviceCfg, isDiscoverable: false });
      await sync.flush();

      expect(stub.publishedConfigs).toHaveLength(0);
      expect(stub.unpublishCount).toBe(1);
    });

    it('calls unpublish when config is cleared (null)', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
      });
      sync.start();
      emit(null);
      await sync.flush();

      expect(stub.unpublishCount).toBe(1);
      expect(stub.publishedConfigs).toHaveLength(0);
    });

    it('syncNow returns a promise resolving to the actual sync', async () => {
      const { source } = makeSource();
      const stub = new StubPublisher();
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
      });
      await sync.syncNow(serviceCfg);
      expect(stub.publishedConfigs).toHaveLength(1);
    });
  });

  describe('debounce / in-flight collapse', () => {
    it('collapses burst of updates into one trailing sync', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
      });

      // Block the first publish until we release it.
      const gate = deferred();
      stub.nextPublishBlock = gate.promise;

      sync.start();
      emit({ ...serviceCfg, name: 'v1' }); // kicks off publish #1
      emit({ ...serviceCfg, name: 'v2' }); // queued as pending
      emit({ ...serviceCfg, name: 'v3' }); // overwrites pending → v3
      emit({ ...serviceCfg, name: 'v4' }); // overwrites pending → v4

      gate.resolve();
      await sync.flush();

      // Two syncs total: the first (v1) + one trailing (v4, latest seen).
      expect(stub.publishedConfigs.map((c) => c.name)).toEqual(['v1', 'v4']);
    });

    it('awaits in-flight before starting next sync', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
      });

      const gate = deferred();
      stub.nextPublishBlock = gate.promise;

      sync.start();
      emit(serviceCfg); // starts publish, blocks on gate
      emit({ ...serviceCfg, isDiscoverable: false }); // queued as pending

      // Trailing sync must not run until the gated publish resolves.
      await Promise.resolve();
      expect(stub.unpublishCount).toBe(0);

      gate.resolve();
      await sync.flush();

      expect(stub.publishedConfigs).toHaveLength(1);
      expect(stub.unpublishCount).toBe(1);
    });
  });

  describe('error handling', () => {
    it('surfaces publish errors via onError', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      stub.nextPublishError = new Error('PDS down');
      const errors: unknown[] = [];
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
        onError: (e) => errors.push(e),
      });
      sync.start();
      emit(serviceCfg);
      await sync.flush();

      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('PDS down');
    });

    it('does not propagate errors back through the event source', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      stub.nextPublishError = new Error('boom');
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
        // onError omitted — default swallow
      });
      sync.start();
      expect(() => emit(serviceCfg)).not.toThrow();
      await sync.flush();
    });

    it('continues syncing after a failure', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      stub.nextPublishError = new Error('transient');
      const errors: unknown[] = [];
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
        onError: (e) => errors.push(e),
      });
      sync.start();
      emit(serviceCfg);
      await sync.flush();
      expect(errors).toHaveLength(1);
      expect(stub.publishedConfigs).toHaveLength(0);

      // Next event should succeed.
      emit({ ...serviceCfg, name: 'recovered' });
      await sync.flush();
      expect(stub.publishedConfigs).toHaveLength(1);
      expect(stub.publishedConfigs[0].name).toBe('recovered');
    });

    it('onSynced fires on success with uri', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      const synced: unknown[] = [];
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
        onSynced: (r) => synced.push(r),
      });
      sync.start();
      emit(serviceCfg);
      await sync.flush();

      expect(synced).toEqual([{ published: true, uri: 'at://did/col/self' }]);
    });

    it('onSynced reports published=false for unpublish', async () => {
      const { source, emit } = makeSource();
      const stub = new StubPublisher();
      const synced: unknown[] = [];
      const sync = new ConfigSync({
        publisher: stub as unknown as ServicePublisher,
        source,
        onSynced: (r) => synced.push(r),
      });
      sync.start();
      emit(null);
      await sync.flush();

      expect(synced).toEqual([{ published: false }]);
    });
  });
});
