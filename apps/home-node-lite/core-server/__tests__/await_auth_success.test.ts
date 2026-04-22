/**
 * Task 4.43 — strict auth_success wait tests.
 */

import { AUTH_SUCCESS, AUTH_CHALLENGE } from '@dina/protocol';
import {
  awaitAuthSuccess,
  DEFAULT_AUTH_SUCCESS_TIMEOUT_MS,
  type MessageSource,
} from '../src/msgbox/await_auth_success';

/** In-memory message source — tests emit frames + inspect dispose. */
function makeSource(): {
  source: MessageSource;
  emit: (frame: unknown) => void;
  disposed: () => boolean;
} {
  let listener: ((f: unknown) => void) | null = null;
  let wasDisposed = false;
  return {
    source: {
      onMessage(cb) {
        listener = cb;
        return () => {
          wasDisposed = true;
          listener = null;
        };
      },
    },
    emit: (frame) => {
      if (listener) listener(frame);
    },
    disposed: () => wasDisposed,
  };
}

/** Mock timer — tests advance by firing the scheduled callback manually. */
function makeTimer() {
  let cb: (() => void) | null = null;
  let cleared = false;
  const setTimeoutFn = (fn: () => void, _ms: number): number => {
    cb = fn;
    return 1 as unknown as number;
  };
  const clearTimeoutFn = (_h: NodeJS.Timeout | number) => {
    cleared = true;
  };
  return { setTimeoutFn, clearTimeoutFn, fire: () => cb?.(), cleared: () => cleared };
}

describe('awaitAuthSuccess (task 4.43)', () => {
  describe('happy path', () => {
    it('resolves ok:true when auth_success arrives', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      s.emit({ type: AUTH_SUCCESS });
      const r = await p;
      expect(r).toEqual({ ok: true });
    });

    it('cleans up the timer on success', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      s.emit({ type: AUTH_SUCCESS });
      await p;
      expect(t.cleared()).toBe(true);
    });

    it('disposes the listener on success', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      s.emit({ type: AUTH_SUCCESS });
      await p;
      expect(s.disposed()).toBe(true);
    });
  });

  describe('timeout', () => {
    it('resolves ok:false, reason:timeout when no frame arrives', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      t.fire();
      const r = await p;
      expect(r).toEqual({ ok: false, reason: 'timeout' });
    });

    it('cleans up the listener on timeout', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      t.fire();
      await p;
      expect(s.disposed()).toBe(true);
    });
  });

  describe('strict rejection (any-other-frame = error, not ignored)', () => {
    it('rejects wrong_frame_type for an auth_challenge frame', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      const bogusChallenge = { type: AUTH_CHALLENGE, nonce: 'n', ts: 1 };
      s.emit(bogusChallenge);
      const r = await p;
      expect(r).toMatchObject({ ok: false, reason: 'wrong_frame_type' });
      if (!r.ok) {
        expect(r.frame).toEqual(bogusChallenge);
      }
    });

    it('rejects a completely unrelated frame', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      s.emit({ type: 'some_other_thing' });
      const r = await p;
      expect(r).toMatchObject({ ok: false, reason: 'wrong_frame_type' });
    });

    it('rejects null / non-object payload as wrong_frame_type', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      s.emit(null);
      const r = await p;
      expect(r).toMatchObject({ ok: false, reason: 'wrong_frame_type' });
    });
  });

  describe('only resolves once', () => {
    it('later frames after auth_success have no effect', async () => {
      const s = makeSource();
      const t = makeTimer();
      const p = awaitAuthSuccess({
        source: s.source,
        setTimeoutFn: t.setTimeoutFn,
        clearTimeoutFn: t.clearTimeoutFn,
      });
      s.emit({ type: AUTH_SUCCESS });
      // Late noise after settlement.
      s.emit({ type: 'garbage' });
      t.fire();
      await expect(p).resolves.toEqual({ ok: true });
    });
  });

  describe('defaults', () => {
    it('DEFAULT_AUTH_SUCCESS_TIMEOUT_MS = 5000', () => {
      expect(DEFAULT_AUTH_SUCCESS_TIMEOUT_MS).toBe(5_000);
    });
  });

  describe('input validation', () => {
    it('rejects timeoutMs ≤ 0', () => {
      const s = makeSource();
      expect(() => awaitAuthSuccess({ source: s.source, timeoutMs: 0 })).toThrow(
        /timeoutMs must be > 0/,
      );
    });

    it('rejects NaN / Infinity timeoutMs', () => {
      const s = makeSource();
      expect(() => awaitAuthSuccess({ source: s.source, timeoutMs: NaN })).toThrow();
      expect(() =>
        awaitAuthSuccess({ source: s.source, timeoutMs: Infinity }),
      ).toThrow();
    });
  });
});
