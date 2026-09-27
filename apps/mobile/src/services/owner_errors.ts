/**
 * Reading an owner action's refusal, the same way on every owner screen.
 *
 * The owner clients raise their own error classes (`OwnerCommerceHttpError`,
 * `OwnerSetupHttpError`, the web inbox's `OwnerInboxError`) with Core's error
 * key as `errorKey`; the phone's in-process Core client raises
 * `CoreHttpError` with Core's answer as `body`. These read either.
 */

/** What a browser that is not connected as the owner is told to do. */
export const CONNECT_OWNER_DEVICE_MESSAGE =
  'Connect this browser as the owner (Settings → Owner access) to do this here.';

/** Core's error key for a refused owner action, or `'error'` when it named none. */
export function errorKeyOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'error';
  const { errorKey, body } = err as { errorKey?: unknown; body?: unknown };
  if (typeof errorKey === 'string' && errorKey !== '') return errorKey;
  const fromBody = (body as { error?: unknown } | null | undefined)?.error;
  return typeof fromBody === 'string' && fromBody !== '' ? fromBody : 'error';
}

/** Core wants a person to prove they are here (passphrase, or a staff PIN) first. */
export function isPresenceRefusal(err: unknown): boolean {
  return errorKeyOf(err) === 'no_user_presence';
}

/**
 * A sentence to show the owner for a failed action.
 *
 * A refusal carrying Core's key is said by the key, not by the client's
 * message (`OwnerCommerceClient: prepare failed 409 — build_failed` is a log
 * line, not a sentence), or by Core's sentence when the route sent one; a
 * browser not connected is told how to connect. An error with no key keeps
 * its own message.
 */
export function ownerErrorText(err: unknown): string {
  const key = errorKeyOf(err);
  if (key === 'owner_device_not_connected') return CONNECT_OWNER_DEVICE_MESSAGE;
  // Some routes put a sentence in `error` (Core's own words): say it as is.
  if (key !== 'error') {
    return /^[a-z0-9_]+$/.test(key) ? `Dina could not do that (${key.replace(/_/g, ' ')}).` : key;
  }
  return err instanceof Error && err.message !== ''
    ? err.message
    : 'Something went wrong. Try again.';
}
