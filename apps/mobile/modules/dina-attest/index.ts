/**
 * dina-attest — JS surface of the native DeviceCheck module.
 *
 * The app calls device attestation through `src/ai/attestation.ts`,
 * which guards on Platform.OS and looks the native module up by name
 * (`requireOptionalNativeModule('DinaAttest')`). This index is the
 * convention entry for the local Expo module and documents the native
 * contract; the native registration (ios/DinaAttestModule.swift +
 * expo-module.config.json) is what actually wires it.
 *
 * Native contract:
 *   generateDeviceCheckToken(): Promise<string | null>
 *     - real device with DeviceCheck support → base64 DeviceCheck token
 *     - simulator / unsupported device        → null
 *     - Apple error                            → rejects (caller maps to
 *                                                a transient retry)
 */

export interface DinaAttestNativeModule {
  generateDeviceCheckToken(): Promise<string | null>;
}
