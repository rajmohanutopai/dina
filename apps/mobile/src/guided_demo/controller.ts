/**
 * Guided-demo controller — the app-facing wrapper over the core orchestration
 * state machine (`@dina/core`'s `scope/guided_demo`) plus mobile cache
 * rehydration. The UI (entry screen, banner, recovery prompt) drives THIS;
 * the core engine owns the scope + recovery transitions.
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Functional Flow"
 */

import {
  startGuidedDemo as coreStart,
  startEmpty as coreStartEmpty,
  endGuidedDemo as coreEnd,
  pendingGuidedDemo,
  resumeGuidedDemo,
  markGuidedDemoStep,
  type ActiveDemoState,
  type DataScope,
} from '@dina/core';

import { refreshCachesForCurrentScope, rehydrateUserScopeCaches } from './rehydrate';

/**
 * "Start demo" — enter an isolated guided-demo scope, then swap the in-memory
 * Chat/Reminders caches over to that (empty) scope so the user's real data is
 * hidden for the duration of the demo (functional invariant #2). The repos are
 * already scope-filtered; this aligns the UI's in-memory read caches with them.
 */
export async function beginGuidedDemo(now: number = Date.now()): Promise<DataScope> {
  const scope = await coreStart(now);
  await refreshCachesForCurrentScope();
  return scope;
}

/** "Start empty" — stay on the normal user scope. */
export function beginEmpty(): void {
  coreStartEmpty();
}

/**
 * Resume a crashed demo: re-enter the persisted demo scope, swap the in-memory
 * caches over to it, and return the recorded step marker so the runner can
 * fast-forward. Returns null if there was no active demo to resume.
 */
export async function resumeGuidedDemoAndRefresh(): Promise<ActiveDemoState | null> {
  const active = await pendingGuidedDemo();
  if (active === null) return null;
  await resumeGuidedDemo();
  await refreshCachesForCurrentScope();
  return active;
}

/**
 * Finish / skip / delete-on-recovery: tear down the demo scope and refresh the
 * user-scope caches so the app lands in a clean, empty user Chat.
 */
export async function endGuidedDemoAndRefresh(): Promise<void> {
  await coreEnd();
  await rehydrateUserScopeCaches();
}

export { pendingGuidedDemo, resumeGuidedDemo, markGuidedDemoStep };
export type { ActiveDemoState, DataScope };
