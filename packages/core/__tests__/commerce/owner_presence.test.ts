/**
 * §10 item 9 — presence, which used to be a hard-coded `false`.
 *
 * The lane refuses to confirm or approve unless Core can establish that a
 * person is present, and on a server it never could: `ownerPresenceAvailable()`
 * returned a constant, so a seller could build a draft and never publish it.
 * A live run found that before any test did, because every test here supplied
 * its own `userPresent` and none of them asked what the ROUTES supplied.
 *
 * These drive the module the routes now read.
 */

import {
  OWNER_PRESENCE_TTL_MS,
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  ownerPresenceCanBeEstablished,
  ownerPresentNow,
  proveOwnerPresence,
} from '../../src/commerce/owner_presence';

const T0 = 1_800_000_500_000;
const RIGHT = 'correct horse battery staple';

afterEach(() => {
  installOwnerPresenceVerifier(null);
  clearOwnerPresence();
});

describe('whether presence can be established at all', () => {
  it('is false with no verifier, and asking cannot prove anything', async () => {
    // FAIL CLOSED. A node with no way to check a passphrase must not be able
    // to reach a state where it thinks somebody is here.
    installOwnerPresenceVerifier(null);
    expect(ownerPresenceCanBeEstablished()).toBe(false);
    expect(await proveOwnerPresence(RIGHT, T0)).toBe(false);
    expect(ownerPresentNow(T0)).toBe(false);
  });

  it('is true once a verifier is installed, even before anyone proves anything', () => {
    // A CAPABILITY, not an instant. The retired item-list route asks this one:
    // the bypass should close when the lane becomes usable, not flicker with
    // whether somebody happens to be at the keyboard.
    installOwnerPresenceVerifier(async () => true);
    expect(ownerPresenceCanBeEstablished()).toBe(true);
    expect(ownerPresentNow(T0)).toBe(false);
  });
});

describe('proving it', () => {
  it('accepts the right passphrase and stamps the clock', async () => {
    installOwnerPresenceVerifier(async (p) => p === RIGHT);
    expect(await proveOwnerPresence(RIGHT, T0)).toBe(true);
    expect(ownerPresentNow(T0)).toBe(true);
  });

  it('refuses the wrong one, and leaves nobody present', async () => {
    installOwnerPresenceVerifier(async (p) => p === RIGHT);
    expect(await proveOwnerPresence('hunter2', T0)).toBe(false);
    expect(ownerPresentNow(T0)).toBe(false);
  });

  it('refuses an empty passphrase without consulting the verifier', async () => {
    // A backend that reads "no record" as "no mismatch" would otherwise be
    // handed the one input most likely to expose it.
    let asked = false;
    installOwnerPresenceVerifier(async () => {
      asked = true;
      return true;
    });
    expect(await proveOwnerPresence('', T0)).toBe(false);
    expect(asked).toBe(false);
  });

  it('treats a THROWING verifier as no proof', async () => {
    // A broken Argon2id backend must not read as a successful login. This is
    // the difference between failing closed and failing open, and it is one
    // `catch` away either direction.
    installOwnerPresenceVerifier(() => {
      throw new Error('the hasher is not available');
    });
    expect(await proveOwnerPresence(RIGHT, T0)).toBe(false);
    expect(ownerPresentNow(T0)).toBe(false);
  });

  it('does not keep the standing proof when a later attempt fails', async () => {
    let accept = true;
    installOwnerPresenceVerifier(async () => accept);
    await proveOwnerPresence(RIGHT, T0);
    accept = false;
    expect(await proveOwnerPresence('wrong', T0 + 1)).toBe(false);
    // The earlier proof is still inside its window, and a failed attempt is
    // not a reason to revoke it — the person who proved it is still there.
    expect(ownerPresentNow(T0 + 1)).toBe(true);
  });
});

describe('the window', () => {
  it('holds for the TTL and not a millisecond longer', async () => {
    installOwnerPresenceVerifier(async () => true);
    await proveOwnerPresence(RIGHT, T0);

    expect(ownerPresentNow(T0 + OWNER_PRESENCE_TTL_MS - 1)).toBe(true);
    expect(ownerPresentNow(T0 + OWNER_PRESENCE_TTL_MS)).toBe(false);
  });

  it('treats a clock that went BACKWARDS as nobody present', async () => {
    // Presence is the one thing that must not outlive the person. A proof
    // stamped ahead of the clock would otherwise stand for the whole skew,
    // which on a phone with a corrected date is hours.
    installOwnerPresenceVerifier(async () => true);
    await proveOwnerPresence(RIGHT, T0 + 60 * 60 * 1000);
    expect(ownerPresentNow(T0)).toBe(false);
  });

  it('drops on lock', async () => {
    installOwnerPresenceVerifier(async () => true);
    await proveOwnerPresence(RIGHT, T0);
    clearOwnerPresence();
    expect(ownerPresentNow(T0)).toBe(false);
  });

  it('drops when the verifier is swapped', async () => {
    // A boot sequence that installs a verifier must not inherit presence
    // proven against a different one.
    installOwnerPresenceVerifier(async () => true);
    await proveOwnerPresence(RIGHT, T0);
    installOwnerPresenceVerifier(async () => true);
    expect(ownerPresentNow(T0)).toBe(false);
  });
});
