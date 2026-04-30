/**
 * Trust Network first-run modal tests (TN-MOB-027).
 *
 * Covers the dismissal gate that screens use to decide whether to
 * surface the modal:
 *
 *   - Default (fresh keystore) is "not dismissed"
 *   - Dismiss persists across reads (no in-memory racing)
 *   - Re-dismiss is idempotent — last write wins, no error
 *   - Clear restores "not dismissed"
 *   - A corrupt keystore row coerces to "not dismissed" rather than
 *     throwing (the user shouldn't be locked out of the modal-once
 *     invariant by a stale value from a future schema change)
 *   - Copy guards: pin the title + body shape so the V1 pseudonymity
 *     caveat doesn't get accidentally trimmed during a copy review
 *   - Frozen copy survives mutation attempts
 *
 * Persistence is the keychain mock at
 * `apps/mobile/__mocks__/react-native-keychain.ts` — its in-memory
 * dict is reset between tests via `resetKeychainMock()`.
 */

import { resetKeychainMock } from 'react-native-keychain';

import { setSecret } from '@dina/adapters-expo';

import {
  FIRST_RUN_MODAL_COPY,
  clearFirstRunDismissal,
  getFirstRunDismissedAt,
  isFirstRunModalDismissed,
  markFirstRunModalDismissed,
} from '../../src/trust/first_run';

const KEYSTORE_SERVICE = 'dina.trust.first_run_dismissed_at';

beforeEach(() => {
  resetKeychainMock();
});

// ─── Dismissal gate ───────────────────────────────────────────────────────

describe('isFirstRunModalDismissed', () => {
  it('returns false on a fresh keystore', async () => {
    expect(await isFirstRunModalDismissed()).toBe(false);
  });

  it('returns true after markFirstRunModalDismissed', async () => {
    await markFirstRunModalDismissed();
    expect(await isFirstRunModalDismissed()).toBe(true);
  });

  it('returns false again after clearFirstRunDismissal', async () => {
    await markFirstRunModalDismissed();
    expect(await isFirstRunModalDismissed()).toBe(true);
    await clearFirstRunDismissal();
    expect(await isFirstRunModalDismissed()).toBe(false);
  });

  it('coerces a non-numeric keystore row to false (not throwing)', async () => {
    await setSecret(KEYSTORE_SERVICE, 'corrupt-value-from-a-future-schema');
    expect(await isFirstRunModalDismissed()).toBe(false);
  });

  it('coerces a negative timestamp to false', async () => {
    await setSecret(KEYSTORE_SERVICE, '-1');
    expect(await isFirstRunModalDismissed()).toBe(false);
  });

  it('coerces an empty-string row to false', async () => {
    await setSecret(KEYSTORE_SERVICE, '');
    expect(await isFirstRunModalDismissed()).toBe(false);
  });
});

describe('markFirstRunModalDismissed', () => {
  it('persists a numeric timestamp readable via getFirstRunDismissedAt', async () => {
    await markFirstRunModalDismissed(1_700_000_000_000);
    expect(await getFirstRunDismissedAt()).toBe(1_700_000_000_000);
  });

  it('defaults `now` to Date.now() when not supplied', async () => {
    const before = Date.now();
    await markFirstRunModalDismissed();
    const after = Date.now();
    const ts = await getFirstRunDismissedAt();
    if (ts === null) throw new Error('expected timestamp to be set');
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('is idempotent — re-dismissing overwrites with the latest timestamp', async () => {
    await markFirstRunModalDismissed(1_000);
    await markFirstRunModalDismissed(2_000);
    expect(await getFirstRunDismissedAt()).toBe(2_000);
  });

  it('rejects NaN, Infinity, and negative timestamps', async () => {
    await expect(markFirstRunModalDismissed(Number.NaN)).rejects.toThrow();
    await expect(markFirstRunModalDismissed(Number.POSITIVE_INFINITY)).rejects.toThrow();
    await expect(markFirstRunModalDismissed(-1)).rejects.toThrow();
  });
});

describe('getFirstRunDismissedAt', () => {
  it('returns null when never dismissed', async () => {
    expect(await getFirstRunDismissedAt()).toBeNull();
  });

  it('returns null when the row is corrupt', async () => {
    await setSecret(KEYSTORE_SERVICE, 'not-a-number');
    expect(await getFirstRunDismissedAt()).toBeNull();
  });
});

// ─── Copy guards ──────────────────────────────────────────────────────────

describe('FIRST_RUN_MODAL_COPY', () => {
  it('exposes a title, multi-paragraph body, and a single dismiss CTA', () => {
    expect(FIRST_RUN_MODAL_COPY.title).toBeTruthy();
    expect(FIRST_RUN_MODAL_COPY.body.length).toBeGreaterThan(0);
    expect(FIRST_RUN_MODAL_COPY.dismissLabel).toBeTruthy();
  });

  it('discloses the V1 pseudonymity caveat — namespaces are NOT anonymous to a sophisticated observer', () => {
    // Regression-guard: the disclosure is the entire reason the modal
    // exists per plan §13.10. Don't let a copy edit silently weaken it.
    //
    // The previous loose regex `/anonymous|namespace|signature|correlat/i`
    // would have PASSED even on an inverted disclosure like "These
    // namespaces ARE anonymous" — exactly the bug the test exists to
    // prevent. Mirror the strict negation-aware pattern the sister
    // surface (`about_disclosure.test.ts`) already uses, plus pin the
    // "correlating" half of the explanation so a refactor that kept
    // the negation but dropped the mechanism would also fail loudly.
    const allBody = FIRST_RUN_MODAL_COPY.body.join(' ');
    expect(allBody).toMatch(/aren't anonymous/i);
    expect(allBody).toMatch(/correlating/i);
  });

  it('disclosure is NOT the inverted form ("namespaces are anonymous")', () => {
    // Counter-pin: assert the affirmative ("are anonymous") does NOT
    // appear unqualified. The disclosure's load-bearing claim is a
    // negation; a future copy-edit that softened it to a positive
    // statement would silently weaken the §13.10 caveat. This test
    // closes that bug class explicitly.
    const allBody = FIRST_RUN_MODAL_COPY.body.join(' ');
    // "are anonymous" without a preceding "aren't" / "not" / "n't"
    // would mean the disclosure was inverted. The "aren't anonymous"
    // string contains "are" but is itself the negation, so we look
    // for the positive form that ISN'T preceded by a negator.
    expect(allBody).not.toMatch(/\bnamespaces are anonymous\b/i);
    expect(allBody).not.toMatch(/\bare anonymous\b(?!.*aren't)/i);
  });

  it('is frozen — top-level mutation throws or silently no-ops', () => {
    expect(Object.isFrozen(FIRST_RUN_MODAL_COPY)).toBe(true);
    expect(Object.isFrozen(FIRST_RUN_MODAL_COPY.body)).toBe(true);
    // In strict mode a frozen-object write throws; in sloppy mode it
    // silently no-ops. Either way the underlying value must not change.
    const before = FIRST_RUN_MODAL_COPY.title;
    try {
      (FIRST_RUN_MODAL_COPY as { title: string }).title = 'hacked';
    } catch {
      /* intentional */
    }
    expect(FIRST_RUN_MODAL_COPY.title).toBe(before);
  });
});
