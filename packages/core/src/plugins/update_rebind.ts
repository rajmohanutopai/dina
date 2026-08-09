/**
 * Update-rebind coordinator (§9.13 / §16.5, WS-3.7).
 *
 * A plugin update moves an install to a new manifest CID. Three things must
 * change together, and the whole point of this module is that they DO:
 *
 *   1. authorizations for the PRIOR CID are created, so work already in
 *      flight keeps flowing and prior-major lifecycle calls keep being
 *      served;
 *   2. the install adopts the new CID;
 *   3. every published listing pinned to the old CID rebinds to the new one.
 *
 * WHY ONE TRANSACTION. Each pair being out of step is a real, reachable
 * failure:
 *
 *   - CID swapped, listings not rebound → every listing answers
 *     `binding_stale` and the supplier is silently off the market.
 *   - listings rebound, CID not swapped → listings pin a manifest the
 *     install does not run, which ingress refuses for the same reason.
 *   - CID swapped, authorizations not created → in-flight tasks and
 *     prior-major orders are terminalized at the claim guard, which for
 *     commerce means a buyer's open order stops being answerable.
 *
 * None of these is a crash; each is an ordinary interleaving. So the unit of
 * change is the transaction, not the step.
 *
 * WHY THE AUTHORIZATIONS COME FIRST INSIDE IT. They describe the PRIOR
 * contract, and they are built from the prior manifest — which is only
 * readable before the install adopts the new one.
 */

import { detectUpdateWidening, type WideningFinding } from './update_widening';

import type { DrainAuthorization, DrainAuthorizationRepository } from './drain_authorizations';
import type { PluginInstall, PluginInstallRepository } from './registry';
import type { PluginManifest } from '@dina/protocol';

export type RebindRefusal =
  | 'install_unknown'
  | 'cid_unchanged'
  | 'install_not_active'
  | 'stores_unavailable'
  | 'update_cas_lost'
  /**
   * §16.5 — the update asks for more than the owner consented to. Not an
   * error: the operator re-consents and applies it through the consent
   * ceremony. Refusing here is what stops "silently".
   */
  | 'requires_reconsent';

export type RebindOutcome =
  | {
      ok: true;
      /** Listings rewritten from the old CID to the new one. */
      rebound: string[];
      /** Authorizations created for the prior CID. */
      authorizations: number;
    }
  | {
      ok: false;
      refusal: RebindRefusal;
      detail?: string;
      /**
       * Present on `requires_reconsent`. EVERY widening, not the first — a
       * re-consent card that named one escalation while three rode along
       * would be worse than none.
       */
      widening?: WideningFinding[];
    };

/**
 * How long in-flight work has to drain against the prior contract. A `drain`
 * authorization expires; a `lifecycle_continuity` one does not, because
 * §9.13 keeps prior-major order lifecycle served until those orders are
 * TERMINAL, and no clock can know when that is.
 */
export const DEFAULT_DRAIN_MS = 24 * 60 * 60 * 1000;

/**
 * Does the owner's re-consent cover EXACTLY what this update widens?
 *
 * Set equality, not containment in either direction. A consent listing more
 * than was detected is stale — it was given against a different release, and
 * honouring it would let a re-prepare swap the manifest under an old yes. A
 * consent listing less is the obvious failure. Both are refusals.
 *
 * Compared on a canonical rendering of each finding rather than by identity,
 * because the consent crosses a wire boundary and comes back as plain data.
 */
function consentCovers(
  detected: readonly WideningFinding[],
  consented: readonly WideningFinding[] | undefined,
): boolean {
  if (consented === undefined) return false;
  const render = (f: WideningFinding): string =>
    JSON.stringify([f.kind, f.capabilityId, f.from ?? null, f.to]);
  const given = new Set(consented.map(render));
  if (given.size !== detected.length) return false;
  return detected.every((f) => given.has(render(f)));
}

export interface UpdateRebindDeps {
  /**
   * Resolved PER USE, not captured. The two stores are wired at different
   * points of different boots, so a coordinator that captured them at
   * construction would silently hold a null on whichever boot wires them
   * later — the boot-order coupling this codebase keeps paying for.
   */
  installs: () => PluginInstallRepository | null;
  drains: () => DrainAuthorizationRepository | null;
  /**
   * Rewrite every capability binding that pins `fromCid` on this install to
   * `toCid`. Injected because service config is a different subsystem: this
   * coordinator owns the ORDERING, not the listing store's internals.
   *
   * Returns the rkeys touched plus a `commit` the coordinator runs only after
   * the transaction lands, so no process-local cache can get ahead of the
   * database.
   */
  rebindListings: (args: { installId: string; fromCid: string; toCid: string }) => {
    rebound: string[];
    commit: () => void;
  };
  /**
   * How many orders admitted under a given manifest CID are still open
   * (§9.13). Injected: commerce is a different subsystem, and this coordinator
   * must not reach into the order store. Absent means "cannot tell", which
   * reads as zero — so a node with no commerce runtime can still release a
   * lane it could never have used.
   */
  countOpenOrders?: (servingManifestCid: string) => number;
  /** One transaction over the Tier-0 db. */
  tx: (fn: () => void) => void;
  now: () => number;
  drainMs?: number;
}

/**
 * NESTED-TRANSACTION CAVEAT. The Tier-0 transaction runner is re-entrant, so
 * calling `apply` from inside a larger transaction makes its commit a no-op:
 * the in-memory cache would adopt the rebind while the OUTER transaction could
 * still roll back. Call it as a top-level operation.
 */
export class UpdateRebindCoordinator {
  constructor(private readonly deps: UpdateRebindDeps) {}

  /**
   * Apply an update and rebind, atomically.
   *
   * The install must be ACTIVE. Updating a paused install would create
   * authorizations for work that cannot run and rebind listings that are
   * already answering unavailable — the operator should resume or uninstall,
   * not update sideways.
   */
  apply(args: {
    installId: string;
    cid: string;
    version: string;
    manifest: PluginManifest;
    installScopeHash: string;
    capabilityHashes: Record<string, string>;
    behaviorHash: string;
    presentationHash: string;
    /**
     * §16.5 re-consent: the widenings the OWNER was shown and accepted.
     *
     * A BOOLEAN WOULD BE WORTHLESS HERE. "The owner said yes" says nothing
     * about what they said yes TO, and the whole risk is a wider escalation
     * riding along on a consent given for a narrower one — the owner approves
     * a raised context ceiling, the operator re-prepares, and a new capability
     * that places orders applies under the same yes. So the consent is bound to
     * CONTENT: the findings detected here must match these exactly, or the
     * update is refused as if no consent had been given at all.
     *
     * Absent means no widening was consented to, which is the ordinary case.
     */
    consentedWidening?: readonly WideningFinding[];
  }): RebindOutcome {
    // Resolved ONCE, here, and threaded down: re-resolving inside the
    // transaction would mean two steps of one atomic change could see
    // different stores.
    const installs = this.deps.installs();
    const drains = this.deps.drains();
    if (installs === null || drains === null) {
      // Fail closed: without both stores we could advance a CID and lose the
      // authorizations, which is the worst of the three partial states.
      return { ok: false, refusal: 'stores_unavailable' };
    }
    const install = installs.getById(args.installId);
    if (install === null) return { ok: false, refusal: 'install_unknown' };
    if (install.status !== 'active') {
      return { ok: false, refusal: 'install_not_active', detail: install.status };
    }
    // §16.5 — "an update cannot SILENTLY widen from catalog read to order
    // submission". Checked BEFORE the transaction, because a widening update
    // is not a partial failure to roll back: it is a different agreement, and
    // the owner has not made it. A supplier pack consented to as a price list
    // must not ship a version that also places orders and inherit the
    // consent given to the reader.
    //
    // Refused, never downgraded-and-applied. Applying the narrow part would
    // leave the install running a manifest whose CID the owner's consent does
    // not cover, and content-addressing is the only thing making consent mean
    // anything.
    const widening = detectUpdateWidening(install.manifest, args.manifest);
    if (widening.widens && !consentCovers(widening.findings, args.consentedWidening)) {
      return { ok: false, refusal: 'requires_reconsent', widening: widening.findings };
    }

    if (install.currentCid === args.cid) {
      // Not an error worth failing loudly, but not a no-op either: creating
      // drain authorizations from a CID to itself would authorise the CURRENT
      // contract as if it were prior, which the claim guard would read as a
      // standing exemption.
      return { ok: false, refusal: 'cid_unchanged' };
    }

    // A holder rather than two `let`s: the assignments happen inside the
    // transaction callback, and only a property read survives that boundary
    // with its declared type intact.
    const landed: { outcome: RebindOutcome | null; publish: (() => void) | null } = {
      outcome: null,
      publish: null,
    };
    try {
      this.runInTx(args, install, installs, drains, (result, commit) => {
        landed.outcome = result;
        landed.publish = commit;
      });
    } catch (err) {
      if (!(err instanceof RebindRollback)) throw err;
      // The transaction rolled back, so nothing local adopted the change.
      return { ok: false, refusal: err.refusal };
    }
    // Only now — the rows are durable, so process-local state may adopt them.
    // A rollback leaves `publish` unrun and the cache still describing the
    // pre-update world, which is exactly what the database still holds.
    const { outcome, publish } = landed;
    if (publish !== null) publish();
    // A tx runner that swallowed the callback would leave this null. Refusing
    // is the only safe reading: we cannot report a rebind we never observed.
    return outcome ?? { ok: false, refusal: 'update_cas_lost' };
  }

  private runInTx(
    args: {
      installId: string;
      cid: string;
      version: string;
      manifest: PluginManifest;
      installScopeHash: string;
      capabilityHashes: Record<string, string>;
      behaviorHash: string;
      presentationHash: string;
    },
    install: PluginInstall,
    installs: PluginInstallRepository,
    drains: DrainAuthorizationRepository,
    report: (outcome: RebindOutcome, commit: () => void) => void,
  ): void {
    this.deps.tx(() => {
      // 1. Prior-contract authorizations, built from the manifest the install
      //    is ABOUT to stop running. Readable only before step 2.
      const authorizations = this.authorize(install, drains, args.version);

      // 2. Adopt the new CID, CAS on the one we read.
      const applied = installs.applyUpdate(
        args.installId,
        {
          cid: args.cid,
          version: args.version,
          manifest: args.manifest,
          installScopeHash: args.installScopeHash,
          capabilityHashes: args.capabilityHashes,
          behaviorHash: args.behaviorHash,
          presentationHash: args.presentationHash,
        },
        this.deps.now(),
        { currentCid: install.currentCid },
      );
      if (!applied) {
        // A concurrent update won. Throwing rolls back the authorizations we
        // just wrote — they describe a transition that did not happen.
        throw new RebindRollback('update_cas_lost');
      }

      // 3. Listings follow the install in the same commit.
      const rebind = this.deps.rebindListings({
        installId: args.installId,
        fromCid: install.currentCid,
        toCid: args.cid,
      });

      report({ ok: true, rebound: rebind.rebound, authorizations }, rebind.commit);
    });
  }

  /**
   * Release a capability's lifecycle-continuity authorization once every order
   * the prior manifest served is terminal (§9.13).
   *
   * The count is the WHOLE point. Releasing early strands a buyer mid-order:
   * their next `order_status` gets `lifecycle_continuity_unavailable` for an
   * order the supplier is still obliged to. So this refuses while any order
   * admitted under `previousCid` is still open, and the caller may retry after
   * the next one settles. The `drain` entry expires on its own; this one is
   * only ever released deliberately, and only when it is safe.
   *
   * `countOpenOrders` is injected because commerce is a different subsystem —
   * a plugin coordinator has no business reaching into the order store.
   */
  releaseContinuity(
    installId: string,
    previousCid: string,
    capabilityId: string,
  ): { released: boolean; openOrders: number } {
    const open = this.deps.countOpenOrders?.(previousCid) ?? 0;
    if (open > 0) return { released: false, openOrders: open };
    const released =
      this.deps.drains()?.release(installId, previousCid, capabilityId, 'lifecycle_continuity') ??
      false;
    return { released, openOrders: 0 };
  }

  /**
   * One `drain` + one `lifecycle_continuity` entry per capability of the
   * PRIOR manifest.
   *
   * Both, not one: a drain entry covers tasks already claimed, and a
   * continuity entry admits NEW prior-major lifecycle calls — a buyer asking
   * the status of an order placed before the update. Creating only the drain
   * would answer that buyer `stale_authority` for an order the supplier is
   * still obliged to.
   */
  private authorize(
    install: PluginInstall,
    drains: DrainAuthorizationRepository,
    nextVersion: string,
  ): number {
    // §9.13 DRAWS A LINE THIS CODE DID NOT. It used to create a non-expiring
    // `lifecycle_continuity` row for EVERY capability on EVERY update, while
    // its own comment claimed to be "serving prior-major lifecycle" — without
    // ever asking whether the major had changed.
    //
    // Two different mechanisms were being run as one:
    //
    //   SAME MAJOR is a compatible swap. Tasks already created drain against
    //   their pinned schemas, and anything NEW belongs to the current runtime.
    //   Handing the prior CID open-ended authority here meant continuations
    //   ran under stale code that a compatible release had just replaced.
    //
    //   A MAJOR CHANGE is not compatible, so the old major must keep serving
    //   the orders it took until they are terminal — but only through the
    //   three LIFECYCLE handlers §9.13 names. Retaining quoting or ordering
    //   authority as well would let a superseded major keep taking NEW
    //   business, which is the opposite of draining.
    const majorChanged = protocolMajorOf(install.currentVersion) !== protocolMajorOf(nextVersion);
    const capabilities = install.manifest.capabilities ?? [];
    const now = this.deps.now();
    const drainMs = this.deps.drainMs ?? DEFAULT_DRAIN_MS;
    let created = 0;
    for (const capability of capabilities) {
      const cap = capability as unknown as {
        id: string;
        action_class?: string;
        effects?: { idempotency?: string };
        params_schema?: unknown;
        result_schema?: unknown;
        data_scope?: { max_context_items?: number };
      };
      const base: Omit<DrainAuthorization, 'kind' | 'expiresAt'> = {
        installId: install.installId,
        previousCid: install.currentCid,
        capabilityId: cap.id,
        approvedScopeHash: install.capabilityHashes[cap.id] ?? '',
        configRevision: install.configRevision,
        actionClass: cap.action_class ?? 'read',
        // `cap.effects.idempotency`, the VALIDATED shape. The first version
        // read a top-level `cap.effects_idempotency` that the manifest model
        // has never carried, so every capability declaring `supported` was
        // reauthorized as `unsupported` during an update — and the claim guard
        // terminalizes a task whose envelope disagrees, so work queued before
        // the update died instead of draining. `dispatch.ts` reads the nested
        // field correctly; this was the one place that did not.
        effectsIdempotency: cap.effects?.idempotency === 'supported' ? 'supported' : 'unsupported',
        // The PRIOR schemas travel with the authorization. A drained task is
        // judged against the contract it was created under; reading the
        // current manifest would let an update retroactively change what an
        // in-flight task was allowed to return.
        resultSchemaJson: JSON.stringify(cap.result_schema ?? null),
        paramsSchemaJson: JSON.stringify(cap.params_schema ?? null),
        maxContextItems: cap.data_scope?.max_context_items ?? null,
        // §9.13 — the version this authorization SPEAKS, taken from the
        // manifest the install is about to stop running. Read from the
        // install, never from the update being applied: the whole point of a
        // drain row is that it describes the PRIOR contract.
        priorVersion: install.currentVersion,
        createdAt: now,
      };
      // ALWAYS: the bounded drain, so work created under the prior contract
      // completes against the schemas it was created with.
      if (drains.put({ ...base, kind: 'drain', expiresAt: now + drainMs })) created += 1;
      // ONLY across a major, and only for the lifecycle handlers. No expiry:
      // §9.13 serves the prior major until its orders are terminal, and a
      // deadline would cut a buyer off mid-order.
      if (majorChanged && LIFECYCLE_CAPABILITIES.has(bareCapabilityName(cap.id))) {
        if (drains.put({ ...base, kind: 'lifecycle_continuity', expiresAt: null })) {
          created += 1;
        }
      }
    }
    return created;
  }
}

/** Thrown to roll the transaction back; never escapes `apply`. */
class RebindRollback extends Error {
  constructor(readonly refusal: RebindRefusal) {
    super(`update rebind: ${refusal}`);
    this.name = 'RebindRollback';
  }
}

/**
 * The three handlers §9.13 keeps alive across a MAJOR update: a buyer with an
 * order open under the old major must still be able to ask its status,
 * reconcile it, and cancel it.
 *
 * Quoting and ordering are deliberately absent. A superseded major that could
 * still take new business would not be draining, it would be running.
 */
const LIFECYCLE_CAPABILITIES: ReadonlySet<string> = new Set([
  'order_status',
  'order_reconcile',
  'cancel_order',
]);

/** `MAJOR` of a `MAJOR.MINOR[.PATCH]` version string; the whole string if unparseable. */
function protocolMajorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

/** Bare capability name, tolerating the NSID prefix and manifest hyphens. */
function bareCapabilityName(id: string): string {
  const bare = id.includes('.') ? (id.split('.').pop() ?? id) : id;
  return bare.replace(/-/g, '_');
}
