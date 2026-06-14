/**
 * backup_prompt — the deferred, value-proportionate recovery-phrase prompt
 * gating. Drives the real keychain mock for status + snooze; injects the item
 * count + clock so the predicate is tested without a persona registry.
 */

import { resetKeychainMock } from 'react-native-keychain';

import {
  BACKUP_PROMPT_ITEM_THRESHOLD,
  BACKUP_SNOOZE_MS,
  loadSnoozeUntil,
  shouldPromptBackup,
  snoozeBackupPrompt,
} from '../../src/services/backup_prompt';
import { markVerificationPending, markVerified } from '../../src/services/verification_status';

const T = BACKUP_PROMPT_ITEM_THRESHOLD;

beforeEach(() => {
  resetKeychainMock();
});

describe('shouldPromptBackup', () => {
  it('is false when backup is already verified (default state), regardless of count', async () => {
    // Fresh keychain → loadVerificationStatus() === 'verified'.
    expect(await shouldPromptBackup({ itemCount: () => T + 50 })).toBe(false);
  });

  it('is false while pending but below the item threshold (new user testing)', async () => {
    await markVerificationPending();
    expect(await shouldPromptBackup({ itemCount: () => T - 1 })).toBe(false);
  });

  it('is true once pending AND at/above the threshold AND not snoozed', async () => {
    await markVerificationPending();
    expect(await shouldPromptBackup({ itemCount: () => T, now: () => 1000 })).toBe(true);
  });

  it('is false while an active snooze window has not elapsed', async () => {
    await markVerificationPending();
    await snoozeBackupPrompt(() => 1000);
    // now is still inside the snooze window
    expect(
      await shouldPromptBackup({ itemCount: () => T, now: () => 1000 + BACKUP_SNOOZE_MS - 1 }),
    ).toBe(false);
  });

  it('re-pops once the snooze window has elapsed', async () => {
    await markVerificationPending();
    await snoozeBackupPrompt(() => 1000);
    expect(
      await shouldPromptBackup({ itemCount: () => T, now: () => 1000 + BACKUP_SNOOZE_MS + 1 }),
    ).toBe(true);
  });

  it('never prompts again after the user backs up (verified beats count + snooze)', async () => {
    await markVerificationPending();
    await markVerified();
    expect(await shouldPromptBackup({ itemCount: () => T + 100, now: () => 9e12 })).toBe(false);
  });
});

describe('snoozeBackupPrompt', () => {
  it('persists snoozeUntil = now + BACKUP_SNOOZE_MS', async () => {
    await snoozeBackupPrompt(() => 5000);
    expect(await loadSnoozeUntil()).toBe(5000 + BACKUP_SNOOZE_MS);
  });

  it('loadSnoozeUntil returns 0 when never snoozed', async () => {
    expect(await loadSnoozeUntil()).toBe(0);
  });
});
