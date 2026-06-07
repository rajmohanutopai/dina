/**
 * Scope-transition cache refresh for the guided demo.
 *
 * The repositories enforce `data_scope` at the SQL layer, but the app's read
 * paths for Chat and Reminders are served from in-memory caches (the chat
 * thread Map, the reminders Map) that are NOT scope-partitioned and are
 * MERGE-only on hydrate. So on EITHER scope transition the caches must be
 * cleared and re-read from the (now scope-filtered) repositories, or stale
 * cross-scope rows leak into the UI:
 *   - on START → the demo Chat/Reminders would still show the user's real
 *     data (functional invariant #2: user data must not appear in the demo);
 *   - on TEARDOWN → demo Chat/Reminders cards would linger after cleanup
 *     (functional invariant #1: demo data must not appear after cleanup).
 *
 * People are read live from the scoped people repository (no cache), and the
 * demo creates no D2D contacts (invariant #4), so only the reminders Map, the
 * chat thread, and the per-persona HNSW index need refreshing here.
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § "Cleanup" steps 4–5 +
 * "Functional Invariants" #1/#2.
 */

import { hydrateThread, listThreads } from '@dina/brain/chat';
import { dropGuidedDemoNotifications } from '@dina/brain/notifications';
import { hydrateContactDirectory } from '@dina/core';
import { hydrateRemindersFromRepo, resetReminderCaches } from '@dina/core/reminders';

import { getOpenPersonaNames, openPersonaDB } from '../storage/init';

/**
 * Clear and re-read every scope-sensitive in-memory cache so it reflects the
 * data visible in the CURRENT data scope. Safe to call after entering the demo
 * scope (hides user data) and after tearing it down (restores user data,
 * drops demo data). Reminders + thread are cleared-then-hydrated because their
 * hydrate helpers MERGE (never evict); the per-persona HNSW index is rebuilt
 * from the scope-filtered `vault_items` by re-opening each touched persona.
 */
export async function refreshCachesForCurrentScope(): Promise<void> {
  // Reminders Map: clear the cached rows, then hydrate from the scope-filtered
  // repo. Without the reset, hydrate's merge would keep the other scope's
  // reminders. Use the cache-only reset (NOT resetReminderState) so the
  // OS-push bridge (subscribeReminderCreated, installed once at unlock) stays
  // attached — otherwise reminders created after the first demo never schedule
  // a local notification.
  resetReminderCaches();
  await hydrateRemindersFromRepo();

  // Chat threads: force-replace EVERY open thread from the scope-filtered repo.
  // Not just 'main' — per-peer D2D threads live in the same unscoped in-memory
  // chat map, so a peer chat opened before the demo would keep showing the
  // user's real messages inside the demo (and demo messages after teardown).
  // force:true sets the thread to exactly the current scope's rows (empty for a
  // demo peer thread, since the demo creates no D2D). 'main' is always included.
  const threadIds = new Set<string>(['main', ...listThreads()]);
  for (const threadId of threadIds) {
    await hydrateThread(threadId, { force: true });
  }

  // Notifications inbox: drop any notification created in a guided-demo scope
  // (e.g. the agent-approval mirrored in by the global approval→inbox bridge).
  // The inbox is an in-memory store the DB-level cleanup can't reach, so a demo
  // notification would otherwise linger unread in Activity after Exit.
  dropGuidedDemoNotifications();

  // Contact directory projections (did/alias → person). The demo creates no
  // contacts, so this is a harmless refresh of the existing user contacts.
  hydrateContactDirectory();

  // Per-persona HNSW rebuild runs in the BACKGROUND (not awaited). Re-opening a
  // SQLCipher persona pays a key-derivation (KDF) cost of ~1–2s each, so
  // awaiting it here froze the JS thread during demo teardown and left the
  // banner on screen for seconds. It is safe to defer: isolation does NOT
  // depend on it — semantic search fetches every HNSW candidate through the
  // scope-filtered `getItem`/`queryAll`, so a stale index can only momentarily
  // affect recall, never leak cross-scope data. The rebuild drops the other
  // scope's embeddings as soon as it lands.
  void rebuildOpenPersonaIndexes();
}

/** Best-effort, non-blocking per-persona HNSW rebuild (see caller). */
async function rebuildOpenPersonaIndexes(): Promise<void> {
  for (const persona of getOpenPersonaNames()) {
    try {
      await openPersonaDB(persona);
    } catch {
      /* best-effort — a failed re-open just leaves a stale (scope-filtered) index */
    }
  }
}

/**
 * Back-compat alias for the teardown call site. Tearing down a demo scope and
 * refreshing the user-scope caches is just `refreshCachesForCurrentScope()`
 * after the scope has been switched back to `user`.
 */
export const rehydrateUserScopeCaches = refreshCachesForCurrentScope;
