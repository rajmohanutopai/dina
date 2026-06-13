/**
 * Device attestation seam (docs/CREDITS_DESIGN.md §claim).
 *
 * Backed by the local Expo module `DinaAttest`
 * (apps/mobile/modules/dina-attest), which wraps Apple DeviceCheck
 * (`DCDevice.generateToken`). DeviceCheck needs NO entitlement, so the
 * production build requires no capability change — only a native rebuild
 * that includes the module.
 *
 * Graceful by construction — `getDeviceCheckToken()` returns null (→ the
 * claim flow parks as 'unavailable', BYOK stays the door) on every path
 * where a real token can't be produced:
 *   - non-iOS (Android grants are disabled at v1; web)
 *   - the native module isn't in the running binary (the current
 *     simulator dev client, Expo Go, or a build predating this module)
 *   - the iOS simulator (DCDevice.isSupported == false)
 *   - an Apple-side error (caught → null → transient retry next launch)
 *
 * App Attest (`DCAppAttestService`) is the documented stronger target;
 * swapping it in is an internal change to the native module + this seam.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type { DinaAttestNativeModule } from '../../modules/dina-attest';

let resolved = false;
let nativeModule: DinaAttestNativeModule | null = null;

/**
 * Resolve the native module once, lazily. `requireOptionalNativeModule`
 * returns null when the module isn't in the binary; the try/catch is a
 * belt-and-suspenders guard for non-native runtimes (Jest, web) where
 * the lookup could behave unexpectedly.
 */
function getNativeModule(): DinaAttestNativeModule | null {
  if (!resolved) {
    resolved = true;
    try {
      nativeModule = requireOptionalNativeModule<DinaAttestNativeModule>('DinaAttest');
    } catch {
      nativeModule = null;
    }
  }
  return nativeModule;
}

export async function getDeviceCheckToken(): Promise<string | null> {
  // Dev/E2E attestation override (apps/mobile/maestro/credits). Real
  // DeviceCheck cannot run on a simulator, so the full claim→mint→balance
  // path is otherwise undrivable there. `EXPO_PUBLIC_*` is inlined by the
  // bundler at build time, so this branch is DEAD in any build that does
  // not set the var — it is not in eas.json's production env and must
  // never be. Mirrors the existing EXPO_PUBLIC_DINA_GRANTS_URL dev override.
  const devOverride = process.env.EXPO_PUBLIC_DINA_FAKE_ATTEST;
  if (devOverride !== undefined && devOverride !== '') return devOverride;

  // Android grants are disabled at v1 (no Play Integrity path yet); web
  // has no attestation. Short-circuit before touching the native lookup.
  if (Platform.OS !== 'ios') return null;

  const mod = getNativeModule();
  if (mod === null) return null;

  try {
    return await mod.generateDeviceCheckToken();
  } catch {
    // An Apple-side failure is transient — null parks the claim as
    // 'unavailable', which retries on the next launch rather than
    // latching a permanent refusal.
    return null;
  }
}

/** Test seam — clears the memoized module so each test resolves fresh. */
export function __resetAttestationForTest(): void {
  resolved = false;
  nativeModule = null;
}
