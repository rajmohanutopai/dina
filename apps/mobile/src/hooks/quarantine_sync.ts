/**
 * Quarantine card sync — NATIVE / default.
 *
 * No-op: on mobile the in-process `onQuarantinedD2D` receive hook already
 * injects a review card into the main chat the moment Core quarantines an
 * unknown-sender message. The web peer (`quarantine_sync.web.ts`) polls Core
 * (via the brain proxy) on chat mount instead, because the thin-client has no
 * such in-process hook (F4 / MRS-05).
 */

export function syncQuarantineCards(_threadId: string): void {
  // intentionally empty
}
