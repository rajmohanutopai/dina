/**
 * Unlock screen hook — passphrase entry → full unlock flow.
 *
 * Flow:
 *   1. User enters passphrase (or biometric triggers keychain retrieval)
 *   2. Argon2id KDF → derive KEK
 *   3. AES-256-GCM unwrap → retrieve master seed
 *   4. SLIP-0010 → derive root signing key → DID
 *   5. Open boot personas (default + standard auto-open)
 *   6. Mark secrets as restored
 *
 * The hook tracks progress through each step for the UI progress indicator.
 * Supports biometric shortcut (passphrase from keychain without typing).
 *
 * Source: ARCHITECTURE.md Task 4.5
 */

import {
  deriveDIDKey,
  deriveRootSigningKey,
  getPublicKey,
  listPersonas,
  openBootPersonas,
  unwrapSeed,
  type WrappedSeed,
} from '@dina/core';
import { setAccessiblePersonas } from '@dina/brain';
import { loadPersistedDid } from '../services/identity_record';
import { initializePersistence, openPersonaDB, isPersistenceReady } from '../storage/init';
import { seedDefaultPersonas } from '../onboarding/default_personas';

export type UnlockStep =
  | 'idle'
  | 'validating'
  | 'deriving_kek'
  | 'unwrapping'
  | 'deriving_keys'
  | 'opening_vaults'
  | 'complete'
  | 'failed';

export interface UnlockState {
  step: UnlockStep;
  did: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  openedPersonas: string[];
}

/** Current unlock state. */
let state: UnlockState = createInitialState();

/**
 * Listeners notified whenever `state` transitions. Used by React hooks
 * that gate boot on `isUnlocked()` — without this, the layout can only
 * read a snapshot at mount and relies on a navigation remount to pick up
 * the unlock (issue #12).
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — subscribers mustn't block notify */
    }
  }
}

/** Subscribe to unlock-state transitions. Returns an unsubscribe fn. */
export function subscribeToUnlockState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function createInitialState(): UnlockState {
  return {
    step: 'idle',
    did: null,
    error: null,
    startedAt: null,
    completedAt: null,
    openedPersonas: [],
  };
}

/**
 * Attempt to unlock with a passphrase.
 *
 * @param passphrase — the user's passphrase
 * @param wrappedSeed — the stored wrapped seed (from first onboarding)
 * @returns The unlock state with DID on success, error on failure
 */
export async function unlock(passphrase: string, wrappedSeed: WrappedSeed): Promise<UnlockState> {
  state = createInitialState();
  state.step = 'validating';
  state.startedAt = Date.now();
  notify();

  // 1. Basic validation
  if (!passphrase) {
    return fail('Passphrase is required');
  }
  if (!wrappedSeed || !wrappedSeed.wrapped || !wrappedSeed.salt) {
    return fail('No stored identity — complete onboarding first');
  }

  // 2. Unwrap seed (Argon2id KDF + AES-256-GCM decrypt)
  state.step = 'deriving_kek';
  notify();
  let masterSeed: Uint8Array;
  try {
    state.step = 'unwrapping';
    notify();
    masterSeed = await unwrapSeed(passphrase, wrappedSeed);
  } catch {
    return fail('Wrong passphrase');
  }

  // 3. Derive signing key + DID.
  //    Identity precedence matches the runtime composer (review #14):
  //      - a persisted did:plc from onboarding wins outright,
  //      - otherwise we derive a did:key from the freshly-unwrapped
  //        seed so the screen and the booted node agree.
  //    Without this the unlock screen used to show a did:key while
  //    the runtime ran under the persisted did:plc.
  state.step = 'deriving_keys';
  notify();
  const rootKey = deriveRootSigningKey(masterSeed, 0);
  const pubKey = getPublicKey(rootKey.privateKey);
  const persistedDid = await loadPersistedDid();
  const did = persistedDid ?? deriveDIDKey(pubKey);
  state.did = did;

  // 4. Ensure the default persona set (general + work + health + finance)
  //    exists. Mirrors main Dina's `core/cmd/dina-core/main.go:443-450`
  //    bootstrap block so the LLM persona classifier sees the same
  //    `{name, tier, description}` triples cross-stack.
  seedDefaultPersonas();

  // 4a. Wire durable persistence (review #10) — without this the
  //     runtime boot falls back to in-memory workflow + service-config
  //     repos and all tasks / approvals vanish on app restart. The
  //     masterSeed + userSalt drive the per-persona DEK derivation in
  //     ProductionDBProvider. Only initialize once per process.
  if (!isPersistenceReady()) {
    try {
      await initializePersistence(masterSeed, wrappedSeed.salt);
    } catch (err) {
      // Persistence bring-up is best-effort from the unlock path: a
      // native-module failure (e.g. op-sqlite not installed in tests)
      // shouldn't brick unlock. The boot service's in-memory fallback
      // will fire with `persistence.in_memory` so the banner makes it
      // visible.
      // eslint-disable-next-line no-console
      console.warn('[unlock] persistence init failed:', err);
    }
  }

  // 5. Open boot personas (default + standard auto-open)
  state.step = 'opening_vaults';
  notify();
  const opened = openBootPersonas();
  state.openedPersonas = opened;

  // 5a. Wire persona-vault repos for every persona the unlock
  //     opened — `openPersonaDB` is a no-op when persistence init
  //     failed above.
  if (isPersistenceReady()) {
    for (const persona of opened) {
      try {
        await openPersonaDB(persona);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[unlock] openPersonaDB failed for "${persona}":`, err);
      }
    }
  }

  // 5b. Wire the /ask-side accessiblePersonas list. Without this,
  //     `assembleContext` defaults to searching only the `general`
  //     vault, and every `/remember` that routes to a non-general
  //     persona (health / family / professional / etc.) becomes
  //     invisible to `/ask`. Keeping this in lockstep with the
  //     unlocked-persona set is the critical wiring — latent bug
  //     documented in the scenario-1+2 E2E test's docstring.
  setAccessiblePersonas(opened);

  // 6. Complete
  state.step = 'complete';
  state.completedAt = Date.now();
  notify();

  return { ...state };
}

/**
 * Get the current unlock state (for progress display).
 */
export function getUnlockState(): UnlockState {
  return { ...state };
}

/**
 * Get the unlock step label for progress display.
 */
export function getStepLabel(step: UnlockStep): string {
  switch (step) {
    case 'idle':
      return 'Enter passphrase';
    case 'validating':
      return 'Validating...';
    case 'deriving_kek':
      return 'Deriving encryption key...';
    case 'unwrapping':
      return 'Decrypting identity...';
    case 'deriving_keys':
      return 'Deriving signing keys...';
    case 'opening_vaults':
      return 'Opening vaults...';
    case 'complete':
      return 'Unlocked';
    case 'failed':
      return 'Unlock failed';
  }
}

/**
 * Get the step index for progress bar (0-5).
 */
export function getStepProgress(step: UnlockStep): number {
  const steps: UnlockStep[] = [
    'validating',
    'deriving_kek',
    'unwrapping',
    'deriving_keys',
    'opening_vaults',
    'complete',
  ];
  const idx = steps.indexOf(step);
  return idx >= 0 ? idx : 0;
}

/**
 * Check if unlock is in progress.
 */
export function isUnlocking(): boolean {
  return state.step !== 'idle' && state.step !== 'complete' && state.step !== 'failed';
}

/**
 * Check if unlock completed successfully.
 */
export function isUnlocked(): boolean {
  return state.step === 'complete' && state.did !== null;
}

/**
 * Get unlock duration in milliseconds (for performance tracking).
 */
export function getUnlockDuration(): number | null {
  if (!state.startedAt || !state.completedAt) return null;
  return state.completedAt - state.startedAt;
}

/**
 * Reset unlock state (for testing or re-lock).
 */
export function resetUnlockState(): void {
  state = createInitialState();
  notify();
}

/** Set failed state with error. */
function fail(error: string): UnlockState {
  state.step = 'failed';
  state.error = error;
  state.completedAt = Date.now();
  notify();
  return { ...state };
}

/**
 * React hook — returns a live `isUnlocked()` boolean that re-renders when
 * the module-level unlock state transitions. Use this instead of the
 * snapshot `isUnlocked()` in render paths so the tree picks up the
 * unlock without waiting for a navigation remount.
 */
export function useIsUnlocked(): boolean {
  // Lazy-require React so the module itself stays test-friendly outside
  // a React runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useSyncExternalStore } = require('react') as typeof import('react');
  return useSyncExternalStore(subscribeToUnlockState, isUnlocked, isUnlocked);
}

/**
 * React hook — returns the live full `UnlockState` so a UI can render the
 * current step label ("Decrypting identity…", "Opening vaults…") instead
 * of a generic spinner. Re-renders on every step transition.
 *
 * `useSyncExternalStore` requires a stable snapshot reference between
 * notifications, so we cache the last returned state and only swap when a
 * field actually differs — without this, `getUnlockState()` returns a
 * fresh `{...state}` clone every call, React thinks the snapshot changed
 * every render, and the component infinite-loops.
 */
let lastSnapshot: UnlockState = state;
function getStableSnapshot(): UnlockState {
  if (
    state.step !== lastSnapshot.step ||
    state.did !== lastSnapshot.did ||
    state.error !== lastSnapshot.error ||
    state.startedAt !== lastSnapshot.startedAt ||
    state.completedAt !== lastSnapshot.completedAt ||
    state.openedPersonas !== lastSnapshot.openedPersonas
  ) {
    lastSnapshot = { ...state };
  }
  return lastSnapshot;
}

export function useUnlockState(): UnlockState {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useSyncExternalStore } = require('react') as typeof import('react');
  return useSyncExternalStore(subscribeToUnlockState, getStableSnapshot, getStableSnapshot);
}
