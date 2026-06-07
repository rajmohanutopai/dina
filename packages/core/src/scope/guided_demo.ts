/**
 * Guided-demo orchestration — the runtime-agnostic state machine the mobile
 * (and lite) first-run flow drives. It owns ONLY the scope + recovery
 * transitions; UI, scripted content, and cache rehydration live in the app.
 *
 *   start    → mint scope, persist recovery record, switch runtime into it
 *   pending  → (boot) the recoverable record, or null
 *   resume   → switch runtime back into the recovered scope
 *   end      → delete the demo scope, clear recovery, return to 'user'
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Functional Flow"
 */

import { kvGet, kvSet } from '../kv/store';

import { getActiveDemo, setActiveDemo, updateActiveDemoStep, type ActiveDemoState } from './active_demo';
import { tearDownDataScope } from './cleanup_wiring';
import {
  USER_SCOPE,
  currentDataScope,
  newGuidedDemoScope,
  setCurrentDataScope,
  type DataScope,
} from './data_scope';

/** First scripted step a fresh demo lands on. Must match `DEMO_STEPS[0].id`
 *  in the mobile guided-demo content. */
export const DEMO_FIRST_STEP = 'remember_emma_relation';

/** KV flag: the first-run entry screen has been offered (shown once, V1). */
const ENTRY_SEEN_KEY = 'guided_demo.entry_seen';

/** True once the user has been offered the first-run entry (start or skip). */
export async function hasSeenGuidedDemoEntry(): Promise<boolean> {
  return (await kvGet(ENTRY_SEEN_KEY)) === '1';
}

/** Record that the entry has been offered, so we don't nag after a skip. */
export async function markGuidedDemoEntrySeen(): Promise<void> {
  await kvSet(ENTRY_SEEN_KEY, '1');
}

/**
 * Start a guided demo: mint an isolated scope, persist the recovery record
 * (BEFORE switching, so a crash mid-start is still recoverable), then switch
 * the runtime into it. Returns the new scope.
 *
 * The step marker starts EMPTY (not `DEMO_FIRST_STEP`): the marker records the
 * last COMPLETED step, so `resumeAfter()` continues at the action AFTER it.
 * Seeding it with the first step would make a crash immediately after start
 * resume at the SECOND step, silently skipping "Emma is my daughter." An empty
 * marker resolves (via `resumeAfter`'s findIndex(-1)) to "resume from the
 * beginning". The runner overwrites it with each real step on success.
 */
export async function startGuidedDemo(now: number): Promise<DataScope> {
  const scope = newGuidedDemoScope();
  await setActiveDemo({ activeDemoScope: scope, startedAt: now, step: '' });
  setCurrentDataScope(scope);
  return scope;
}

/** "Start empty": ensure the runtime is on the normal user scope. */
export function startEmpty(): void {
  setCurrentDataScope(USER_SCOPE);
}

/** Boot-time check: the recoverable demo record, or null if none. */
export async function pendingGuidedDemo(): Promise<ActiveDemoState | null> {
  return getActiveDemo();
}

/**
 * Resume a recovered demo — switch the runtime back into its scope. Returns
 * the scope, or null if there's nothing to resume.
 */
export async function resumeGuidedDemo(): Promise<DataScope | null> {
  const active = await getActiveDemo();
  if (active === null) return null;
  setCurrentDataScope(active.activeDemoScope);
  return active.activeDemoScope;
}

/** Record progress through the scripted steps (best-effort; no-op if no demo). */
export async function markGuidedDemoStep(step: string): Promise<void> {
  await updateActiveDemoStep(step);
}

/**
 * End the demo (finish / skip / delete-on-recovery): tear down the demo
 * scope's data, clear the recovery record, return the runtime to 'user'.
 *
 * The scope to tear down is resolved from the PERSISTED record first (robust
 * across a restart where the runtime may already be on 'user'), falling back
 * to the live runtime scope. Returns the torn-down scope, or null when there
 * was nothing to clean up. The caller rehydrates user-scope caches afterward.
 */
export async function endGuidedDemo(): Promise<DataScope | null> {
  const active = await getActiveDemo();
  const scope = active?.activeDemoScope ?? currentDataScope();
  if (scope === USER_SCOPE) {
    setCurrentDataScope(USER_SCOPE); // idempotent — ensure we're on user
    return null;
  }
  await tearDownDataScope(scope); // delete rows + clearActiveDemo + scope→user
  return scope;
}
