/**
 * Live persona directory for the split-process Brain (REAL_LIFE_FIXES §2.3).
 *
 * Brain needs Core's persona list in three places: `vault_search` (which
 * vaults to read), the remember prompt (which vaults to route to) and the
 * agent gate's tier lookups. A one-shot read at boot left all three empty
 * whenever Brain started before Core, until a restart. This directory:
 *
 *   - retries the first read with backoff until it succeeds;
 *   - then refreshes on a fixed interval, and on demand (`refresh()`);
 *   - mirrors names into the accessible-persona list and tiers into Brain's
 *     local registry, following creates, deletes and tier changes.
 *
 * Until the first read succeeds the accessible list stays empty and the
 * agent gate treats unknown personas as gated, so an empty directory can
 * only narrow what Brain reads, never widen it.
 */

import { setAccessiblePersonas } from '@dina/brain';
import {
  createPersona,
  getPersona,
  listPersonas,
  setPersonaTierInMemory,
  type CoreClient,
  type PersonaListEntry,
  type PersonaTier,
} from '@dina/core';

const VALID_TIERS = new Set<PersonaTier>(['default', 'standard', 'sensitive', 'locked']);

export interface PersonaDescriptor {
  name: string;
  description: string;
}

export interface PersonaDirectoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PersonaDirectoryOptions {
  core: Pick<CoreClient, 'personasList'>;
  logger: PersonaDirectoryLogger;
  /** Fallback descriptions for personas Core has no description for. */
  fallbackDescriptions?: Record<string, string>;
  /** First retry delay. Default 500 ms. */
  initialBackoffMs?: number;
  /** Retry delay cap. Default 30 s. */
  maxBackoffMs?: number;
  /** Refresh interval once synced. Default 30 s. */
  refreshIntervalMs?: number;
  /** Injectable timers for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface PersonaDirectory {
  /** Start the first read (retrying) and the refresh loop. Resolves after the first success. */
  start(): Promise<void>;
  /** Re-read Core now. Never throws; a failure keeps the last good copy. */
  refresh(): Promise<boolean>;
  /** True once a read has succeeded. */
  isSynced(): boolean;
  /** Current persona descriptors (for the remember prompt). */
  descriptors(): PersonaDescriptor[];
  /** Stop timers. */
  dispose(): void;
}

export function createPersonaDirectory(options: PersonaDirectoryOptions): PersonaDirectory {
  const initialBackoff = options.initialBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const interval = options.refreshIntervalMs ?? 30_000;
  const setT =
    options.setTimeoutFn ??
    ((fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms);
      if (typeof h === 'object' && h !== null && 'unref' in h) (h as { unref(): void }).unref();
      return h;
    });
  const clearT = options.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

  let entries: PersonaListEntry[] = [];
  let synced = false;
  let disposed = false;
  let timer: unknown = null;
  let inFlight: Promise<boolean> | null = null;

  function mirror(next: PersonaListEntry[]): void {
    const names = next.map((p) => p.name);
    setAccessiblePersonas(names);
    const wanted = new Map(next.map((p) => [p.name, p]));
    for (const p of next) {
      // An unrecognised tier is mirrored as `locked` (fail closed).
      const tier: PersonaTier = VALID_TIERS.has(p.tier) ? p.tier : 'locked';
      const local = getPersona(p.name);
      if (local === null) {
        try {
          createPersona(p.name, tier, p.description ?? '');
        } catch {
          // Invalid name / duplicate race: the accessible list above still
          // bounds what vault_search can reach.
        }
      } else if (local.tier !== tier) {
        setPersonaTierInMemory(p.name, tier);
      }
    }
    // A persona Core no longer lists is locked here, never deleted: a
    // delete in this process would also purge Brain-side state keyed to it.
    // It has already left the accessible list above.
    for (const local of listPersonas()) {
      if (!wanted.has(local.name) && local.tier !== 'locked') {
        setPersonaTierInMemory(local.name, 'locked');
      }
    }
  }

  async function refresh(): Promise<boolean> {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        const next = await options.core.personasList();
        mirror(next);
        entries = next;
        if (!synced) {
          options.logger.info(
            { count: next.length, personas: next.map((p) => p.name) },
            'brain-server persona directory synced from Core',
          );
        }
        synced = true;
        return true;
      } catch (err) {
        options.logger.warn(
          { error: err instanceof Error ? err.message : String(err), synced },
          'brain-server persona directory read failed',
        );
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function schedule(ms: number, fn: () => void): void {
    if (disposed) return;
    timer = setT(fn, ms);
  }

  function loop(): void {
    schedule(interval, () => {
      void refresh().finally(loop);
    });
  }

  return {
    start(): Promise<void> {
      return new Promise<void>((resolve) => {
        let backoff = initialBackoff;
        const attempt = (): void => {
          if (disposed) return resolve();
          void refresh().then((ok) => {
            if (ok) {
              loop();
              resolve();
              return;
            }
            const wait = backoff;
            backoff = Math.min(backoff * 2, maxBackoff);
            schedule(wait, attempt);
          });
        };
        attempt();
      });
    },
    refresh,
    isSynced: () => synced,
    descriptors: () =>
      entries.map((p) => ({
        name: p.name,
        description:
          p.description !== undefined && p.description !== ''
            ? p.description
            : (options.fallbackDescriptions?.[p.name] ?? ''),
      })),
    dispose(): void {
      disposed = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
  };
}
