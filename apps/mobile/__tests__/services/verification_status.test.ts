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

import { resetKeychainMock } from '../../__mocks__/react-native-keychain';
import {
  dismissVerificationBanner,
  isVerificationBannerDismissed,
  loadVerificationStatus,
  markVerificationPending,
  markVerified,
} from '../../src/services/verification_status';

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

describe('verification banner dismissal', () => {
  it('defaults to not dismissed', async () => {
    expect(await isVerificationBannerDismissed()).toBe(false);
  });

  it('persists the dismissal and reads it back', async () => {
    await dismissVerificationBanner();
    expect(await isVerificationBannerDismissed()).toBe(true);
  });

  it('is independent of the pending status (dismiss != verify)', async () => {
    await markVerificationPending();
    await dismissVerificationBanner();
    // The user still hasn't verified — Settings keeps the row — but the chat
    // banner stays hidden.
    expect(await loadVerificationStatus()).toBe('pending');
    expect(await isVerificationBannerDismissed()).toBe(true);
  });

  it('markVerificationPending clears a stale prior dismissal (new phrase re-surfaces the banner)', async () => {
    await dismissVerificationBanner();
    expect(await isVerificationBannerDismissed()).toBe(true);
    // A fresh onboarding / recovery marks pending for a NEW phrase. The previous
    // identity/session's dismissal must not suppress this phrase's reminder.
    await markVerificationPending();
    expect(await loadVerificationStatus()).toBe('pending');
    expect(await isVerificationBannerDismissed()).toBe(false);
  });

  it('fails open to not-dismissed on a keychain read error', async () => {
    const origGet = Keychain.getGenericPassword;
    (Keychain as unknown as { getGenericPassword: () => Promise<never> }).getGenericPassword =
      () => Promise.reject(new Error('keychain unavailable'));
    try {
      expect(await isVerificationBannerDismissed()).toBe(false);
    } finally {
      (Keychain as unknown as { getGenericPassword: typeof origGet }).getGenericPassword =
        origGet;
    }
  });
});
