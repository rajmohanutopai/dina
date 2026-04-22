/**
 * T2.8 — Request timeout: wrap async handlers with configurable timeout.
 *
 * Source: ARCHITECTURE.md Task 2.8
 */

import { withTimeout, withTimeoutThrow, TimeoutError } from '../../src/auth/timeout';

describe('Request Timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('withTimeout', () => {
    it('returns result when handler completes in time', async () => {
      const result = await withTimeout(async () => 'done', 5000);
      expect(result.completed).toBe(true);
      expect(result.result).toBe('done');
      expect(result.timedOut).toBe(false);
    });

    it('returns timeout when handler exceeds limit', async () => {
      const promise = withTimeout(() => new Promise((resolve) => setTimeout(resolve, 60000)), 100);
      jest.advanceTimersByTime(150);
      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.completed).toBe(false);
      expect(result.result).toBeUndefined();
    });

    it('tracks elapsed time', async () => {
      const result = await withTimeout(async () => 42, 5000);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('defaults to 30 seconds', async () => {
      const promise = withTimeout(() => new Promise((resolve) => setTimeout(resolve, 60000)));
      jest.advanceTimersByTime(30001);
      const result = await promise;
      expect(result.timedOut).toBe(true);
    });

    it('handler error → completed false, not timed out', async () => {
      const result = await withTimeout(async () => {
        throw new Error('boom');
      }, 5000);
      expect(result.completed).toBe(false);
      expect(result.timedOut).toBe(false);
    });

    it('only one resolution wins (no double-settle)', async () => {
      let resolveHandler: (() => void) | null = null;
      const promise = withTimeout(
        () =>
          new Promise<string>((resolve) => {
            resolveHandler = () => resolve('late');
          }),
        100,
      );

      jest.advanceTimersByTime(150); // timeout fires
      const result = await promise;
      expect(result.timedOut).toBe(true);

      // Late resolution should be ignored
      resolveHandler!();
      // No double-settle error
    });
  });

  describe('withTimeoutThrow', () => {
    it('returns result on success', async () => {
      const result = await withTimeoutThrow(async () => 'hello', 5000);
      expect(result).toBe('hello');
    });

    it('throws TimeoutError on timeout', async () => {
      const promise = withTimeoutThrow(
        () => new Promise((resolve) => setTimeout(resolve, 60000)),
        100,
      );
      jest.advanceTimersByTime(150);
      await expect(promise).rejects.toThrow(TimeoutError);
    });

    it('TimeoutError has correct fields', async () => {
      const promise = withTimeoutThrow(
        () => new Promise((resolve) => setTimeout(resolve, 60000)),
        200,
      );
      jest.advanceTimersByTime(250);
      try {
        await promise;
        fail('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TimeoutError);
        expect((err as TimeoutError).timeoutMs).toBe(200);
        expect((err as TimeoutError).name).toBe('TimeoutError');
      }
    });

    it('throws "Handler failed" on handler error', async () => {
      await expect(
        withTimeoutThrow(async () => {
          throw new Error('crash');
        }, 5000),
      ).rejects.toThrow('Handler failed');
    });
  });
});
