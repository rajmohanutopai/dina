/**
 * The publish-worker scheduler glue: ticks on start + foreground, no-ops without
 * a booted node / publisher / repo, and is idempotent. The drain LOGIC is tested
 * in review_publish_worker.test; here we pin the wiring via injected seams (no
 * real PDS).
 */

import { AppState } from 'react-native';

import { InMemoryReviewPublishRepository } from '@dina/core';

// Mock the inject path so the test-inject flag is deterministic (the real one
// reads an env var). Default OFF so the no-publisher cases no-op as before.
jest.mock('../../src/peerlens/inject_publish', () => ({
  __esModule: true,
  isTestPublishConfigured: jest.fn().mockReturnValue(false),
  injectPublish: jest.fn(),
  INJECT_SENTINEL_PUBLISHER: { __inject_sentinel: true },
}));

import { INJECT_SENTINEL_PUBLISHER, isTestPublishConfigured } from '../../src/peerlens/inject_publish';
import {
  startReviewPublishWorker,
  canDrainReviewPublish,
  drainReviewPublishNow,
} from '../../src/peerlens/review_publish_autodrain';

import type { PDSPublisher } from '@dina/brain';

const mockInjectConfigured = isTestPublishConfigured as jest.MockedFunction<typeof isTestPublishConfigured>;
const PUBLISHER = {} as unknown as PDSPublisher;
const NODE = { did: 'did:plc:owner', pdsPublisher: PUBLISHER };

afterEach(() => mockInjectConfigured.mockReturnValue(false));

describe('startReviewPublishWorker', () => {
  it('ticks once on start when a node + publisher + repo are present', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const runTick = jest.fn(async () => ({ reclaimed: 0, published: 0, requeued: 0, failed: 0 }));
    const stop = startReviewPublishWorker({ getRepo: () => repo, getNode: () => NODE, runTick });
    await Promise.resolve(); // let the fire-and-forget tick settle
    expect(runTick).toHaveBeenCalledWith(repo, 'did:plc:owner', PUBLISHER);
    stop();
  });

  it('ticks again on app foreground', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const runTick = jest.fn(async () => ({ reclaimed: 0, published: 0, requeued: 0, failed: 0 }));
    const addSpy = jest.spyOn(AppState, 'addEventListener');
    const stop = startReviewPublishWorker({ getRepo: () => repo, getNode: () => NODE, runTick });
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(1);
    // Simulate a foreground transition through the registered listener.
    const handler = addSpy.mock.calls[0][1] as (s: string) => void;
    handler('active');
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(2);
    handler('background');
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(2); // background doesn't tick
    stop();
    addSpy.mockRestore();
  });

  it('no-ops without a booted node / publisher / repo', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const runTick = jest.fn(async () => ({ reclaimed: 0, published: 0, requeued: 0, failed: 0 }));

    let stop = startReviewPublishWorker({ getRepo: () => null, getNode: () => NODE, runTick });
    await Promise.resolve();
    expect(runTick).not.toHaveBeenCalled();
    stop();

    stop = startReviewPublishWorker({ getRepo: () => repo, getNode: () => null, runTick });
    await Promise.resolve();
    expect(runTick).not.toHaveBeenCalled();
    stop();

    stop = startReviewPublishWorker({
      getRepo: () => repo,
      getNode: () => ({ did: 'did:plc:owner', pdsPublisher: undefined }),
      runTick,
    });
    await Promise.resolve();
    expect(runTick).not.toHaveBeenCalled();
    stop();
  });

  it('is idempotent — a second start while active is a no-op', async () => {
    const repo = new InMemoryReviewPublishRepository();
    const runTick = jest.fn(async () => ({ reclaimed: 0, published: 0, requeued: 0, failed: 0 }));
    const stop1 = startReviewPublishWorker({ getRepo: () => repo, getNode: () => NODE, runTick });
    const stop2 = startReviewPublishWorker({ getRepo: () => repo, getNode: () => NODE, runTick });
    await Promise.resolve();
    expect(runTick).toHaveBeenCalledTimes(1); // second start did nothing
    stop2(); // no-op stop
    stop1();
  });
});

describe('inject-only builds (no real PDS publisher)', () => {
  const injectNode = { did: 'did:plc:owner', pdsPublisher: undefined };

  it('canDrainReviewPublish is FALSE without a publisher when inject is off', () => {
    mockInjectConfigured.mockReturnValue(false);
    const repo = new InMemoryReviewPublishRepository();
    expect(canDrainReviewPublish({ getRepo: () => repo, getNode: () => injectNode })).toBe(false);
  });

  it('canDrainReviewPublish is TRUE without a publisher when inject IS configured', () => {
    mockInjectConfigured.mockReturnValue(true);
    const repo = new InMemoryReviewPublishRepository();
    expect(canDrainReviewPublish({ getRepo: () => repo, getNode: () => injectNode })).toBe(true);
  });

  it('drains an inject-only build by ticking with the inject sentinel publisher', async () => {
    mockInjectConfigured.mockReturnValue(true);
    const repo = new InMemoryReviewPublishRepository();
    const runTick = jest.fn(async () => ({ reclaimed: 0, published: 0, requeued: 0, failed: 0 }));
    await drainReviewPublishNow({ getRepo: () => repo, getNode: () => injectNode, runTick });
    // The queued inject job is no longer stranded — the worker runs with the
    // sentinel publisher (the real default tick would route to injectPublish).
    expect(runTick).toHaveBeenCalledWith(repo, 'did:plc:owner', INJECT_SENTINEL_PUBLISHER);
  });

  it('inject takes PRECEDENCE over a real publisher (never drains dev reviews to the real PDS)', async () => {
    mockInjectConfigured.mockReturnValue(true);
    const repo = new InMemoryReviewPublishRepository();
    const runTick = jest.fn(async () => ({ reclaimed: 0, published: 0, requeued: 0, failed: 0 }));
    // A REAL publisher is present, but inject is configured — matching the inline
    // submit, the worker must still publish via inject, not the user's PDS.
    await drainReviewPublishNow({
      getRepo: () => repo,
      getNode: () => ({ did: 'did:plc:owner', pdsPublisher: PUBLISHER }),
      runTick,
    });
    expect(runTick).toHaveBeenCalledWith(repo, 'did:plc:owner', INJECT_SENTINEL_PUBLISHER);
  });
});

describe('lease reaper runs even without a way to publish', () => {
  it('reclaims an expired-lease publishing job so it regains Cancel/Dismiss', async () => {
    mockInjectConfigured.mockReturnValue(false); // no inject
    const repo = new InMemoryReviewPublishRepository();
    repo.create({
      jobId: 'j1',
      ownerDid: 'did:plc:owner',
      rkey: 'r',
      recordJSON: '{}',
      draftJSON: '{}',
      createdAt: 1,
    });
    repo.claim('j1', 1, 60_000); // publishing; lease expires at 60_001
    // No publisher + inject off → NO publish strategy. The reaper must still run.
    await drainReviewPublishNow({
      getRepo: () => repo,
      getNode: () => ({ did: 'did:plc:owner', pdsPublisher: undefined }),
      now: () => 60_002, // past the lease
    });
    expect(repo.getById('j1')?.status).toBe('queued'); // reclaimed → Cancel/Dismiss returns
  });
});
