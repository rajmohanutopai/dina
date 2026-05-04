/**
 * Task 6.20 — ProfileAutoRepublisher tests.
 */

import {
  DEFAULT_REPUBLISH_INITIAL_BACKOFF_MS,
  DEFAULT_REPUBLISH_MAX_ATTEMPTS,
  DEFAULT_REPUBLISH_MAX_BACKOFF_MS,
  ProfileAutoRepublisher,
  type AutoRepublisherEvent,
  type BuildProfileFn,
  type ConfigSnapshotReader,
} from '../src/appview/profile_auto_republisher';
import type {
  BuildProfileInput,
  ServiceProfileRecord,
} from '../src/appview/profile_builder';
import type {
  PublishOutcome,
  ServiceProfilePublisher,
} from '../src/appview/service_profile_publisher';

function stubReloader(config: BuildProfileInput | null): ConfigSnapshotReader<BuildProfileInput> {
  return {
    getCurrent: () => config,
    isReady: () => config !== null,
  };
}

function validConfig(): BuildProfileInput {
  return {
    name: 'SF Transit',
    isPublic: true,
    capabilitySchemas: {
      eta_query: {
        description: 'bus',
        params: { type: 'object' },
        result: { type: 'object' },
      },
    },
    responsePolicy: { eta_query: 'auto' },
  };
}

function okProfile(): ServiceProfileRecord {
  return {
    $type: 'com.dina.service.profile',
    name: 'SF Transit',
    isPublic: true,
    capabilities: ['eta_query'],
    capabilitySchemas: {
      eta_query: {
        description: 'bus',
        params: { type: 'object' },
        result: { type: 'object' },
        schema_hash: 'hash-abc',
      },
    },
    responsePolicy: { eta_query: 'auto' },
  };
}

function stubBuildFn(record: ServiceProfileRecord = okProfile()): BuildProfileFn {
  return () => record;
}

function stubPublisher(
  outcome: PublishOutcome,
  calls?: { count: number },
): Pick<ServiceProfilePublisher, 'publish'> {
  return {
    publish: async () => {
      if (calls) calls.count++;
      return outcome;
    },
  };
}

function mockScheduler() {
  const queue: Array<{ fn: () => void; fireAt: number; handle: number }> = [];
  let nextHandle = 1;
  let now = 0;
  return {
    setTimerFn: (fn: () => void, ms: number): unknown => {
      const handle = nextHandle++;
      queue.push({ fn, fireAt: now + ms, handle });
      return handle;
    },
    clearTimerFn: (h: unknown): void => {
      const idx = queue.findIndex((e) => e.handle === h);
      if (idx !== -1) queue.splice(idx, 1);
    },
    advance: (ms: number): void => {
      now += ms;
      queue.sort((a, b) => a.fireAt - b.fireAt);
      while (queue.length && queue[0]!.fireAt <= now) {
        const entry = queue.shift()!;
        entry.fn();
      }
    },
    pending: () => queue.length,
  };
}

describe('ProfileAutoRepublisher (task 6.20)', () => {
  describe('construction', () => {
    it.each(['configReloader', 'buildFn', 'publisher'] as const)(
      'throws when %s missing',
      (missing) => {
        const opts = {
          configReloader: stubReloader(validConfig()),
          buildFn: stubBuildFn(),
          publisher: stubPublisher({ ok: true, cid: 'x', uri: 'y' }),
        };
        delete (opts as Record<string, unknown>)[missing];
        expect(() =>
          new ProfileAutoRepublisher(
            opts as unknown as ConstructorParameters<typeof ProfileAutoRepublisher>[0],
          ),
        ).toThrow(new RegExp(missing));
      },
    );
  });

  describe('config change → publish', () => {
    it('on config_change_detected, publishes + returns to idle', async () => {
      const events: AutoRepublisherEvent[] = [];
      const calls = { count: 0 };
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: stubPublisher({ ok: true, cid: 'bafy', uri: 'at://x' }, calls),
        onEvent: (e) => events.push(e),
      });
      rep.onConfigEvent({ kind: 'changed', previous: validConfig(), next: validConfig() });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(1);
      expect(rep.getState()).toBe('idle');
      expect(events.some((e) => e.kind === 'publish_ok')).toBe(true);
    });

    it('also triggers on first_load', async () => {
      const calls = { count: 0 };
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: stubPublisher({ ok: true, cid: 'x', uri: 'y' }, calls),
      });
      rep.onConfigEvent({ kind: 'first_load', config: validConfig() });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(1);
    });

    it('ignores unchanged + fetch_failed events', async () => {
      const calls = { count: 0 };
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: stubPublisher({ ok: true, cid: 'x', uri: 'y' }, calls),
      });
      rep.onConfigEvent({ kind: 'unchanged' });
      rep.onConfigEvent({ kind: 'fetch_failed', error: 'x' });
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(0);
    });

    it('no current config → publish cycle is a no-op', async () => {
      const calls = { count: 0 };
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(null),
        buildFn: stubBuildFn(),
        publisher: stubPublisher({ ok: true, cid: 'x', uri: 'y' }, calls),
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(0);
      expect(rep.getState()).toBe('idle');
    });
  });

  describe('triggerPublish', () => {
    it('manual trigger works outside of config events', async () => {
      const calls = { count: 0 };
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: stubPublisher({ ok: true, cid: 'x', uri: 'y' }, calls),
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(1);
    });

    it('no-op when in-flight (coalesces)', async () => {
      let resolvePublish!: (o: PublishOutcome) => void;
      const calls = { count: 0 };
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: {
          publish: () =>
            new Promise<PublishOutcome>((resolve) => {
              calls.count++;
              resolvePublish = resolve;
            }),
        },
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      // Second trigger while in-flight should NOT fire another publish.
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(1);
      resolvePublish({ ok: true, cid: 'x', uri: 'y' });
      await new Promise((r) => setImmediate(r));
    });
  });

  describe('retry on failure', () => {
    it('network_error → backoff + retry', async () => {
      const sched = mockScheduler();
      const events: AutoRepublisherEvent[] = [];
      const outcomes: PublishOutcome[] = [
        { ok: false, reason: 'network_error', error: 'ENETDOWN' },
        { ok: true, cid: 'cid', uri: 'uri' },
      ];
      let i = 0;
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: { publish: async () => outcomes[i++]! },
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
        onEvent: (e) => events.push(e),
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      // After first failure → state=backoff, timer set for initial backoff.
      expect(rep.getState()).toBe('backoff');
      expect(sched.pending()).toBe(1);
      // Fire the retry.
      sched.advance(DEFAULT_REPUBLISH_INITIAL_BACKOFF_MS);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(rep.getState()).toBe('idle');
      expect(events.some((e) => e.kind === 'publish_ok')).toBe(true);
    });

    it('rejected_by_pds → backoff + retry', async () => {
      const sched = mockScheduler();
      const outcomes: PublishOutcome[] = [
        { ok: false, reason: 'rejected_by_pds', status: 500, error: 'server down' },
        { ok: true, cid: 'cid', uri: 'uri' },
      ];
      let i = 0;
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: { publish: async () => outcomes[i++]! },
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(rep.getState()).toBe('backoff');
      sched.advance(DEFAULT_REPUBLISH_INITIAL_BACKOFF_MS);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(rep.getState()).toBe('idle');
    });

    it('backoff doubles per attempt', async () => {
      const sched = mockScheduler();
      const events: AutoRepublisherEvent[] = [];
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: {
          publish: async () => ({
            ok: false,
            reason: 'network_error',
            error: 'down',
          }),
        },
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
        onEvent: (e) => events.push(e),
        maxAttempts: 4,
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      // Fire three retries.
      for (let i = 0; i < 3; i++) {
        sched.advance(1_000_000); // way beyond max backoff; fires the queued retry
        await new Promise((r) => setImmediate(r));
      }
      const failedEvents = events.filter((e) => e.kind === 'publish_failed');
      // Backoffs doubling: 1000, 2000, 4000, null (gave up).
      expect(failedEvents[0]).toMatchObject({ attempt: 1, nextBackoffMs: 1000 });
      expect(failedEvents[1]).toMatchObject({ attempt: 2, nextBackoffMs: 2000 });
      expect(failedEvents[2]).toMatchObject({ attempt: 3, nextBackoffMs: 4000 });
    });

    it('max attempts reached → gave_up', async () => {
      const sched = mockScheduler();
      const events: AutoRepublisherEvent[] = [];
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: {
          publish: async () => ({
            ok: false,
            reason: 'network_error',
            error: 'down',
          }),
        },
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
        onEvent: (e) => events.push(e),
        maxAttempts: 2,
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      sched.advance(1_000_000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(rep.getState()).toBe('given_up');
      const gave = events.find((e) => e.kind === 'gave_up') as Extract<
        AutoRepublisherEvent,
        { kind: 'gave_up' }
      >;
      expect(gave.attempts).toBe(2);
    });

    it('DEFAULTS: initial=1s, max=60s, attempts=5', () => {
      expect(DEFAULT_REPUBLISH_INITIAL_BACKOFF_MS).toBe(1_000);
      expect(DEFAULT_REPUBLISH_MAX_BACKOFF_MS).toBe(60_000);
      expect(DEFAULT_REPUBLISH_MAX_ATTEMPTS).toBe(5);
    });
  });

  describe('terminal on malformed', () => {
    it('malformed_profile outcome → does NOT retry', async () => {
      const calls = { count: 0 };
      const events: AutoRepublisherEvent[] = [];
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: {
          publish: async () => {
            calls.count++;
            return { ok: false, reason: 'malformed_profile', detail: 'bad' };
          },
        },
        onEvent: (e) => events.push(e),
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(1);
      expect(rep.getState()).toBe('idle');
      expect(
        events.some((e) => e.kind === 'build_validation_failed'),
      ).toBe(true);
    });

    it('build function throw → build_validation_failed + no publish', async () => {
      const calls = { count: 0 };
      const events: AutoRepublisherEvent[] = [];
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: () => {
          throw new Error('cannot build — responsePolicy mismatch');
        },
        publisher: stubPublisher({ ok: true, cid: 'x', uri: 'y' }, calls),
        onEvent: (e) => events.push(e),
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(calls.count).toBe(0);
      const validation = events.find(
        (e) => e.kind === 'build_validation_failed',
      ) as Extract<AutoRepublisherEvent, { kind: 'build_validation_failed' }>;
      expect(validation.error).toMatch(/responsePolicy mismatch/);
    });
  });

  describe('stop', () => {
    it('clears pending backoff timer', async () => {
      const sched = mockScheduler();
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: {
          publish: async () => ({
            ok: false,
            reason: 'network_error',
            error: 'down',
          }),
        },
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(sched.pending()).toBe(1);
      rep.stop();
      expect(sched.pending()).toBe(0);
      expect(rep.getState()).toBe('idle');
    });

    it('stop from given_up returns to idle', async () => {
      const sched = mockScheduler();
      const rep = new ProfileAutoRepublisher({
        configReloader: stubReloader(validConfig()),
        buildFn: stubBuildFn(),
        publisher: {
          publish: async () => ({
            ok: false,
            reason: 'network_error',
            error: 'x',
          }),
        },
        setTimerFn: sched.setTimerFn,
        clearTimerFn: sched.clearTimerFn,
        maxAttempts: 1,
      });
      rep.triggerPublish();
      await new Promise((r) => setImmediate(r));
      expect(rep.getState()).toBe('given_up');
      rep.stop();
      expect(rep.getState()).toBe('idle');
    });
  });
});
