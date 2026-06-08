/**
 * The publish-worker scheduler glue: ticks on start + foreground, no-ops without
 * a booted node / publisher / repo, and is idempotent. The drain LOGIC is tested
 * in review_publish_worker.test; here we pin the wiring via injected seams (no
 * real PDS).
 */

import { AppState } from 'react-native';

import { InMemoryReviewPublishRepository } from '@dina/core';

import { startReviewPublishWorker } from '../../src/peerlens/review_publish_autodrain';

import type { PDSPublisher } from '@dina/brain';

const PUBLISHER = {} as unknown as PDSPublisher;
const NODE = { did: 'did:plc:owner', pdsPublisher: PUBLISHER };

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
