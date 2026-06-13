/**
 * DEV / E2E ONLY — a DeviceState stub that bypasses Apple.
 *
 * Real DeviceCheck cannot run on an iOS simulator (DCDevice.isSupported
 * == false), so the simulator can never exercise the full
 * claim → provision → balance path against the live OpenRouter
 * provisioner. This stub treats EVERY token as a valid, never-claimed
 * device, letting the Maestro happy-path harness drive a REAL mint while
 * only the Apple round-trip is faked.
 *
 * Wired ONLY when `GRANTS_FAKE_DEVICECHECK=1` (see bin.ts), which logs a
 * loud warning at boot. It must never be set in production — the prod
 * deploy (deploy_shared_infra.sh) never sets it.
 */

import type { DeviceState } from './ports';

export class DevStubDeviceState implements DeviceState {
  /** Any token is a valid, unclaimed device — so a mint always proceeds. */
  async check(): Promise<{ claimed: boolean }> {
    return { claimed: false };
  }

  /** No Apple bits in dev — the persistent once-per-device flag is a noop. */
  async setClaimed(): Promise<void> {
    /* intentionally empty */
  }
}
