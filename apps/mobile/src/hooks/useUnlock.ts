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

import { setAccessiblePersonas } from '@dina/brain';
import {
  closePersona,
  deriveDIDKey,
  deriveRootSigningKey,
  getPublicKey,
  listPersonas,
  unwrapSeed,
  type WrappedSeed,
} from '@dina/core';
import { openAllPersonasForInAppUser } from '@dina/home-node';

import { seedDefaultPersonas } from '../onboarding/default_personas';
import { loadPersistedDid } from '../services/identity_record';
import { wipeOrphanVaultFiles } from '../services/install_marker';
import {
  initializePersistence,
  openPersonaDB,
  isPersistenceReady,
  shutdownAllPersistence,
} from '../storage/init';

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
      // Self-heal for SQLCipher DEK mismatch. op-sqlite throws
      // "file is not a database" when the on-disk file was encrypted
      // with a different DEK than the one we just derived from the
      // unwrapped seed. The two known causes:
      //   1. Orphan SQLite file left from a prior install whose
      //      keychain we wiped (covered prospectively by `unlock_gate`'s
      //      install-marker check, but historical installs hit this
      //      state before the marker existed).
      //   2. The user provisioned a new identity OVER an existing one
      //      (rare, e.g. a backup-restore that retained Documents but
      //      not Keychain).
      // Either way: the only data the file contains was encrypted
      // with a key the user no longer has — it's already lost.
      // Wiping the orphan + retrying once gets the user out of
      // dev-degraded mode without any data loss they could have
      // recovered from anyway.
      const message = err instanceof Error ? err.message : String(err);
      if (/file is not a database/i.test(message)) {
         
        console.warn(
          '[unlock] SQLCipher DEK mismatch — wiping orphan vault files and retrying',
        );
        wipeOrphanVaultFiles();
        try {
          await initializePersistence(masterSeed, wrappedSeed.salt);
        } catch (retryErr) {
           
          console.warn('[unlock] persistence init failed after orphan wipe:', retryErr);
        }
      } else {
        // Persistence bring-up is best-effort from the unlock path: a
        // native-module failure (e.g. op-sqlite not installed in tests)
        // shouldn't brick unlock. The boot service's in-memory fallback
        // will fire with `persistence.in_memory` so the banner makes it
        // visible.
         
        console.warn('[unlock] persistence init failed:', err);
      }
    }
  }

  // 5. Open ALL personas via the shared lifecycle helper. The in-app
  //    user has full access by definition (they hold the master seed
  //    and just authenticated with the device passphrase) — tier-based
  //    access controls exist to protect against external agents
  //    reaching Core via dina-agent CLI, NOT against the owner using
  //    their own app.
  //
  //    `openAllPersonasForInAppUser` is the same helper the lite
  //    core-server's `storage/init.ts` calls at boot — one place to
  //    evolve this rule, one suite to test it (memory:
  //    `user-vs-agent-persona-access`).
  //
  //    The `openVaultDB` callback wires the op-sqlite handle for each
  //    persona AFTER the registry opens it; errors are reported but
  //    don't bail the whole unlock — a single bad SQLite file
  //    shouldn't brick the rest of the vault surface (this matches
  //    the prior behaviour where `openPersonaDB` failures were
  //    swallowed with a console.warn).
  state.step = 'opening_vaults';
  notify();
  const opened = await openAllPersonasForInAppUser({
    openVaultDB: isPersistenceReady()
      ? (persona: string) => openPersonaDB(persona)
      : undefined,
    onVaultOpenError: (persona: string, err: unknown) => {
       
      console.warn(`[unlock] openPersonaDB failed for "${persona}":`, err);
    },
  });
  state.openedPersonas = opened;

  // 6. Complete. Consume any pending force-prompt signal — a
  //    successful manual unlock is the user re-asserting access, so
  //    later re-seal/re-unlock cycles within the same launch can
  //    use auto-unlock again until the next Sign out.
  forcePromptOnNextUnlock = false;
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
  forcePromptOnNextUnlock = false;
  state = createInitialState();
  notify();
}

/**
 * One-shot, in-memory flag that suppresses the *next* keychain
 * auto-unlock. Set by `sealVault()`; consumed (and cleared) by the
 * unlock-gate's auto-unlock effect. Cleared automatically on a
 * successful manual `unlock()` so the auto-unlock path resumes for
 * subsequent re-locks within the same launch.
 *
 * Why this exists: the user's `startupMode === 'auto'` preference
 * caches the passphrase in keychain so cold boots don't prompt. But
 * "Sign out" must still force a passphrase prompt — otherwise the
 * gate would silently re-unlock from keychain and the button would be
 * a no-op. This flag lets Sign out keep the user's auto-unlock
 * preference intact across launches while still making *this* relock
 * meaningful. The flag is process-local (no keychain write), so a
 * cold restart correctly returns to the user's chosen startup mode.
 */
let forcePromptOnNextUnlock = false;

/**
 * @returns true when the next unlock attempt MUST come from a
 * user-typed passphrase rather than the keychain auto-unlock cache.
 */
export function shouldForcePromptOnUnlock(): boolean {
  return forcePromptOnNextUnlock;
}

/**
 * Reset the force-prompt flag — called by tests and by the unlock
 * gate after it has consumed the signal.
 */
export function clearForcePromptOnUnlock(): void {
  forcePromptOnNextUnlock = false;
}

/**
 * Seal the vault ("Sign out" UX): tear down all open SQLCipher
 * handles, drop the in-memory persona registry, flip `isUnlocked()`
 * back to false, AND set the force-prompt flag so the gate doesn't
 * silently re-unlock from the keychain on the next vault access.
 *
 * After this returns the next vault access requires a fresh `unlock()`
 * call from a user-typed passphrase (Argon2id KDF + SQLCipher open).
 * Subscribers to `subscribeToUnlockState` see the transition
 * synchronously, so the UnlockGate re-renders to its locked screen on
 * the next React tick.
 *
 * Idempotent — calling on an already-sealed vault is a no-op for the
 * teardown side-effects, but still arms the force-prompt flag so the
 * UX matches the user's intent ("from now until I re-enter, prompt").
 *
 * `forcePrompt` (default `true`): explicit Sign out / Lock arm the
 * force-prompt flag so the next vault access prompts for the passphrase.
 * The background auto-lock passes `false` — a user who chose
 * `startupMode === 'auto'` should be silently re-unlocked from the
 * keychain on resume, not made to re-type the passphrase after every
 * idle background lock (that defeats "unlock automatically" — #367).
 * Sealing still happens either way; only the re-prompt differs.
 */
export async function sealVault(opts: { forcePrompt?: boolean } = {}): Promise<void> {
  forcePromptOnNextUnlock = opts.forcePrompt ?? true;
  if (state.step !== 'complete') {
    // Already sealed (or mid-unlock); nothing to tear down. Still
    // reset state so a partial-unlock leftover (`failed` / mid-step)
    // can't prevent the next unlock attempt from running cleanly.
    state = createInitialState();
    notify();
    return;
  }
  setAccessiblePersonas([]);
  // Close all open personas in the in-memory registry so the next unlock()
  // starts from the correct initial state. openBootPersonas() checks
  // !isOpen before re-opening — without this reset it finds them already
  // open, returns [], and setAccessiblePersonas([]) is set with an empty
  // list (MT-12-I2 root cause: the secondary symptom was in the drain, but
  // the root cause is that isOpen flags survive sealVault).
  for (const p of listPersonas()) {
    if (p.isOpen) closePersona(p.name);
  }
  await shutdownAllPersistence();
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
