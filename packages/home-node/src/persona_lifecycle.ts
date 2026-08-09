/**
 * Persona lifecycle helpers shared across hosts.
 *
 * Same decision (`open every persona because the in-app user has full
 * access by definition`) needs to fire on every Dina-stack startup,
 * just from different triggers:
 *
 *   - mobile (`apps/mobile/src/hooks/useUnlock.ts`) — on passphrase
 *     entry, inside the unlock state machine.
 *   - lite core-server (`apps/home-node-lite/core-server/src/storage/init.ts`)
 *     — at boot, after `bootstrapPersistence` opens the identity DB.
 *
 * Before this helper landed, each host expressed the same six-line
 * loop inline (`listPersonas() → openPersona(name, approved=true) →
 * setAccessiblePersonas(opened)`). DRYing it gives:
 *
 *   - One place to evolve the rule (e.g. if we later want to gate
 *     a specific persona behind biometric re-auth, that check goes
 *     here, not three places).
 *   - One test surface — host-side suites only need to assert the
 *     trigger fires; the body is unit-tested here.
 *
 * The brain-server side of the lite stack does NOT use this helper:
 * Brain runs in a separate process and doesn't own the persona
 * registry — it mirrors Core's list via `core.personasList()` HTTP
 * at boot. That mirror is intentionally a different shape (HTTP call,
 * no SQLite opens) and stays inlined in `brain-server/src/boot.ts`.
 *
 * Reference: memory entry `user-vs-agent-persona-access` — locks are
 * for external dina-agent CLI traffic, not the owner's own app.
 */

import { setAccessiblePersonas } from '@dina/brain';
import { listPersonas, openPersona as openPersonaInRegistry } from '@dina/core';

export interface OpenAllPersonasOptions {
  /**
   * Per-persona vault-DB opener — fires AFTER the in-memory registry
   * marks the persona open but BEFORE `setAccessiblePersonas` exposes
   * it to /ask. Lets the caller open SQLCipher handles (lite Core),
   * the op-sqlite native DB (mobile), or skip the step entirely
   * (lite Brain, which never touches SQLite).
   *
   * Called in sequence (not parallel) so a failure on one persona
   * doesn't leave a half-opened DB pool. Throwing here is fatal — the
   * caller decides whether to abort boot or fall back. Returning a
   * rejected promise has the same effect.
   *
   * Pass `undefined` to skip the DB-open step entirely.
   */
  openVaultDB?: (persona: string) => Promise<void> | void;
  /**
   * Optional per-persona error sink for the `openVaultDB` step. When
   * supplied, an error from `openVaultDB(persona)` is forwarded to
   * `onVaultOpenError(persona, err)` instead of propagating, and the
   * loop continues with the remaining personas. Mobile uses this so
   * a single bad SQLite file doesn't brick the rest of the vault
   * surface.
   *
   * Without `onVaultOpenError`, any throw aborts the loop and bubbles
   * up — that's the fail-loud default for server-side boot.
   */
  onVaultOpenError?: (persona: string, err: unknown) => void;
}

/**
 * Open every persona in the registry, optionally open each one's
 * vault DB, and publish the resulting list to Brain's
 * `accessiblePersonas` state.
 *
 * Returns the names of personas that ended up open — the caller can
 * use this for logging or state tracking. Always reads the registry
 * fresh at the end (never trusts the loop-internal counter) so a
 * persona that was already open before the call still appears in the
 * returned list.
 *
 * Idempotent: if every persona is already open, the function still
 * runs to refresh the accessible-personas publication (covers the
 * post-seal-vault → re-unlock case where personas keep `isOpen=true`
 * from the previous unlock but the module-global accessible list
 * got reset).
 */
export async function openAllPersonasForInAppUser(
  options: OpenAllPersonasOptions = {},
): Promise<string[]> {
  // 1. Walk the registry and approve-open any persona still closed.
  //    The `approved=true` second arg bypasses the tier-guard —
  //    approval is implicit because the in-app user already
  //    authenticated against the device passphrase (mobile) or owns
  //    the Core process (lite).
  for (const persona of listPersonas()) {
    if (!persona.isOpen) {
      openPersonaInRegistry(persona.name, true);
    }
  }

  // 2. Snapshot the open set AFTER the loop so we account for
  //    personas that were already open coming in.
  const opened = listPersonas()
    .filter((p) => p.isOpen)
    .map((p) => p.name);

  // 3. Open per-persona vault DB handles when wired. Mobile uses
  //    op-sqlite via `openPersonaDB`; lite Core uses
  //    `openPersonaVault` against its `NodeDBProvider`. Lite Brain
  //    skips this step entirely (no SQLite).
  if (options.openVaultDB !== undefined) {
    for (const persona of opened) {
      try {
        await options.openVaultDB(persona);
      } catch (err) {
        if (options.onVaultOpenError !== undefined) {
          options.onVaultOpenError(persona, err);
        } else {
          throw err;
        }
      }
    }
  }

  // 4. Publish to Brain's accessible-personas state so /ask
  //    fans-out across every vault. Done AFTER the DB opens so a
  //    half-opened persona never appears in vault_search results.
  setAccessiblePersonas(opened);

  return opened;
}
