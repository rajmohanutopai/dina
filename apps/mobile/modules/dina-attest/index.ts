/**
 * dina-attest — JS surface of the native attestation module.
 *
 * The app calls device attestation through `src/ai/attestation.ts`,
 * which guards on Platform.OS and looks the native module up by name
 * (`requireOptionalNativeModule('DinaAttest')`). This index is the
 * convention entry for the local Expo module and documents the native
 * contract; the native registrations (ios/DinaAttestModule.swift +
 * android/.../DinaAttestModule.kt + expo-module.config.json) wire it.
 *
 * Native contract:
 *   generateDeviceCheckToken(): Promise<string | null>   [iOS]
 *     - real device with DeviceCheck support → base64 DeviceCheck token
 *     - simulator / unsupported device / Android → null
 *     - Apple error                            → rejects (caller maps to
 *                                                a transient retry)
 *
 *   generatePlayIntegrityToken(                            [Android]
 *     cloudProjectNumber: number, requestHash: string,
 *   ): Promise<string | null>
 *     - genuine device with Play services → Play Integrity token string
 *     - no Play services / iOS             → null
 *     - Play Integrity error               → rejects (caller maps to a
 *                                            transient retry)
 */

export interface DinaAttestNativeModule {
  generateDeviceCheckToken(): Promise<string | null>;
  generatePlayIntegrityToken?(
    cloudProjectNumber: number,
    requestHash: string,
  ): Promise<string | null>;
}
