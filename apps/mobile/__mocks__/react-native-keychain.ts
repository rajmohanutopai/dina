/**
 * Mock react-native-keychain for Jest tests.
 */

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
