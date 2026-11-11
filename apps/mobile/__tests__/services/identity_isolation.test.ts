/**
 * docs/STATE_MACHINES.md PH-01, PH-02, PH-11, PH-13. Real recovery, sign-out
 * and erase over real SQLite: one identity's open databases, keys, memory and
 * keychain rows must not reach the next one in the same JS process.
 *
 * The test SQLite has no cipher, so B can read the file A wrote. These tests
 * pin what the cipher needs: A's handles close, and B opens its own.
 */

import { mkdirSync, rmSync } from 'node:fs';

import * as Notifications from 'expo-notifications';
import * as Keychain from 'react-native-keychain';

import {
  createPersona,
  generateMnemonic,
  getApprovalManager,
  getUcpIdentity,
  hasDEK,
  listPersonas,
} from '@dina/core';
import { createReminder, listByPersona } from '@dina/core/reminders';

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import { peekActiveProvider, saveActiveProvider } from '../../src/ai/active_provider';
import {
  isUnlocked,
  resetUnlockState,
  sealVault,
  shouldForcePromptOnUnlock,
} from '../../src/hooks/useUnlock';
import { recoverIdentity } from '../../src/onboarding/provision';
import { eraseEverythingLocal, signOutLocal } from '../../src/services/local_data_wipe';
import {
  getUserPreferencesSnapshot,
  hydrateUserPreferences,
  mutateUserPreferences,
} from '../../src/services/user_preferences';
import {
  getIdentityAdapter,
  isPersistenceOpenFor,
  isPersistenceReady,
  shutdownAllPersistence,
} from '../../src/storage/init';

const DIR = '/tmp/dina-test/';
const realFetch = globalThis.fetch;

function words(m: string): string[] {
  return m.split(' ');
}

function recover(phrase: string, did: string) {
  return recoverIdentity({
    mnemonic: words(phrase),
    passphrase: 'PassA12345!',
    expectedDid: did,
    handle: 'a.test',
  });
}

async function present(services: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const service of services) {
    if ((await Keychain.getGenericPassword({ service })) !== false) left.push(service);
  }
  return left;
}

async function seedRows(services: string[]): Promise<void> {
  for (const service of services) {
    await Keychain.setGenericPassword('u', 'v', { service });
  }
}

beforeEach(async () => {
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  await shutdownAllPersistence().catch(() => undefined);
  resetUnlockState();
  resetKeychainMock();
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await shutdownAllPersistence().catch(() => undefined);
});

describe('PH-01: sign out closes the old identity', () => {
  it('leaves no open database, no DEK and no open persona', async () => {
    await recover(generateMnemonic(), 'did:plc:aaaa');
    expect(isUnlocked()).toBe(true);
    await signOutLocal();
    expect(isUnlocked()).toBe(false);
    expect(isPersistenceReady()).toBe(false);
    expect(hasDEK('general')).toBe(false);
    expect(listPersonas().filter((p) => p.isOpen)).toEqual([]);
    expect(getUcpIdentity()).toBeNull();
  });

  it('gives the next identity new database handles', async () => {
    await recover(generateMnemonic(), 'did:plc:aaaa');
    const adapterA = getIdentityAdapter();
    await signOutLocal();
    await recover(generateMnemonic(), 'did:plc:bbbb');
    expect(getIdentityAdapter()).not.toBe(adapterA);
  });

  it('second lock: unlock refuses a database opened for another seed', async () => {
    const A = generateMnemonic();
    const B = generateMnemonic();
    await recover(A, 'did:plc:aaaa');
    const adapterA = getIdentityAdapter();
    // The first lock is bypassed: state resets, the databases stay open.
    resetUnlockState();
    expect(isPersistenceReady()).toBe(true);
    await recover(B, 'did:plc:bbbb');
    expect(getIdentityAdapter()).not.toBe(adapterA);
    const { mnemonicToEntropy } = jest.requireActual('@dina/core');
    expect(isPersistenceOpenFor(mnemonicToEntropy(B))).toBe(true);
    expect(isPersistenceOpenFor(mnemonicToEntropy(A))).toBe(false);
  });
});

describe('PH-02: old identity state leaves memory', () => {
  async function seedA(): Promise<void> {
    await recover(generateMnemonic(), 'did:plc:aaaa');
    createReminder({
      message: 'A private: call oncologist',
      due_at: Date.now() + 3_600_000,
      persona: 'health',
      kind: 'manual',
      source_item_id: 'x',
      source: 'test',
    } as never);
    createPersona('a_secret_vault', 'standard', undefined, { persist: true });
    getApprovalManager().requestApproval({
      id: 'appr-A',
      action: 'vault_read',
      requester_did: 'did:plc:aaaa',
      persona: 'health',
      reason: 'A private reason',
      preview: 'A private preview',
      created_at: 1,
    } as never);
    await hydrateUserPreferences({ infer: async () => ({}) } as never).catch(() => undefined);
    await mutateUserPreferences((p) => ({ ...p, region: 'A-region' }));
    await saveActiveProvider('claude');
  }

  function expectClean(): void {
    expect(listByPersona('health')).toEqual([]);
    expect(listPersonas().map((p) => p.name)).not.toContain('a_secret_vault');
    expect(getApprovalManager().listPending()).toEqual([]);
  }

  it('after Erase everything', async () => {
    await seedA();
    await eraseEverythingLocal();
    expectClean();
    expect(getUserPreferencesSnapshot()?.region ?? null).toBeNull();
    expect(peekActiveProvider()).toBeNull();
  });

  it('after Sign out', async () => {
    await seedA();
    await signOutLocal();
    expectClean();
    expect(getUserPreferencesSnapshot()?.region ?? null).toBeNull();
  });

  it('when persistence opens for another seed with no sign-out at all', async () => {
    await seedA();
    resetUnlockState();
    await shutdownAllPersistence();
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    await recover(generateMnemonic(), 'did:plc:bbbb');
    expectClean();
  });

  it('a seal of the same identity keeps them', async () => {
    await seedA();
    await sealVault({ forcePrompt: false });
    expect(listByPersona('health').map((r) => r.message)).toEqual(['A private: call oncologist']);
  });
});

describe('PH-11: what Sign out and Erase clear', () => {
  it('Sign out clears PDS credentials and cancels every banner, and keeps phone-level keys', async () => {
    await recover(generateMnemonic(), 'did:plc:aaaa');
    await seedRows(['dina.llm.openai', 'dina.credits.key']);
    const cancel = jest.spyOn(Notifications, 'cancelAllScheduledNotificationsAsync');
    await signOutLocal();
    expect(
      await present(['dina.infra.pds_password', 'dina.infra.pds_handle', 'dina.infra.pds_email']),
    ).toEqual([]);
    expect(cancel).toHaveBeenCalled();
    expect(await present(['dina.llm.openai', 'dina.credits.key'])).toEqual([
      'dina.llm.openai',
      'dina.credits.key',
    ]);
    cancel.mockRestore();
  });

  const SCOPED = [
    'dina.node_role',
    'dina.linked_atproto_identity',
    'dina.user_preferences',
    'dina.verification_banner_dismissed',
    'dina.backup_prompt.snooze_until',
  ];

  it('another identity does not inherit the rows the last one left', async () => {
    await recover(generateMnemonic(), 'did:plc:aaaa');
    await seedRows(SCOPED);
    await signOutLocal();
    await recover(generateMnemonic(), 'did:plc:bbbb');
    expect(await present(SCOPED)).toEqual([]);
  });

  it('the same identity gets them back', async () => {
    const A = generateMnemonic();
    await recover(A, 'did:plc:aaaa');
    await seedRows(SCOPED);
    await signOutLocal();
    await recover(A, 'did:plc:aaaa');
    expect(await present(SCOPED)).toEqual(SCOPED);
  });

  it('Erase clears every row the app owns, model overrides and staff identity too', async () => {
    const rows = [
      'dina.linked_atproto_identity',
      'dina.infra.services_appview_url',
      'dina.llm.model_override.openai:primary',
      'dina.llm.model_override.openrouter:heavy',
      'dina.trust.first_run_dismissed_at',
      'com.dina.staff-identity',
      'dina.vault.wrapped_seed',
    ];
    await seedRows(rows);
    await eraseEverythingLocal();
    expect(await present(rows)).toEqual([]);
  });
});

describe('PH-13: a background auto-lock during Sign out keeps the prompt', () => {
  it('the force-prompt flag stays armed, whichever seal lands last', async () => {
    await recover(generateMnemonic(), 'did:plc:aaaa');
    const signOut = sealVault();
    const autoLock = sealVault({ forcePrompt: false });
    await Promise.all([signOut, autoLock]);
    expect(isUnlocked()).toBe(false);
    expect(shouldForcePromptOnUnlock()).toBe(true);
  });
});
