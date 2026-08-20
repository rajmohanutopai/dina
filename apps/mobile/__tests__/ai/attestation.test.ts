/**
 * Device attestation seam — the JS guard logic around the native
 * DeviceCheck module. The Swift itself is verified on real hardware
 * (DeviceCheck can't run on a simulator); these tests pin every
 * graceful-fallback path that decides whether a claim even attempts.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import {
  __resetAttestationForTest,
  getDeviceCheckToken,
  getPlayIntegrityToken,
} from '../../src/ai/attestation';

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: jest.fn(),
}));

const mockRequire = requireOptionalNativeModule as jest.Mock;

interface NativeShape {
  generateDeviceCheckToken: () => Promise<string | null>;
  generatePlayIntegrityToken?: (n: number, h: string) => Promise<string | null>;
}

function setNative(impl: NativeShape | null): void {
  mockRequire.mockReturnValue(impl);
}

const origOS = Platform.OS;
const origProject = process.env.EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER;
const origFake = process.env.EXPO_PUBLIC_DINA_FAKE_ATTEST;

beforeEach(() => {
  __resetAttestationForTest();
  mockRequire.mockReset();
  (Platform as { OS: string }).OS = 'ios';
  delete process.env.EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER;
  delete process.env.EXPO_PUBLIC_DINA_FAKE_ATTEST;
});

afterAll(() => {
  (Platform as { OS: string }).OS = origOS;
  if (origProject === undefined) delete process.env.EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER;
  else process.env.EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER = origProject;
  if (origFake === undefined) delete process.env.EXPO_PUBLIC_DINA_FAKE_ATTEST;
  else process.env.EXPO_PUBLIC_DINA_FAKE_ATTEST = origFake;
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

  it('is iOS-only — returns null without a native lookup on Android (Play Integrity is the Android path)', async () => {
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

describe('getPlayIntegrityToken', () => {
  const PROJECT = '123456789012';

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
    process.env.EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER = PROJECT;
  });

  it('returns the token on a genuine device, passing the cloud project number + a request hash', async () => {
    let seenProject = 0;
    let seenHash = '';
    setNative({
      generateDeviceCheckToken: async () => null,
      generatePlayIntegrityToken: async (n, h) => {
        seenProject = n;
        seenHash = h;
        return 'pi-token';
      },
    });
    expect(await getPlayIntegrityToken()).toBe('pi-token');
    expect(seenProject).toBe(Number(PROJECT));
    expect(seenHash).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes as hex
  });

  it('returns null on iOS without any native lookup', async () => {
    (Platform as { OS: string }).OS = 'ios';
    expect(await getPlayIntegrityToken()).toBeNull();
    expect(mockRequire).not.toHaveBeenCalled();
  });

  it('returns null when no cloud project number is configured', async () => {
    delete process.env.EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER;
    setNative({
      generateDeviceCheckToken: async () => null,
      generatePlayIntegrityToken: async () => 'pi-token',
    });
    expect(await getPlayIntegrityToken()).toBeNull();
  });

  it('returns null (defers to DeviceCheck) when the dev fake-attest override is set', async () => {
    process.env.EXPO_PUBLIC_DINA_FAKE_ATTEST = 'fake';
    setNative({
      generateDeviceCheckToken: async () => 'fake',
      generatePlayIntegrityToken: async () => 'pi-token',
    });
    expect(await getPlayIntegrityToken()).toBeNull();
  });

  it('returns null when the native binary lacks the Play Integrity method (older build)', async () => {
    setNative({ generateDeviceCheckToken: async () => null });
    expect(await getPlayIntegrityToken()).toBeNull();
  });

  it('returns null (NOT throws) when Play Integrity rejects — transient', async () => {
    setNative({
      generateDeviceCheckToken: async () => null,
      generatePlayIntegrityToken: async () => {
        throw new Error('Play Integrity unavailable');
      },
    });
    await expect(getPlayIntegrityToken()).resolves.toBeNull();
  });

  it('returns null when the native module is absent entirely', async () => {
    setNative(null);
    expect(await getPlayIntegrityToken()).toBeNull();
  });
});
