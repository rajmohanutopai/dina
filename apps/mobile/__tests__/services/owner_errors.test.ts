/**
 * Reading an owner action's refusal (`owner_errors.ts`), saying why a
 * presence proof failed (`usePresenceGate.proofFailureText`), and telling the
 * owner something on the web (`show_message.web.ts`, where RN-Web's Alert
 * does nothing).
 */

import { CoreHttpError, OwnerCommerceHttpError } from '@dina/core';

import { proofFailureText } from '../../src/hooks/usePresenceGate';
import {
  CONNECT_OWNER_DEVICE_MESSAGE,
  errorKeyOf,
  isPresenceRefusal,
  ownerErrorText,
} from '../../src/services/owner_errors';
import { showMessage } from '../../src/services/show_message.web';

describe('errorKeyOf / isPresenceRefusal', () => {
  it('reads the key from an owner client error and from the in-process client’s body', () => {
    const owner = new OwnerCommerceHttpError('x', 403, 'no_user_presence');
    const inProcess = new CoreHttpError('x', 403, { error: 'no_user_presence' });
    expect(errorKeyOf(owner)).toBe('no_user_presence');
    expect(errorKeyOf(inProcess)).toBe('no_user_presence');
    expect(isPresenceRefusal(owner)).toBe(true);
    expect(isPresenceRefusal(inProcess)).toBe(true);
  });

  it('anything without a key is "error", never a presence refusal', () => {
    for (const err of [
      new Error('network down'),
      new CoreHttpError('x', 500),
      null,
      'text',
      undefined,
    ]) {
      expect(errorKeyOf(err)).toBe('error');
      expect(isPresenceRefusal(err)).toBe(false);
    }
  });
});

describe('ownerErrorText', () => {
  it('a browser not connected is told where to connect', () => {
    expect(ownerErrorText({ errorKey: 'owner_device_not_connected', message: 'x' })).toBe(
      CONNECT_OWNER_DEVICE_MESSAGE,
    );
  });
  it('a keyed refusal is said by the key, never by the client’s log line', () => {
    expect(
      ownerErrorText({
        errorKey: 'build_failed',
        message: 'OwnerCommerceClient: prepare failed 409 — build_failed',
      }),
    ).toBe('Dina could not do that (build failed).');
    // A route that answers a sentence is quoted as it is.
    expect(ownerErrorText({ errorKey: 'Could not create a pairing code; retry shortly' })).toBe(
      'Could not create a pairing code; retry shortly',
    );
  });
  it('otherwise the error’s own words, with a fallback for none', () => {
    expect(ownerErrorText(new Error('quote expired'))).toBe('quote expired');
    expect(ownerErrorText(new Error(''))).toBe('Something went wrong. Try again.');
    expect(ownerErrorText(42)).toBe('Something went wrong. Try again.');
  });
});

describe('proofFailureText', () => {
  it.each([
    [{ errorKey: 'not_proven' }, 'passphrase', 'That passphrase did not verify.'],
    [{ errorKey: 'access_denied' }, 'pin', 'That PIN did not verify.'],
    // An owner is never told "wrong passphrase" for an access refusal.
    [{ errorKey: 'access_denied' }, 'passphrase', 'Could not check it (access_denied).'],
    [
      { errorKey: 'presence_unavailable' },
      'passphrase',
      'This node has no way to check it. Ask the owner.',
    ],
    [new Error('network down'), 'passphrase', 'Could not check it. Try again.'],
  ] as const)('%o as %s', (err, kind, text) => {
    expect(proofFailureText(err, kind)).toBe(text);
  });
});

describe('showMessage on the web', () => {
  const g = globalThis as { window?: { alert?: (text: string) => void } };
  afterEach(() => {
    delete g.window;
  });
  it('uses the browser’s alert, title and message together', () => {
    const alert = jest.fn();
    g.window = { alert };
    showMessage('Could not revoke', 'staff_device_not_found');
    showMessage('Granted');
    expect(alert.mock.calls).toEqual([['Could not revoke\n\nstaff_device_not_found'], ['Granted']]);
  });
  it('with no window there is no one to tell, and nothing throws', () => {
    expect(() => showMessage('x', 'y')).not.toThrow();
  });
});
