import { ReasoningBackendSupervisor, type ReasoningWorkerResult } from '../../src';

describe('ReasoningBackendSupervisor', () => {
  it('drains a bounded batch, stops on idle, and coalesces overlapping ticks', async () => {
    const scripted: ReasoningWorkerResult[] = [
      {
        state: 'completed',
        taskId: 'one',
        completion: {
          accepted: true,
          state: 'completed',
          code: 'completed',
          committed: true,
        },
      },
      { state: 'idle' },
    ];
    const releases: (() => void)[] = [];
    const blocked = new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    let first = true;
    const worker = {
      runOne: jest.fn(async () => {
        if (first) {
          first = false;
          await blocked;
        }
        return scripted.shift() ?? { state: 'idle' as const };
      }),
    };
    const seen: ReasoningWorkerResult[] = [];
    const supervisor = new ReasoningBackendSupervisor({
      worker: worker as never,
      maxJobsPerTick: 5,
      onResult: (result) => seen.push(result),
    });

    const left = supervisor.tick();
    const right = supervisor.tick();
    releases[0]?.();
    expect(await left).toEqual(await right);
    expect(worker.runOne).toHaveBeenCalledTimes(2);
    expect(seen.map((result) => result.state)).toEqual(['completed', 'idle']);
  });

  it('starts immediately, keeps one timer, and waits for the active pass on stop', async () => {
    const callbacks: (() => void)[] = [];
    const cleared: unknown[] = [];
    const worker = { runOne: jest.fn(async () => ({ state: 'idle' as const })) };
    const supervisor = new ReasoningBackendSupervisor({
      worker: worker as never,
      setInterval: (callback) => {
        callbacks.push(callback);
        return 'timer';
      },
      clearInterval: (handle) => cleared.push(handle),
    });

    supervisor.start();
    supervisor.start();
    await supervisor.tick();
    callbacks[0]?.();
    await supervisor.stop();

    expect(callbacks).toHaveLength(1);
    expect(cleared).toEqual(['timer']);
    expect(worker.runOne).toHaveBeenCalled();
  });
});
