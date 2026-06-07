/**
 * Active guided-demo state — boot-recovery metadata, NOT user content.
 *
 * Persisted in the identity DB's `kv_store` so that if the app crashes or is
 * killed mid-demo, the next boot can detect the in-progress demo and offer
 * "Continue demo / Delete demo and start empty" instead of silently merging
 * demo data into the user scope.
 *
 * Shape (design doc § "Persistent Active Demo State"):
 *   { activeDemoScope: 'guided_demo:<id>', startedAt: <ms>, step: '<step>' }
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md
 */

import { kvGet, kvSet, kvDelete } from '../kv/store';

import { isGuidedDemoScope, isValidDataScope, type DataScope } from './data_scope';

/** KV key holding the single active-demo record. */
export const ACTIVE_DEMO_KEY = 'guided_demo.active';

export interface ActiveDemoState {
  /** Always a `guided_demo:<run_id>` scope (never `user`). */
  activeDemoScope: DataScope;
  /** ms epoch the demo started (caller-supplied; module stays clock-free). */
  startedAt: number;
  /** Orchestrator step marker, e.g. `'remember_emma'`. */
  step: string;
}

/**
 * Read the active-demo record, or null if none / corrupt. The persisted blob
 * is validated: a missing or malformed scope returns null rather than handing
 * a garbage scope to cleanup/recovery (which would either no-op or, worse,
 * target the wrong container).
 */
export async function getActiveDemo(): Promise<ActiveDemoState | null> {
  const raw = await kvGet(ACTIVE_DEMO_KEY);
  if (raw === null) return null;
  let parsed: Partial<ActiveDemoState>;
  try {
    parsed = JSON.parse(raw) as Partial<ActiveDemoState>;
  } catch {
    return null;
  }
  const scope = parsed.activeDemoScope;
  if (typeof scope !== 'string' || !isValidDataScope(scope) || !isGuidedDemoScope(scope)) {
    return null;
  }
  return {
    activeDemoScope: scope,
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    step: typeof parsed.step === 'string' ? parsed.step : '',
  };
}

/** Persist the active-demo record. Rejects a non-demo scope (defensive). */
export async function setActiveDemo(state: ActiveDemoState): Promise<void> {
  if (!isGuidedDemoScope(state.activeDemoScope)) {
    throw new Error(
      `active demo: scope must be a guided_demo scope, got "${String(state.activeDemoScope)}"`,
    );
  }
  await kvSet(ACTIVE_DEMO_KEY, JSON.stringify(state));
}

/** Update only the step marker. No-op when there's no active demo. */
export async function updateActiveDemoStep(step: string): Promise<void> {
  const existing = await getActiveDemo();
  if (existing === null) return;
  await setActiveDemo({ ...existing, step });
}

/** Remove the active-demo record (after cleanup completes). Idempotent. */
export async function clearActiveDemo(): Promise<void> {
  await kvDelete(ACTIVE_DEMO_KEY);
}

/** True iff a recoverable demo record exists (boot-time check). */
export async function hasActiveDemo(): Promise<boolean> {
  return (await getActiveDemo()) !== null;
}
