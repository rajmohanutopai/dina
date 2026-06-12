/**
 * Device attestation seam (docs/CREDITS_DESIGN.md §claim).
 *
 * v1: returns null — simulators and dev clients cannot produce a
 * DeviceCheck token, and the production native module (DCDevice /
 * App Attest via a config-plugin) rides the next EAS build. The claim
 * flow treats null as `unavailable` and degrades gracefully (BYOK
 * affordance stays; no error surfaces).
 *
 * When the native module lands, this becomes:
 *   const token = await DeviceCheck.generateToken();
 * behind a Platform.OS === 'ios' guard, with App Attest as the
 * documented stronger target.
 */

export async function getDeviceCheckToken(): Promise<string | null> {
  return null;
}
