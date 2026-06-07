/**
 * Guided-demo replay request signal — fire + subscribe + unsubscribe.
 */

import {
  requestGuidedDemoReplay,
  subscribeGuidedDemoReplay,
  resetGuidedDemoReplayForTest,
} from '../../src/guided_demo/replay_request';

beforeEach(() => {
  resetGuidedDemoReplayForTest();
});

describe('guided-demo replay request', () => {
  it('fires every subscriber on request', () => {
    const a = jest.fn();
    const b = jest.fn();
    subscribeGuidedDemoReplay(a);
    subscribeGuidedDemoReplay(b);
    requestGuidedDemoReplay();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stops firing after unsubscribe', () => {
    const cb = jest.fn();
    const dispose = subscribeGuidedDemoReplay(cb);
    requestGuidedDemoReplay();
    dispose();
    requestGuidedDemoReplay();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not block the others', () => {
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    subscribeGuidedDemoReplay(bad);
    subscribeGuidedDemoReplay(good);
    expect(() => requestGuidedDemoReplay()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('reset clears all subscribers', () => {
    const cb = jest.fn();
    subscribeGuidedDemoReplay(cb);
    resetGuidedDemoReplayForTest();
    requestGuidedDemoReplay();
    expect(cb).not.toHaveBeenCalled();
  });
});
