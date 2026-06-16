/**
 * useGuidedDemoGate — first-run / recovery / running state machine.
 * Real core engine + controller; only cache rehydration is mocked.
 */

jest.mock('../../src/guided_demo/rehydrate', () => {
  const noop = jest.fn(async () => undefined);
  return { refreshCachesForCurrentScope: noop, rehydrateUserScopeCaches: noop };
});

import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  currentDataScope,
  getActiveDemo,
  setActiveDemo,
  resetDataScope,
  setGuidedDemoIdFactory,
  resetGuidedDemoIdFactory,
  clearScopedCleanups,
  registerScopedCleanup,
  markGuidedDemoEntrySeen,
} from '@dina/core';

import { useGuidedDemoGate } from '../../src/guided_demo/useGuidedDemoGate';
import type { GuidedDemoSeams } from '../../src/guided_demo/runner';
import { DEMO_STEPS } from '../../src/guided_demo/content';
import {
  requestGuidedDemoReplay,
  resetGuidedDemoReplayForTest,
} from '../../src/guided_demo/replay_request';
import { resetKVStore } from '../../../core/src/kv/store';

/** Fake runner seams so the gate's advance/teardown can be asserted without
 *  touching the real composer / approval manager. */
function fakeSeams(): {
  make: () => GuidedDemoSeams;
  rec: {
    sends: number;
    recommendations: number;
    serviceCards: number;
    servicePreviewCards: number;
    publishConfirms: number;
    approvals: string[];
    denied: string[];
    cards: number;
    d2dMessages: number;
    reviewCards: number;
  };
} {
  const rec = {
    sends: 0,
    recommendations: 0,
    serviceCards: 0,
    servicePreviewCards: 0,
    publishConfirms: 0,
    approvals: [] as string[],
    denied: [] as string[],
    cards: 0,
    d2dMessages: 0,
    reviewCards: 0,
  };
  const seams: GuidedDemoSeams = {
    async send() {
      rec.sends += 1;
    },
    async postRecommendation() {
      rec.recommendations += 1;
    },
    async postServiceCard() {
      rec.serviceCards += 1;
    },
    postServicePreviewCard() {
      rec.servicePreviewCards += 1;
    },
    async confirmPublish() {
      rec.publishConfirms += 1;
      return true;
    },
    requestApproval(req) {
      rec.approvals.push(req.id);
      return req.id;
    },
    denyApproval(id) {
      rec.denied.push(id);
    },
    postDemoCard() {
      rec.cards += 1;
    },
    postUserMessage() {
      /* task hand-off message — not asserted here */
    },
    navigate() {
      /* navigation — not asserted here */
    },
    async postD2DMessage() {
      rec.d2dMessages += 1;
    },
    postReviewCard() {
      rec.reviewCards += 1;
    },
    seedPerson() {
      /* people seeding — not asserted here */
    },
    seedReminders() {
      /* reminder cards — not asserted here */
    },
    async delay() {
      /* no pause in tests */
    },
  };
  return { make: () => seams, rec };
}

const CHAT_STEPS = DEMO_STEPS.filter((s) => s.kind === undefined || s.kind === 'chat');
// Total send() calls across all chat steps — a step may have several remembers
// (the people step and the private step each have two).
const TOTAL_SENDS = CHAT_STEPS.reduce((n, s) => n + (s.remembers?.length ?? 1), 0);
const RECOMMEND_STEP_COUNT = DEMO_STEPS.filter((s) => s.kind === 'recommend').length;

describe('useGuidedDemoGate', () => {
  beforeEach(() => {
    resetKVStore();
    resetDataScope();
    resetGuidedDemoReplayForTest();
    clearScopedCleanups();
    setGuidedDemoIdFactory(() => 'run1');
    registerScopedCleanup({ table: 'reminders', deleteScope: () => 0 });
  });
  afterEach(() => {
    clearScopedCleanups();
    resetGuidedDemoIdFactory();
  });

  it('first run → entry', async () => {
    const { result } = renderHook(() => useGuidedDemoGate());
    await waitFor(() => expect(result.current.phase).toBe('entry'));
  });

  it('already offered → running', async () => {
    await markGuidedDemoEntrySeen();
    const { result } = renderHook(() => useGuidedDemoGate());
    await waitFor(() => expect(result.current.phase).toBe('running'));
  });

  it('a pending demo record → recovery (priority over entry)', async () => {
    await setActiveDemo({ activeDemoScope: 'guided_demo:run1', startedAt: 1, step: '' });
    const { result } = renderHook(() => useGuidedDemoGate());
    await waitFor(() => expect(result.current.phase).toBe('recovery'));
  });

  it('startDemo → running + demoActive + scope + recovery record', async () => {
    const { result } = renderHook(() => useGuidedDemoGate());
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });
    expect(result.current.phase).toBe('running');
    expect(result.current.demoActive).toBe(true);
    expect(currentDataScope()).toBe('guided_demo:run1');
    expect((await getActiveDemo())?.activeDemoScope).toBe('guided_demo:run1');
  });

  it('skip → running, on user, no demo', async () => {
    const { result } = renderHook(() => useGuidedDemoGate());
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.skip();
    });
    expect(result.current.phase).toBe('running');
    expect(result.current.demoActive).toBe(false);
    expect(currentDataScope()).toBe('user');
  });

  it('replay request starts the demo from the running app (any-time entry)', async () => {
    // Past first run: entry already seen → boot lands on running (no entry).
    await markGuidedDemoEntrySeen();
    const { make } = fakeSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('running'));
    expect(result.current.demoActive).toBe(false);
    await act(async () => {
      requestGuidedDemoReplay();
    });
    await waitFor(() => expect(result.current.demoActive).toBe(true));
    expect(result.current.phase).toBe('running');
    expect(currentDataScope()).toBe('guided_demo:run1');
    expect(result.current.currentAction?.id).toBe(DEMO_STEPS[0]?.id);
  });

  it('replay request is ignored while a demo is already active', async () => {
    const { make } = fakeSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });
    await act(async () => {
      await result.current.advanceDemo();
    });
    expect(result.current.step).toBe(2);
    await act(async () => {
      requestGuidedDemoReplay();
    });
    // No restart: a replay mid-demo would reset the cursor to step 1.
    expect(result.current.step).toBe(2);
  });

  it('replay request is ignored before the app is running (entry phase)', async () => {
    const { result } = renderHook(() => useGuidedDemoGate());
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      requestGuidedDemoReplay();
    });
    // A replay must not bypass the first-run entry screen.
    expect(result.current.phase).toBe('entry');
    expect(result.current.demoActive).toBe(false);
  });

  it('exit → tears down, returns to user, clears recovery', async () => {
    const { result } = renderHook(() => useGuidedDemoGate());
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });
    expect(result.current.demoActive).toBe(true);
    await act(async () => {
      await result.current.exitDemo();
    });
    expect(result.current.demoActive).toBe(false);
    expect(currentDataScope()).toBe('user');
    expect(await getActiveDemo()).toBeNull();
  });

  it('disabled gate stays in checking (boot not ready)', async () => {
    const { result } = renderHook(() => useGuidedDemoGate(false));
    // No probe runs; phase stays at its initial value.
    expect(result.current.phase).toBe('checking');
  });

  it('startDemo arms the runner at the first step', async () => {
    const { make } = fakeSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });
    expect(result.current.stepCount).toBe(DEMO_STEPS.length + 7);
    expect(result.current.step).toBe(1);
    expect(result.current.currentAction?.id).toBe(DEMO_STEPS[0]?.id);
    expect(result.current.demoComplete).toBe(false);
  });

  it('advanceDemo runs the next step through the seams and moves the cursor', async () => {
    const { make, rec } = fakeSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });
    await act(async () => {
      await result.current.advanceDemo();
    });
    // Step 1 sends two remembers (Emma + Alonso) in the one step.
    expect(rec.sends).toBe(2);
    expect(result.current.step).toBe(2);
    expect(result.current.currentAction?.id).toBe(DEMO_STEPS[1]?.id);
  });

  it('runs to completion → approvals created, salon finale posted, complete flag set', async () => {
    const { make, rec } = fakeSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });
    for (let i = 0; i < DEMO_STEPS.length + 7; i += 1) {
      await act(async () => {
        await result.current.advanceDemo();
      });
    }
    // Content sends across chat steps (people + private each send two) PLUS the
    // salon-setup "remember hours" send.
    expect(rec.sends).toBe(TOTAL_SENDS + 1);
    expect(rec.recommendations).toBe(RECOMMEND_STEP_COUNT);
    expect(rec.servicePreviewCards).toBe(1); // salon: read-only services preview
    expect(rec.publishConfirms).toBe(1); // salon: publish popup confirmed once
    expect(rec.serviceCards).toBe(2); // salon: published card + booking-confirmed card
    expect(rec.approvals).toHaveLength(2); // agent Health-read + salon booking
    expect(rec.d2dMessages).toBe(1); // Dina-to-Dina Talk step
    expect(rec.reviewCards).toBe(1); // PeerLens review card
    expect(rec.cards).toBe(1); // salon finale: the customer query (postDemoCard)
    expect(result.current.demoComplete).toBe(true);
    expect(result.current.currentAction).toBeNull();
  });

  /** Seams whose `send` blocks until `release()` and records the scope it ran
   *  in — used to assert serialization + the exit/in-flight ordering. */
  function blockingSeams(): {
    make: () => GuidedDemoSeams;
    release: () => void;
    state: { sends: number; scopeAtSend: string };
  } {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const state = { sends: 0, scopeAtSend: '' };
    const seams: GuidedDemoSeams = {
      async send() {
        state.sends += 1;
        await blocker;
        // Captured AFTER the await: proves the step finished BEFORE the scope
        // was reset (if exit didn't await us, this would read 'user').
        state.scopeAtSend = currentDataScope();
      },
      async postRecommendation() {},
      async postServiceCard() {},
      requestApproval(req) {
        return req.id;
      },
      denyApproval() {},
      postDemoCard() {},
      postUserMessage() {},
      navigate() {},
      async postD2DMessage() {},
      postReviewCard() {},
      seedPerson() {
        /* not used here */
      },
      seedReminders() {
        /* not used here */
      },
      async delay() {},
    };
    return { make: () => seams, release, state };
  }

  it('advanceDemo serializes — a double-tap runs only ONE step', async () => {
    const { make, release, state } = blockingSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });

    let first: Promise<void>;
    let second: Promise<void>;
    await act(async () => {
      first = result.current.advanceDemo();
      second = result.current.advanceDemo(); // ignored — a step is in flight
      await Promise.resolve();
    });
    expect(result.current.actionInFlight).toBe(true);

    await act(async () => {
      release();
      await first;
      await second;
    });
    // Only ONE step ran (its two sends — Emma + Alonso) and the cursor moved by
    // exactly one; the double-tapped second advance was ignored.
    expect(state.sends).toBe(2);
    expect(result.current.step).toBe(2);
    expect(result.current.actionInFlight).toBe(false);
  });

  it('exitDemo WAITS for an in-flight step to finish in the demo scope before reset', async () => {
    const { make, release, state } = blockingSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });

    let advancing: Promise<void>;
    await act(async () => {
      advancing = result.current.advanceDemo(); // blocks inside send
      await Promise.resolve();
    });

    let exiting: Promise<void>;
    await act(async () => {
      exiting = result.current.exitDemo(); // flips UI, then awaits the step
      await Promise.resolve();
    });

    await act(async () => {
      release();
      await advancing;
      await exiting;
    });

    // The step finished while still in the demo scope (exit awaited it), and
    // only afterwards was the scope reset to user.
    expect(state.scopeAtSend).toBe('guided_demo:run1');
    expect(currentDataScope()).toBe('user');
    expect(result.current.demoActive).toBe(false);
  });

  it('exitDemo stays in a non-interactive tearing_down phase until the scope is reset', async () => {
    const { make, release } = blockingSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });

    await act(async () => {
      void result.current.advanceDemo(); // blocks inside send
      await Promise.resolve();
    });

    let exiting: Promise<void>;
    await act(async () => {
      exiting = result.current.exitDemo();
      await Promise.resolve();
    });
    // Scope is still the demo scope here, so the gate must show the blocking
    // teardown surface — NOT 'running' (which exposes the live app).
    expect(result.current.phase).toBe('tearing_down');
    expect(result.current.demoActive).toBe(false);

    await act(async () => {
      release();
      await exiting;
    });
    // Only once teardown completes (scope back to user) does the live app show.
    expect(result.current.phase).toBe('running');
    expect(currentDataScope()).toBe('user');
  });

  it('exitDemo tears the runner down, denying a pending approval', async () => {
    const { make, rec } = fakeSeams();
    const { result } = renderHook(() => useGuidedDemoGate(true, { makeSeams: make }));
    await waitFor(() => expect(result.current.phase).toBe('entry'));
    await act(async () => {
      await result.current.startDemo();
    });
    // Advance through the content steps, the D2D step, then the approval step.
    for (let i = 0; i < DEMO_STEPS.length + 2; i += 1) {
      await act(async () => {
        await result.current.advanceDemo();
      });
    }
    expect(rec.approvals).toHaveLength(1);
    await act(async () => {
      await result.current.exitDemo();
    });
    expect(rec.denied).toEqual(rec.approvals);
    expect(currentDataScope()).toBe('user');
  });
});
