/**
 * The memo rule behind the server verifier's lazy ESM loads (§5.C1): a module
 * that loads is loaded once per process; a load that REJECTS is forgotten so
 * the next verify retries it. Without the second half, one failed `import()`
 * would pin `verifier_unavailable` (a transient, "try again" refusal) on every
 * later install for the life of the process — a retry signal that could never
 * come true. Driven through an injected loader, so no real `import()` runs and
 * this stays in the CommonJS pass.
 */

import { lazyModule } from '../src/repo_proof_verifier';

describe('lazyModule', () => {
  it('loads once and hands every caller the same settled module', async () => {
    const load = jest.fn(async (specifier: string) => ({ name: specifier }));
    const get = lazyModule<{ name: string }>('lib', load);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(await get()).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a rejected load so the next call retries — and memoizes the success', async () => {
    const load = jest
      .fn<Promise<{ ok: true }>, [string]>()
      .mockRejectedValueOnce(new Error('ENOENT: module missing'))
      .mockResolvedValue({ ok: true });
    const get = lazyModule<{ ok: true }>('lib', load);

    await expect(get()).rejects.toThrow('ENOENT');
    // Let the rejection handler that clears the memo run.
    await Promise.resolve();
    await expect(get()).resolves.toEqual({ ok: true });
    await expect(get()).resolves.toEqual({ ok: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a rejection does not clear a NEWER attempt already in flight', async () => {
    let rejectFirst: (err: Error) => void = () => undefined;
    const first = new Promise<{ n: number }>((_, reject) => {
      rejectFirst = reject;
    });
    const load = jest
      .fn<Promise<{ n: number }>, [string]>()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ n: 2 });
    const get = lazyModule<{ n: number }>('lib', load);

    const pending = get();
    expect(get()).toBe(pending);
    rejectFirst(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
    await Promise.resolve();
    await expect(get()).resolves.toEqual({ n: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
