/**
 * change_passphrase service — the DURABLE re-wrap path behind Settings →
 * Security → "Change passphrase".
 *
 * The legacy `doChangePassphrase` in useSecurity.ts only mutated an
 * in-memory variable (never persisted, never wired). These tests pin the
 * contract the UI actually depends on:
 *   - validate + cheap rejections happen BEFORE touching the keychain;
 *   - a wrong current passphrase writes NOTHING;
 *   - success persists the new wrapped seed (source of truth for unlock);
 *   - "Unlock automatically" users get their cached passphrase refreshed,
 *     manual users do not;
 *   - an auto-cache failure is non-fatal (the re-wrap already succeeded).
 *
 * The heavy Argon2id re-wrap (`@dina/core` changePassphrase) is stubbed;
 * `validatePassphrase` runs for real so the real rules are exercised.
 */

jest.mock('../../src/services/wrapped_seed_store', () => ({
  loadWrappedSeed: jest.fn(),
  saveWrappedSeed: jest.fn(async () => undefined),
}));

jest.mock('../../src/services/startup_preferences', () => ({
  loadStartupMode: jest.fn(),
  saveAutoPassphrase: jest.fn(async () => undefined),
}));

jest.mock('@dina/core', () => {
  const actual = jest.requireActual('@dina/core');
  return {
    ...actual,
    changePassphrase: jest.fn(),
  };
});

import { changePassphrase, type WrappedSeed } from '@dina/core';

import { changeVaultPassphrase } from '../../src/services/change_passphrase';
import { loadStartupMode, saveAutoPassphrase } from '../../src/services/startup_preferences';
import { loadWrappedSeed, saveWrappedSeed } from '../../src/services/wrapped_seed_store';

const changePassphraseMock = changePassphrase as jest.MockedFunction<typeof changePassphrase>;
const loadWrappedSeedMock = loadWrappedSeed as jest.MockedFunction<typeof loadWrappedSeed>;
const saveWrappedSeedMock = saveWrappedSeed as jest.MockedFunction<typeof saveWrappedSeed>;
const loadStartupModeMock = loadStartupMode as jest.MockedFunction<typeof loadStartupMode>;
const saveAutoPassphraseMock = saveAutoPassphrase as jest.MockedFunction<typeof saveAutoPassphrase>;

const OLD_WRAPPED: WrappedSeed = {
  salt: new Uint8Array(16).fill(1),
  wrapped: new Uint8Array(60).fill(2),
  params: { memory: 1, iterations: 1, parallelism: 1 },
};
const NEW_WRAPPED: WrappedSeed = {
  salt: new Uint8Array(16).fill(3),
  wrapped: new Uint8Array(60).fill(4),
  params: { memory: 1, iterations: 1, parallelism: 1 },
};

// Valid per `validatePassphrase`: ≥8 chars, upper + lower + digit.
const CURRENT = 'OldPass123';
const NEW = 'NewPass456';

beforeEach(() => {
  jest.clearAllMocks();
  loadWrappedSeedMock.mockResolvedValue(OLD_WRAPPED);
  changePassphraseMock.mockResolvedValue(NEW_WRAPPED);
  loadStartupModeMock.mockResolvedValue('manual');
});

describe('changeVaultPassphrase — cheap rejections (no keychain touch)', () => {
  it('rejects an empty current passphrase without loading the seed', async () => {
    const r = await changeVaultPassphrase('', NEW);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('current passphrase') });
    expect(loadWrappedSeedMock).not.toHaveBeenCalled();
    expect(saveWrappedSeedMock).not.toHaveBeenCalled();
  });

  it('rejects a new passphrase that fails the strength rules', async () => {
    const r = await changeVaultPassphrase(CURRENT, 'short');
    expect(r.ok).toBe(false);
    expect(loadWrappedSeedMock).not.toHaveBeenCalled();
    expect(changePassphraseMock).not.toHaveBeenCalled();
  });

  it('rejects when the new passphrase equals the current one', async () => {
    const r = await changeVaultPassphrase(CURRENT, CURRENT);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('different') });
    expect(loadWrappedSeedMock).not.toHaveBeenCalled();
  });
});

describe('changeVaultPassphrase — seed + auth failures', () => {
  it('errors when there is no persisted wrapped seed', async () => {
    loadWrappedSeedMock.mockResolvedValue(null);
    const r = await changeVaultPassphrase(CURRENT, NEW);
    expect(r.ok).toBe(false);
    expect(changePassphraseMock).not.toHaveBeenCalled();
    expect(saveWrappedSeedMock).not.toHaveBeenCalled();
  });

  it('a wrong current passphrase writes NOTHING', async () => {
    changePassphraseMock.mockRejectedValueOnce(new Error('aesgcm: decryption failed'));
    const r = await changeVaultPassphrase(CURRENT, NEW);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('incorrect') });
    expect(saveWrappedSeedMock).not.toHaveBeenCalled();
    expect(saveAutoPassphraseMock).not.toHaveBeenCalled();
  });
});

describe('changeVaultPassphrase — success persistence', () => {
  it('persists the re-wrapped seed as the new unlock source of truth', async () => {
    const r = await changeVaultPassphrase(CURRENT, NEW);
    expect(r).toEqual({ ok: true });
    expect(changePassphraseMock).toHaveBeenCalledWith(CURRENT, NEW, OLD_WRAPPED);
    expect(saveWrappedSeedMock).toHaveBeenCalledWith(NEW_WRAPPED);
  });

  it('refreshes the auto-unlock cache for "Unlock automatically" users', async () => {
    loadStartupModeMock.mockResolvedValue('auto');
    await changeVaultPassphrase(CURRENT, NEW);
    expect(saveAutoPassphraseMock).toHaveBeenCalledWith(NEW);
  });

  it('does NOT cache a passphrase for manual-unlock users', async () => {
    loadStartupModeMock.mockResolvedValue('manual');
    await changeVaultPassphrase(CURRENT, NEW);
    expect(saveAutoPassphraseMock).not.toHaveBeenCalled();
  });

  it('persists the seed BEFORE touching the auto cache (ordering)', async () => {
    loadStartupModeMock.mockResolvedValue('auto');
    const order: string[] = [];
    saveWrappedSeedMock.mockImplementationOnce(async () => {
      order.push('saveWrappedSeed');
    });
    saveAutoPassphraseMock.mockImplementationOnce(async () => {
      order.push('saveAutoPassphrase');
    });
    await changeVaultPassphrase(CURRENT, NEW);
    expect(order).toEqual(['saveWrappedSeed', 'saveAutoPassphrase']);
  });

  it('treats an auto-cache failure as non-fatal — the re-wrap already succeeded', async () => {
    loadStartupModeMock.mockResolvedValue('auto');
    saveAutoPassphraseMock.mockRejectedValueOnce(new Error('keychain offline'));
    const r = await changeVaultPassphrase(CURRENT, NEW);
    expect(r).toEqual({ ok: true });
    expect(saveWrappedSeedMock).toHaveBeenCalledWith(NEW_WRAPPED);
  });
});
