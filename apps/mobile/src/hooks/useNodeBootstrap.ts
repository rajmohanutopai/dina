/**
 * useNodeBootstrap — top-level effect that starts a DinaNode once the
 * app is unlocked + persistence is ready.
 *
 * Flow:
 *   1. Stays `idle` until `enabled` flips true (the layout ties this to
 *      `isUnlocked()`).
 *   2. On enable, builds a `BootServiceInputs` bundle via
 *      `buildBootInputs()` (persisted DID, DB adapter, AppView client,
 *      agenticAsk LLM when BYOK is set, role preference) and calls
 *      `bootAppNode`. Whatever is missing surfaces as a
 *      `BootDegradation` the layout banner renders.
 *   3. On success, a module-level singleton is set so screens that read
 *      Core globals (approvals, service-settings) work normally. The hook
 *      also caches the degradations list so consumers joining after the
 *      initial boot still see the banner data (issue #14).
 *   4. On failure, status flips to `error`. `bootAppNode` already
 *      disposed the node so process globals are clean.
 *   5. On unmount, only the hook instance that *created* the node tears
 *      it down — and it awaits `dispose()` before releasing the singleton
 *      so a fast remount can't boot a second node before the first has
 *      finished unwiring globals (issue #11).
 */

import { useEffect, useRef, useState } from 'react';
import { buildBootInputs } from '../services/boot_capabilities';
import {
  bootAppNode,
  BootStartupError,
  type BootDegradation,
  type BootServiceInputs,
} from '../services/boot_service';
import type { DinaNode } from '../services/bootstrap';
import type { NodeRole } from '../services/bootstrap';
import type { ProviderType } from '../ai/provider';

export interface NodeBootstrapOptions {
  /**
   * Boot only when this flag is true. The layout wires this to
   * `isUnlocked()` — before unlock there's no master seed / persona, so
   * the hook stays idle.
   */
  enabled?: boolean;
  /**
   * Overrides passed straight through to the boot composer. All fields
   * are optional; tests use this to pin deterministic inputs without
   * touching keychain.
   */
  overrides?: {
    didOverride?: string;
    roleOverride?: NodeRole;
    activeProvider?: ProviderType | 'none';
    appViewClient?: BootServiceInputs['appViewClient'];
    /**
     * When true, the boot composer seeds an in-memory AppView stub
     * with the Bus 42 demo profile. Off by default so production
     * installs never pick up demo state (findings #1, #15). The Expo
     * layout flips this based on `process.env.EXPO_PUBLIC_DINA_DEMO`.
     */
    demoMode?: boolean;
  };
}

export interface NodeBootstrapState {
  node: DinaNode | null;
  /**
   * `idle` — `enabled` is false, nothing started yet.
   * `booting` — awaiting `bootAppNode`.
   * `ready` — node started; degradations may still exist.
   * `error` — boot threw; `error` holds the detail.
   */
  status: 'idle' | 'booting' | 'ready' | 'error';
  error: Error | null;
  /** Boot-time degradations (missing optional deps). Empty iff fully wired. */
  degradations: BootDegradation[];
}

// Module-level singleton so non-hook consumers (like Brain tools that
// close over the DinaNode after boot) can reach the running node. Paired
// with `cachedDegradations` so a hook that mounts after boot ready still
// reports the same degradations the banner showed at first boot.
let singleton: DinaNode | null = null;
let cachedDegradations: BootDegradation[] = [];
// When a teardown is in flight we hold onto the promise so a fast
// remount can await it rather than racing ahead and booting a second
// node into the half-disposed globals (issue #11).
let pendingTeardown: Promise<void> | null = null;

export function getBootedNode(): DinaNode | null {
  return singleton;
}

/**
 * Snapshot of the cached boot-time degradations for consumers that
 * can't call the hook (e.g. the service-settings screen deciding
 * whether to show the "not actually discoverable" warning).
 */
export function getBootDegradations(): BootDegradation[] {
  return cachedDegradations.slice();
}

export function useNodeBootstrap(options: NodeBootstrapOptions = {}): NodeBootstrapState {
  const enabled = options.enabled !== false;
  const overrides = options.overrides;
  const [state, setState] = useState<NodeBootstrapState>(() => ({
    node: singleton,
    status: singleton !== null ? 'ready' : 'idle',
    error: null,
    degradations: cachedDegradations.slice(),
  }));

  // Keep the latest `overrides` available to the mounted effect without
  // re-running it on every reference change. The effect re-reads this ref
  // when it actually needs to boot (which happens iff `enabled` flipped
  // true or the effect was torn down and re-mounted). Identity swaps
  // that the caller wants to re-apply should flip `enabled` false → true
  // instead of silently mutating `overrides`, which keeps the lifecycle
  // explicit (issue #10).
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  useEffect(() => {
    if (!enabled) {
      // When disabled after having been enabled, surface the reset
      // state so consumers stop rendering stale ready-state.
      setState({
        node: null,
        status: 'idle',
        error: null,
        degradations: [],
      });
      return;
    }

    let disposed = false;
    let ownedNode: DinaNode | null = null;

    async function boot(): Promise<void> {
      // If a previous owner is still tearing down, wait for it before
      // composing a fresh node so the second boot doesn't see globals
      // that are mid-reset (issue #11).
      if (pendingTeardown !== null) {
        try {
          await pendingTeardown;
        } catch {
          /* ignore teardown error */
        }
      }
      if (disposed) return;

      if (singleton !== null) {
        // Another hook instance (StrictMode double-mount or a nested
        // consumer) already booted the node. Return its cached state
        // including the degradations we recorded the first time —
        // issue #14: previously returned `[]` so the banner
        // disappeared on the second mount.
        setState({
          node: singleton,
          status: 'ready',
          error: null,
          degradations: cachedDegradations.slice(),
        });
        return;
      }

      setState((s) => ({ ...s, status: 'booting', error: null }));
      try {
        const inputs = await buildBootInputs(overridesRef.current ?? {});
        const { node, degradations } = await bootAppNode(inputs);
        if (disposed) {
          await node.dispose();
          return;
        }
        ownedNode = node;
        singleton = node;
        cachedDegradations = degradations.slice();
        setState({ node, status: 'ready', error: null, degradations });
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (disposed) return;
        // Preserve the degradations bootAppNode collected before it
        // threw, so the banner can explain WHICH missing piece killed
        // boot (review #14). `BootStartupError` carries the snapshot.
        const partial = err instanceof BootStartupError ? err.degradations : [];
        cachedDegradations = partial.slice();
        setState({ node: null, status: 'error', error: err, degradations: partial });
      }
    }

    void boot();

    return () => {
      disposed = true;
      // Only tear down if this hook instance owns the node. StrictMode
      // double-mount shouldn't dispose the shared singleton.
      if (ownedNode !== null && singleton === ownedNode) {
        const node = ownedNode;
        pendingTeardown = (async () => {
          try {
            await node.dispose();
          } finally {
            if (singleton === node) {
              singleton = null;
              cachedDegradations = [];
            }
            pendingTeardown = null;
          }
        })();
      }
    };
  }, [enabled]);

  return state;
}
