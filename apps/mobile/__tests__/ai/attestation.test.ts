/**
 * Device attestation seam — the JS guard logic around the native
 * DeviceCheck module. The Swift itself is verified on real hardware
 * (DeviceCheck can't run on a simulator); these tests pin every
 * graceful-fallback path that decides whether a claim even attempts.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { __resetAttestationForTest, getDeviceCheckToken } from '../../src/ai/attestation';

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: jest.fn(),
}));

const mockRequire = requireOptionalNativeModule as jest.Mock;

function setNative(impl: { generateDeviceCheckToken: () => Promise<string | null> } | null): void {
  mockRequire.mockReturnValue(impl);
}

const origOS = Platform.OS;

beforeEach(() => {
  __resetAttestationForTest();
  mockRequire.mockReset();
  (Platform as { OS: string }).OS = 'ios';
});

afterAll(() => {
  (Platform as { OS: string }).OS = origOS;
});

describe('getDeviceCheckToken', () => {
  it('returns the token on iOS when the native module produces one', async () => {
    setNative({ generateDeviceCheckToken: async () => 'base64-token' });
    expect(await getDeviceCheckToken()).toBe('base64-token');
  });

  it('returns null on iOS when the simulator/device reports unsupported (native returns null)', async () => {
    setNative({ generateDeviceCheckToken: async () => null });
    expect(await getDeviceCheckToken()).toBeNull();
  });

  it('returns null when the native module is absent (current sim build / Expo Go)', async () => {
    setNative(null);
    expect(await getDeviceCheckToken()).toBeNull();
  });

  it('returns null (NOT throws) when the native module rejects — Apple error → transient', async () => {
    setNative({
      generateDeviceCheckToken: async () => {
        throw new Error('DeviceCheck unavailable');
      },
    });
    await expect(getDeviceCheckToken()).resolves.toBeNull();
  });

  it('does not even look up the native module on Android (grants disabled at v1)', async () => {
    (Platform as { OS: string }).OS = 'android';
    expect(await getDeviceCheckToken()).toBeNull();
    expect(mockRequire).not.toHaveBeenCalled();
  });

  it('does not look up the native module on web', async () => {
    (Platform as { OS: string }).OS = 'web';
    expect(await getDeviceCheckToken()).toBeNull();
    expect(mockRequire).not.toHaveBeenCalled();
  });

  it('tolerates requireOptionalNativeModule itself throwing (non-native runtime)', async () => {
    mockRequire.mockImplementation(() => {
      throw new Error('no native registry');
    });
    await expect(getDeviceCheckToken()).resolves.toBeNull();
  });

  it('memoizes the native lookup — resolves once across calls', async () => {
    setNative({ generateDeviceCheckToken: async () => 'tok' });
    await getDeviceCheckToken();
    await getDeviceCheckToken();
    expect(mockRequire).toHaveBeenCalledTimes(1);
  });
});
