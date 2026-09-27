/**
 * Run an owner action behind Core's presence check (WEB_OWNER_SURFACE_PLAN §3.8).
 *
 * `run(operation)` runs the action. When Core answers `no_user_presence`, the
 * sheet opens; once the person proves presence, the SAME action runs again.
 * Any other failure goes to `onError`, including a failure of that retry, so
 * a good passphrase is never reported as a wrong one. `onSettled` runs after
 * every attempt (a screen reloads there).
 *
 * `run` settles only when the action is done with: it ran (or failed), or the
 * person cancelled the sheet. A screen that holds its busy flag across
 * `await run(...)` therefore keeps it through the sheet and the retry, so a
 * second tap cannot send a second award or order while the first is in flight.
 */

import { useCallback, useRef, useState } from 'react';

import { errorKeyOf, isPresenceRefusal } from '../services/owner_errors';

import type { PresenceSheetProps } from '../components/PresenceSheet';

export interface PresenceGateOptions {
  /** Prove presence with what the person typed (the owner's passphrase, a staff PIN). */
  prove: (secret: string) => Promise<void>;
  onError: (err: unknown) => void;
  onSettled?: () => void;
  secretKind?: 'passphrase' | 'pin';
  reason?: string;
}

export interface PresenceGate {
  run: (operation: () => Promise<void>) => Promise<void>;
  sheet: PresenceSheetProps;
}

/**
 * Why a proof failed, in words. A wrong passphrase answers `not_proven`; a
 * wrong staff PIN answers `access_denied` (one bit out, by design). A failure
 * with no key (the node unreachable) is not called a wrong secret.
 */
export function proofFailureText(err: unknown, secretKind: 'passphrase' | 'pin'): string {
  const key = errorKeyOf(err);
  if (key === 'not_proven' || (secretKind === 'pin' && key === 'access_denied')) {
    return secretKind === 'pin' ? 'That PIN did not verify.' : 'That passphrase did not verify.';
  }
  if (key === 'presence_unavailable' || key === 'staff_presence_unavailable') {
    return 'This node has no way to check it. Ask the owner.';
  }
  if (key === 'error') return 'Could not check it. Try again.';
  return `Could not check it (${key}).`;
}

export function usePresenceGate(options: PresenceGateOptions): PresenceGate {
  const secretKind = options.secretKind ?? 'passphrase';
  // The latest callbacks, so a retry after the sheet never calls a stale one.
  const latest = useRef(options);
  latest.current = options;

  /** The refused action waiting on the sheet, and the `run` call to settle after it. */
  const [pending, setPending] = useState<{
    operation: () => Promise<void>;
    settle: () => void;
  } | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** One attempt. True when it is finished with; false when it now waits on the sheet. */
  const attempt = useCallback(
    async (operation: () => Promise<void>, settle: () => void): Promise<boolean> => {
      try {
        await operation();
        return true;
      } catch (err) {
        if (isPresenceRefusal(err)) {
          setError(null);
          setPending({ operation, settle });
          return false;
        }
        latest.current.onError(err);
        return true;
      } finally {
        latest.current.onSettled?.();
      }
    },
    [],
  );

  const run = useCallback(
    (operation: () => Promise<void>) =>
      new Promise<void>((resolve) => {
        void attempt(operation, resolve).then((finished) => {
          if (finished) resolve();
        });
      }),
    [attempt],
  );

  const submit = useCallback(async () => {
    if (pending === null || busy || secret.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      // A passphrase goes as typed: onboarding, unlock and both verifiers use
      // the exact string, so one ending in a space must prove here too. A PIN
      // is digits; a stray space around it is trimmed.
      await latest.current.prove(secretKind === 'pin' ? secret.trim() : secret);
    } catch (err) {
      setError(proofFailureText(err, secretKind));
      setBusy(false);
      return;
    }
    const { operation, settle } = pending;
    setPending(null);
    setSecret('');
    setBusy(false);
    if (await attempt(operation, settle)) settle();
  }, [attempt, busy, pending, secret, secretKind]);

  const cancel = useCallback(() => {
    pending?.settle();
    setPending(null);
    setSecret('');
    setError(null);
  }, [pending]);

  return {
    run,
    sheet: {
      visible: pending !== null,
      secretKind,
      secret,
      onChangeSecret: setSecret,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      error,
      busy,
      onSubmit: () => void submit(),
      onCancel: cancel,
    },
  };
}
