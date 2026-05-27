/**
 * Mock react-native-keychain for Jest tests.
 */

/** Mirrors the real `ACCESSIBLE` enum (string values). The mock ignores the
 *  `accessible` option functionally, but call sites read the enum members. */
export const ACCESSIBLE = {
  WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
  AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
  ALWAYS: 'AccessibleAlways',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly',
  ALWAYS_THIS_DEVICE_ONLY: 'AccessibleAlwaysThisDeviceOnly',
} as const;

const store: Record<string, { username: string; password: string }> = {};

export async function setGenericPassword(
  username: string,
  password: string,
  options?: { service?: string },
): Promise<boolean> {
  const key = options?.service ?? 'default';
  store[key] = { username, password };
  return true;
}

export async function getGenericPassword(options?: {
  service?: string;
}): Promise<false | { username: string; password: string }> {
  const key = options?.service ?? 'default';
  return store[key] ?? false;
}

export async function resetGenericPassword(options?: { service?: string }): Promise<boolean> {
  const key = options?.service ?? 'default';
  delete store[key];
  return true;
}

export function resetKeychainMock(): void {
  for (const key of Object.keys(store)) {
    delete store[key];
  }
}
