/**
 * CORE-P2-J01 + J02 — ConfigEventChannel tests.
 */

import {
  ConfigEventChannel,
  configEventChannel,
  resetConfigEventChannel,
  setConfigEventChannel,
  type ConfigChangedEvent,
} from '../../src/service/config_event_channel';

describe('ConfigEventChannel — construction', () => {
  it('rejects non-positive maxQueueSize', () => {
    expect(() => new ConfigEventChannel({ maxQueueSize: 0 })).toThrow(/maxQueueSize/);
    expect(() => new ConfigEventChannel({ maxQueueSize: -1 })).toThrow(/maxQueueSize/);
    expect(() => new ConfigEventChannel({ maxQueueSize: 1.5 })).toThrow(/maxQueueSize/);
  });

  it('defaults maxQueueSize to 16', () => {
    const ch = new ConfigEventChannel();
    for (let i = 0; i < 16; i++) ch.emitConfigChanged();
    expect(ch.queueSize()).toBe(16);
    ch.emitConfigChanged(); // overflow
    expect(ch.queueSize()).toBe(16); // dropped oldest
  });
});

describe('ConfigEventChannel — emit + subscribe', () => {
  it('when no subscriber, events queue', () => {
    const ch = new ConfigEventChannel();
    ch.emitConfigChanged();
    ch.emitConfigChanged();
    expect(ch.queueSize()).toBe(2);
  });

  it('when subscriber is active, events bypass the queue', () => {
    const ch = new ConfigEventChannel();
    const seen: ConfigChangedEvent[] = [];
    ch.subscribe((e) => seen.push(e));
    ch.emitConfigChanged();
    expect(seen).toHaveLength(1);
    expect(ch.queueSize()).toBe(0);
  });

  it('first subscriber drains the pre-buffered queue in order', () => {
    let t = 1_000;
    const ch = new ConfigEventChannel({ nowMsFn: () => t });
    ch.emitConfigChanged();
    t = 2_000;
    ch.emitConfigChanged();
    t = 3_000;
    ch.emitConfigChanged();
    expect(ch.queueSize()).toBe(3);

    const seen: ConfigChangedEvent[] = [];
    ch.subscribe((e) => seen.push(e));
    expect(seen.map((e) => e.timestamp)).toEqual([1_000, 2_000, 3_000]);
    expect(ch.queueSize()).toBe(0);
  });

  it('late subscriber gets events that arrive while subscribed', () => {
    const ch = new ConfigEventChannel();
    const a: ConfigChangedEvent[] = [];
    const b: ConfigChangedEvent[] = [];
    ch.subscribe((e) => a.push(e));
    ch.emitConfigChanged();
    ch.subscribe((e) => b.push(e));
    ch.emitConfigChanged();

    expect(a).toHaveLength(2); // both events
    expect(b).toHaveLength(1); // only the second
  });

  it('disposer removes listener', () => {
    const ch = new ConfigEventChannel();
    const seen: ConfigChangedEvent[] = [];
    const dispose = ch.subscribe((e) => seen.push(e));
    ch.emitConfigChanged();
    dispose();
    ch.emitConfigChanged();
    expect(seen).toHaveLength(1);
    // Second emit is queued (no listeners).
    expect(ch.queueSize()).toBe(1);
  });

  it('multiple subscribers each get every event', () => {
    const ch = new ConfigEventChannel();
    const a: ConfigChangedEvent[] = [];
    const b: ConfigChangedEvent[] = [];
    ch.subscribe((e) => a.push(e));
    ch.subscribe((e) => b.push(e));
    ch.emitConfigChanged();
    ch.emitConfigChanged();
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
  });

  it('listenerCount reflects active subscriptions', () => {
    const ch = new ConfigEventChannel();
    expect(ch.listenerCount()).toBe(0);
    const d = ch.subscribe(() => {
      /* no-op */
    });
    expect(ch.listenerCount()).toBe(1);
    d();
    expect(ch.listenerCount()).toBe(0);
  });
});

describe('ConfigEventChannel — drop-oldest overflow', () => {
  it('drops oldest event when queue exceeds maxQueueSize', () => {
    let t = 1_000;
    const ch = new ConfigEventChannel({
      maxQueueSize: 3,
      nowMsFn: () => t++,
    });
    ch.emitConfigChanged(); // t=1000
    ch.emitConfigChanged(); // t=1001
    ch.emitConfigChanged(); // t=1002 — queue full
    ch.emitConfigChanged(); // t=1003 — drops 1000
    expect(ch.queueSize()).toBe(3);

    const seen: ConfigChangedEvent[] = [];
    ch.subscribe((e) => seen.push(e));
    expect(seen.map((e) => e.timestamp)).toEqual([1_001, 1_002, 1_003]);
  });

  it('onDrop callback receives the dropped event', () => {
    const dropped: ConfigChangedEvent[] = [];
    let t = 1_000;
    const ch = new ConfigEventChannel({
      maxQueueSize: 2,
      nowMsFn: () => t++,
      onDrop: (e) => dropped.push(e),
    });
    ch.emitConfigChanged();
    ch.emitConfigChanged();
    ch.emitConfigChanged(); // overflow → drops first
    ch.emitConfigChanged(); // overflow → drops second

    expect(dropped.map((e) => e.timestamp)).toEqual([1_000, 1_001]);
  });

  it('throwing onDrop does not break the enqueue path', () => {
    const ch = new ConfigEventChannel({
      maxQueueSize: 1,
      onDrop: () => {
        throw new Error('observer broke');
      },
    });
    ch.emitConfigChanged();
    // Must not throw despite the faulty observer.
    expect(() => ch.emitConfigChanged()).not.toThrow();
    expect(ch.queueSize()).toBe(1);
  });
});

describe('ConfigEventChannel — error isolation', () => {
  it('one broken listener does not stop others', () => {
    const ch = new ConfigEventChannel();
    const seen: ConfigChangedEvent[] = [];
    ch.subscribe(() => {
      throw new Error('bad listener');
    });
    ch.subscribe((e) => seen.push(e));
    ch.emitConfigChanged();
    expect(seen).toHaveLength(1);
  });

  it('broken listener on queue drain does not stop drain to others', () => {
    const ch = new ConfigEventChannel();
    ch.emitConfigChanged();
    ch.emitConfigChanged();
    const seen: ConfigChangedEvent[] = [];
    ch.subscribe(() => {
      throw new Error('first listener broke');
    });
    ch.subscribe((e) => seen.push(e));
    // Third emit should fan-out to both; the queued events already drained
    // only to the first listener (since that subscribe() happened before
    // the second).
    expect(seen).toHaveLength(0); // second listener didn't get queued events
    ch.emitConfigChanged();
    expect(seen).toHaveLength(1);
  });
});

describe('ConfigEventChannel — default singleton', () => {
  beforeEach(() => resetConfigEventChannel());
  afterAll(() => resetConfigEventChannel());

  it('returns the same instance across calls', () => {
    const a = configEventChannel();
    const b = configEventChannel();
    expect(a).toBe(b);
  });

  it('setConfigEventChannel swaps the instance', () => {
    const custom = new ConfigEventChannel({ maxQueueSize: 2 });
    setConfigEventChannel(custom);
    expect(configEventChannel()).toBe(custom);
  });

  it('resetConfigEventChannel clears state', () => {
    configEventChannel().emitConfigChanged();
    expect(configEventChannel().queueSize()).toBe(1);
    resetConfigEventChannel();
    expect(configEventChannel().queueSize()).toBe(0);
  });
});

describe('Integration: setServiceConfig fires the event', () => {
  // Import lazily so we can re-import between this suite and the channel
  // suites above without test-order dependencies.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    setServiceConfig,
    clearServiceConfig,
    resetServiceConfigState,
  } = require('../../src/service/service_config');

  const validConfig = {
    isDiscoverable: true,
    name: 'Bus 42',
    capabilities: {
      eta_query: {
        mcpServer: 'transit',
        mcpTool: 'get_eta',
        responsePolicy: 'auto' as const,
      },
    },
  };

  beforeEach(() => {
    resetConfigEventChannel();
    resetServiceConfigState();
  });

  afterAll(() => {
    resetConfigEventChannel();
    resetServiceConfigState();
  });

  it('setServiceConfig emits a config_changed event', () => {
    const seen: ConfigChangedEvent[] = [];
    configEventChannel().subscribe((e) => seen.push(e));
    setServiceConfig(validConfig);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('config_changed');
  });

  it('clearServiceConfig also emits', () => {
    const seen: ConfigChangedEvent[] = [];
    configEventChannel().subscribe((e) => seen.push(e));
    setServiceConfig(validConfig);
    clearServiceConfig();
    expect(seen).toHaveLength(2);
  });
});
