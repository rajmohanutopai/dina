/**
 * Restart the app so the boot sequence re-runs.
 *
 * A few settings are wired only at BOOT, not on re-render, so applying them
 * needs a fresh boot:
 *   - the node role (constructs the provider responder + PDS publisher),
 *   - infra endpoints (PDS / AppView URLs),
 *   - a freshly restored vault (hydrated at boot).
 *
 * This replaces the old "force-quit and reopen Dina" instruction with a
 * one-tap restart. In a dev-client it reloads the JS bundle from Metro; in a
 * production build it reloads the active update via expo-updates. Both re-run
 * the full boot sequence and (auto-unlock) land back in the app.
 */

import * as Updates from 'expo-updates';
import { DevSettings } from 'react-native';

export async function reloadApp(): Promise<void> {
  if (__DEV__) {
    // expo-updates' reloadAsync is unsupported in development — use the
    // dev-client / Metro reload instead.
    DevSettings.reload();
    return;
  }
  try {
    await Updates.reloadAsync();
  } catch {
    // Best-effort fallback for a prod build without an updates runtime.
    DevSettings.reload();
  }
}
