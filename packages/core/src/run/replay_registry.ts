/**
 * Held-replay hook registry (R5-01 — §7 "admitted exactly-once on unlock").
 *
 * The run plane registers its `replayForPersona` here when the locked-arrival
 * store is composed; the persona-unlock points in Core (the owner unlock route,
 * the agent-grant activation) fire it after a persona's DEK lands in RAM, so a
 * `held_by_lock` response is admitted the moment its persona reopens — without
 * the unlock sites needing a reference to the plane. Single-slot (one plane per
 * process); best-effort at the call sites (an unlock never fails on a replay
 * error — boot recovery retries).
 */

export type HeldReplayHook = (persona: string) => void;

let hook: HeldReplayHook | null = null;

export function setHeldReplayHook(fn: HeldReplayHook | null): void {
  hook = fn;
}

/** Fire the replay for a just-unlocked persona. Never throws. */
export function fireHeldReplay(persona: string): void {
  if (hook === null) return;
  try {
    hook(persona);
  } catch {
    /* best-effort — boot recovery replays anything missed */
  }
}
