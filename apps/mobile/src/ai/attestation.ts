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

  // DeviceCheck is iOS-only; Android attests via getPlayIntegrityToken.
  // Web has no attestation. Short-circuit before touching the native
  // lookup.
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

/** A per-request hash to bind the Play Integrity token to. It is not
 *  server-verified in v1 (freshness + Device Recall carry replay
 *  protection), so any high-entropy value serves; a random 32-hex string
 *  is plenty. */
function randomRequestHash(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } })
    .crypto;
  if (webCrypto?.getRandomValues !== undefined) {
    webCrypto.getRandomValues(bytes);
  } else {
    // Fallback for a runtime with no crypto — the hash is non-secret.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Android Play Integrity token for the anonymous grant claim. Resolves
 * null on every path where a real token can't be produced — iOS, the dev
 * fake-attest override (the DeviceCheck seam carries the fake instead),
 * a missing cloud-project-number config, the native module absent from
 * the running binary, or no Play services — so the claim parks as
 * 'unavailable' and BYOK stays the door. A genuine Play Integrity error
 * rejects; the caller maps a rejection to null / transient retry.
 */
export async function getPlayIntegrityToken(): Promise<string | null> {
  // Dev override lives on the DeviceCheck seam; here it means "don't try
  // real Play Integrity" so the claim uses the fake `devicecheck` token
  // that the dev grants server expects.
  const devOverride = process.env.EXPO_PUBLIC_DINA_FAKE_ATTEST;
  if (devOverride !== undefined && devOverride !== '') return null;

  if (Platform.OS !== 'android') return null;

  // Read literally — a dynamic env[key] does not inline in release builds.
  const projectRaw = process.env.EXPO_PUBLIC_DINA_PLAY_CLOUD_PROJECT_NUMBER;
  if (projectRaw === undefined || projectRaw === '') return null;
  const cloudProjectNumber = Number(projectRaw);
  if (!Number.isFinite(cloudProjectNumber) || cloudProjectNumber <= 0) return null;

  const mod = getNativeModule();
  if (mod === null || mod.generatePlayIntegrityToken === undefined) return null;

  try {
    return await mod.generatePlayIntegrityToken(cloudProjectNumber, randomRequestHash());
  } catch {
    // A Play-side failure is transient — null parks the claim, retried
    // next launch, never a permanent refusal.
    return null;
  }
}

/** Test seam — clears the memoized module so each test resolves fresh. */
export function __resetAttestationForTest(): void {
  resolved = false;
  nativeModule = null;
}
