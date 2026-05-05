/**
 * Tests for the deferred-verification status flag. Drives the chat-
 * home banner and the Settings → "Confirm recovery phrase" row.
 *
 * Semantics under test:
 *   - Absent keychain entry == 'verified' (legacy installs not pestered).
 *   - 'pending' written iff user explicitly tapped "I'll do this later".
 *   - markVerified deletes the entry — that's the canonical "clean".
 */

import * as Keychain from 'react-native-keychain';
import {
  loadVerificationStatus,
  markVerificationPending,
  markVerified,
} from '../../src/services/verification_status';
import { resetKeychainMock } from '../../__mocks__/react-native-keychain';

const SERVICE = 'dina.verification_status';

beforeEach(() => {
  resetKeychainMock();
});

describe('loadVerificationStatus', () => {
  it("returns 'verified' when nothing has been persisted (legacy install)", async () => {
    expect(await loadVerificationStatus()).toBe('verified');
  });

  it("returns 'pending' when the user explicitly skipped onboarding's quick check", async () => {
    await markVerificationPending();
    expect(await loadVerificationStatus()).toBe('pending');
  });

  it("returns 'verified' after markVerified clears the pending flag", async () => {
    await markVerificationPending();
    expect(await loadVerificationStatus()).toBe('pending');
    await markVerified();
    expect(await loadVerificationStatus()).toBe('verified');
  });

  it("returns 'verified' on a keychain read error — fail open, no spurious banner", async () => {
    // Force the next getGenericPassword to throw. We're testing the
    // catch arm in loadVerificationStatus.
    const origGet = Keychain.getGenericPassword;
    (Keychain as unknown as { getGenericPassword: () => Promise<never> }).getGenericPassword =
      () => Promise.reject(new Error('keychain unavailable'));
    try {
      expect(await loadVerificationStatus()).toBe('verified');
    } finally {
      (
        Keychain as unknown as { getGenericPassword: typeof origGet }
      ).getGenericPassword = origGet;
    }
  });
});

describe('markVerificationPending', () => {
  it("writes 'pending' under the canonical service id", async () => {
    await markVerificationPending();
    const row = await Keychain.getGenericPassword({ service: SERVICE });
    expect(row).toBeTruthy();
    if (row) expect(row.password).toBe('pending');
  });
});

describe('markVerified', () => {
  it('is idempotent — safe to call when no flag was ever set', async () => {
    await expect(markVerified()).resolves.toBeUndefined();
    expect(await loadVerificationStatus()).toBe('verified');
  });
});
