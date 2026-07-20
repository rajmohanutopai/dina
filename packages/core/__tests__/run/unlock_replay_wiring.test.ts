/**
 * ISVC-10/R5-01 — the two seams that make the run plane see the PRODUCT's real
 * persona state:
 *
 *   1. `registerPersonaDEK` / `releasePersonaDEK` — the DB providers derive the
 *      SQLCipher key themselves; registering it makes `hasDEK` (the plane's
 *      persona-open predicate) and `wrapWithPersonaDEK` (its payload cipher)
 *      reflect the open vault. Without this every persona reads LOCKED to the
 *      run plane in production.
 *   2. `openPersonaVault` fires the held-replay hook — the shared persona-open
 *      choke point for both boots, so a `held_by_lock` response is admitted the
 *      moment its persona reopens.
 */

import {
  hasDEK,
  registerPersonaDEK,
  releasePersonaDEK,
  unwrapWithPersonaDEK,
  wrapWithPersonaDEK,
} from '../../src/persona/orchestrator';
import { setHeldReplayHook } from '../../src/run/replay_registry';
import { openPersonaVault } from '../../src/storage/bootstrap';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';
import type { DBProvider } from '../../src/storage/db_provider';

const enc = new TextEncoder();
const dec = new TextDecoder();

afterEach(() => {
  releasePersonaDEK('t-general');
  setHeldReplayHook(null);
});

describe('provider-derived DEK registration (ISVC-10)', () => {
  it('registerPersonaDEK opens the persona for the run plane: hasDEK + wrap/unwrap round-trip', () => {
    expect(hasDEK('t-general')).toBe(false);
    expect(wrapWithPersonaDEK('t-general', enc.encode('x'))).toBeNull();

    registerPersonaDEK('t-general', new Uint8Array(32).fill(7));
    expect(hasDEK('t-general')).toBe(true);
    const wrapped = wrapWithPersonaDEK('t-general', enc.encode('run payload key'));
    expect(wrapped).not.toBeNull();
    expect(dec.decode(unwrapWithPersonaDEK('t-general', wrapped as Uint8Array) as Uint8Array)).toBe(
      'run payload key',
    );
  });

  it('releasePersonaDEK closes it again (wrap returns null — payloads seal)', () => {
    registerPersonaDEK('t-general', new Uint8Array(32).fill(7));
    releasePersonaDEK('t-general');
    expect(hasDEK('t-general')).toBe(false);
    expect(wrapWithPersonaDEK('t-general', enc.encode('x'))).toBeNull();
  });

  it('re-registering replaces (and the old buffer is zeroed — ownership transfer)', () => {
    const first = new Uint8Array(32).fill(1);
    registerPersonaDEK('t-general', first);
    registerPersonaDEK('t-general', new Uint8Array(32).fill(2));
    // The registry took ownership of `first` and zeroed it on replace.
    expect(first.every((b) => b === 0)).toBe(true);
    expect(hasDEK('t-general')).toBe(true);
  });
});

describe('openPersonaVault fires the held-replay hook (R5-01/§7)', () => {
  it('fires AFTER the provider opened + migrations applied; a hook error never fails the open', async () => {
    const calls: string[] = [];
    setHeldReplayHook((persona) => {
      calls.push(persona);
      throw new Error('replay blew up'); // must never propagate into the open
    });

    // Minimal in-memory adapter — just enough for applyMigrations' bookkeeping.
    const applied: string[] = [];
    const stubAdapter = {
      execute: (sql: string) => {
        applied.push(sql.slice(0, 24));
        return { rowsAffected: 0, insertId: 0 };
      },
      run: () => ({ rowsAffected: 0, insertId: 0 }),
      query: () => [],
      transaction: (fn: () => void) => fn(),
      close: () => undefined,
    } as unknown as DatabaseAdapter;
    const provider = {
      openPersonaDB: async () => stubAdapter,
    } as unknown as DBProvider;

    const db = await openPersonaVault(provider, 'health');
    expect(db).toBe(stubAdapter);
    expect(calls).toEqual(['health']);
  });
});
