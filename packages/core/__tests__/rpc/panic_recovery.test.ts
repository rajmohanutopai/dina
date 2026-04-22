/**
 * CORE-P0-007 — Panic recovery tests.
 */

import { withPanicRecovery } from '../../src/rpc/panic_recovery';

describe('withPanicRecovery', () => {
  function decode(body: Uint8Array): Record<string, unknown> {
    return JSON.parse(new TextDecoder().decode(body));
  }

  it('returns the inner response unchanged on happy path', async () => {
    const res = await withPanicRecovery(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: new TextEncoder().encode('{"ok":true}'),
    }));
    expect(res.status).toBe(200);
    expect(decode(res.body)).toEqual({ ok: true });
  });

  it('returns the inner response unchanged on async happy path', async () => {
    const res = await withPanicRecovery(async () => ({
      status: 200,
      headers: {},
      body: new Uint8Array(0),
    }));
    expect(res.status).toBe(200);
  });

  it('converts synchronous throw into a 500 inner response', async () => {
    const seen: Array<{ msg: string; reason: string }> = [];
    const res = await withPanicRecovery(
      () => {
        throw new Error('sync boom');
      },
      { onPanic: (err, reason) => seen.push({ msg: err.message, reason }) },
    );
    expect(res.status).toBe(500);
    expect(decode(res.body)).toEqual({
      error: 'internal_error',
      detail: 'sync boom',
    });
    expect(seen).toEqual([{ msg: 'sync boom', reason: 'sync-throw' }]);
  });

  it('converts async rejection into a 500 inner response', async () => {
    const seen: Array<{ msg: string; reason: string }> = [];
    const res = await withPanicRecovery(
      async () => {
        throw new Error('async boom');
      },
      { onPanic: (err, reason) => seen.push({ msg: err.message, reason }) },
    );
    expect(res.status).toBe(500);
    expect(decode(res.body)).toEqual({
      error: 'internal_error',
      detail: 'async boom',
    });
    expect(seen).toEqual([{ msg: 'async boom', reason: 'async-rejection' }]);
  });

  it('coerces non-Error throws into Error', async () => {
    const res = await withPanicRecovery(() => {
      throw 'string rejection'; // eslint-disable-line no-throw-literal
    });
    expect(res.status).toBe(500);
    expect(decode(res.body).detail).toBe('string rejection');
  });

  it('truncates excessively long error messages (no wire leak)', async () => {
    const longMsg = 'x'.repeat(2000);
    const res = await withPanicRecovery(() => {
      throw new Error(longMsg);
    });
    expect((decode(res.body).detail as string).length).toBe(512);
  });

  it('swallows errors thrown by the onPanic logger', async () => {
    const res = await withPanicRecovery(
      () => {
        throw new Error('original');
      },
      {
        onPanic: () => {
          throw new Error('logger itself broke');
        },
      },
    );
    // Despite the logger blowing up, the outer call still returns the canonical 500.
    expect(res.status).toBe(500);
    expect(decode(res.body).detail).toBe('original');
  });
});
