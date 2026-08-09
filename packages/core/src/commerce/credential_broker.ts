/**
 * The Core-owned credential broker (§8.3, FR-P4 — WS-9.3).
 *
 * The spec states the rule twice, from both directions:
 *
 *   "ERP tokens, database credentials, spreadsheet credentials, signing
 *    material, and supplier API secrets must use a Core-owned credential or
 *    secret broker. They never appear in manifest config, logs, workflow
 *    payloads, or AppView records."
 *
 *   "A generic secret read API is forbidden."
 *
 * THOSE TWO SENTENCES DESIGN THIS MODULE. If a runner could ask "give me the
 * ERP token", every other control is decoration: the secret would then be in a
 * runner's memory, its logs, and whatever it sends next. So there is no read
 * API here. A caller does not GET a credential — it asks the broker to PERFORM
 * an operation, and the broker is the only thing that ever sees the material.
 *
 * THE STORE IS THE ONE AUTHORITY, for both the material and the permission.
 * An earlier shape took the grants as a constructor array; that made a revoked
 * credential keep working until the process restarted, because the array was a
 * snapshot of policy taken at boot. Grants are read from the store on every
 * call, so `forget()` stops the next one.
 *
 * THE LEASE IS THE FALLBACK, NOT THE PATH. §8.3 permits a narrowly scoped
 * lease when an external connector genuinely cannot work through a typed
 * operation, and binds it to tenant, install, resource, operation and expiry.
 * That is five bindings, all required, because a lease missing any one of them
 * is a generic secret read wearing a scope.
 *
 * WHAT THIS FILE NEVER DOES. It does not log a secret, return one from any
 * exported function, or put one in an error message. The boundary test asserts
 * the first two over the source, because a rule about secrets that lives only
 * in review is a rule that lasts until the next hurry.
 */

/**
 * Everything a caller may learn about a credential.
 *
 * Note what is NOT here: the material, its length, its prefix, its hash. Each
 * of those narrows a guess, and none of them help an owner decide anything.
 */
export interface CredentialStatus {
  resource: string;
  /** The install allowed to use it. One credential, one tenant of it. */
  installId: string;
  /** The operations it may be used for. A credential exists for a purpose. */
  operations: string[];
  /** When the owner last replaced the material. Drives the §18.3 rotation UX. */
  rotatedAtMs: number;
  /**
   * Whether the last brokered call using it worked.
   *
   * DERIVED, never typed by an owner. §18.3 asks for "credential status", and
   * a status somebody typed is a claim about the past that stopped being true
   * the moment the supplier rotated their end.
   */
  lastResult: 'ok' | 'failed' | 'never_used';
  lastCheckedAtMs: number | null;
}

/** Read side. The broker holds this; no route ever does. */
export interface CredentialStore {
  /**
   * Run `fn` with the material, for the broker's OWN use.
   *
   * Named `use` rather than `get` because the value must not outlive the call.
   * Deliberately not reachable through any broker method or route.
   */
  useSecret<T>(resource: string, fn: (secret: string) => Promise<T>): Promise<T>;
  /** Null when there is no such resource. Never carries material. */
  describe(resource: string): CredentialStatus | null;
  /** Every configured credential, status only. */
  list(): CredentialStatus[];
  /** Records whether a brokered call worked, so `lastResult` stays derived. */
  recordResult(resource: string, ok: boolean, nowMs: number): void;
}

/** What a caller may ask for: a typed operation, never a secret. */
export interface BrokeredOperation {
  installId: string;
  /** The named credential, e.g. `erp.primary`. Never the credential itself. */
  resource: string;
  /** The operation the manifest declared, e.g. `submit_purchase_order`. */
  operation: string;
  /** Operation input. Checked for credential-shaped values before it is used. */
  params: unknown;
}

/**
 * What the broker does with the secret. Supplied by the composition root, one
 * per `resource:operation` — where a real ERP or REST call lives.
 */
export type BrokeredExecutor = (args: {
  secret: string;
  params: unknown;
}) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;

export type CredentialRefusal =
  | 'no_such_resource'
  | 'operation_not_declared'
  | 'install_not_permitted'
  | 'params_carry_credential'
  | 'no_executor'
  | 'operation_failed'
  | 'lease_expired'
  | 'lease_scope_mismatch';

export type CredentialBrokerResult =
  | { ok: true; result: unknown }
  | { ok: false; refusal: CredentialRefusal; error: string };

/**
 * Values shaped like a credential, which must never travel in `params`.
 *
 * A caller passing a token through `params` would defeat the whole design: the
 * secret would then be in a workflow payload, which §8.3 names explicitly. The
 * check is on the SHAPE because the broker cannot know what a given ERP's
 * tokens look like — known prefixes and PEM headers are what a token scanner
 * uses, and this is the same defence one layer earlier.
 */
const CREDENTIAL_SHAPED = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Field names that mean a secret was put where a value belongs. */
const CREDENTIAL_KEYS = /^(api[_-]?key|secret|token|password|passphrase|private[_-]?key)$/i;

/**
 * Does this operation input carry credential material?
 *
 * Both halves matter and neither subsumes the other: a KEY named `api_key`
 * catches the well-meaning caller who passes their token in a sensibly named
 * field, and a VALUE shaped like a token catches the one who calls it `note`.
 */
export function paramsCarryCredential(params: unknown): boolean {
  if (params === null || typeof params !== 'object') {
    return typeof params === 'string' && CREDENTIAL_SHAPED.some((re) => re.test(params));
  }
  if (Array.isArray(params)) return params.some(paramsCarryCredential);
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.test(key)) return true;
    if (paramsCarryCredential(value)) return true;
  }
  return false;
}

export class CredentialBroker {
  constructor(
    private readonly deps: {
      store: CredentialStore;
      /**
       * `${resource}:${operation}` → executor, read per request.
       *
       * A THUNK rather than a table, because an owner may configure a
       * connector after boot. A table captured at construction would answer
       * `no_executor` forever for anything added later.
       */
      executors: () => Record<string, BrokeredExecutor>;
      now?: () => number;
    },
  ) {}

  /**
   * Perform an operation. The only way a caller reaches a credential's power,
   * and it never reaches the credential.
   *
   * ORDER OF CHECKS. Authorization is settled before the store is opened, so a
   * refused call never causes the material to be read at all — on a platform
   * where reading it may prompt a keychain, that difference is visible to the
   * owner.
   */
  async perform(request: BrokeredOperation): Promise<CredentialBrokerResult> {
    const status = this.deps.store.describe(request.resource);
    if (status === null) {
      return {
        ok: false,
        refusal: 'no_such_resource',
        error: `no credential is configured for ${request.resource}`,
      };
    }
    if (status.installId !== request.installId) {
      return {
        ok: false,
        refusal: 'install_not_permitted',
        error: `install ${request.installId} may not use ${request.resource}`,
      };
    }
    if (!status.operations.includes(request.operation)) {
      return {
        ok: false,
        refusal: 'operation_not_declared',
        error: `${request.operation} is not among the operations granted on ${request.resource}`,
      };
    }
    if (paramsCarryCredential(request.params)) {
      // REFUSED rather than stripped. A caller that put a token in params has a
      // bug, and quietly removing it would leave that bug shipping secrets
      // everywhere else it also passes them.
      return {
        ok: false,
        refusal: 'params_carry_credential',
        error: 'operation params carry credential-shaped material',
      };
    }

    const executor = this.deps.executors()[`${request.resource}:${request.operation}`];
    if (executor === undefined) {
      // A DIFFERENT refusal from `operation_not_declared`, though an owner sees
      // both as "it did not run". The grant says the owner permitted this; the
      // missing executor says this build cannot do it. Collapsing them would
      // send an owner to the settings screen to fix a wiring fault.
      return {
        ok: false,
        refusal: 'no_executor',
        error: `no executor is registered for ${request.resource}:${request.operation}`,
      };
    }

    const now = this.deps.now ?? ((): number => Date.now());
    return this.deps.store.useSecret(request.resource, async (secret) => {
      let outcome: Awaited<ReturnType<BrokeredExecutor>>;
      try {
        outcome = await executor({ secret, params: request.params });
      } catch (error) {
        // A THROW IS A FAILURE, not a crash of the caller. An executor that
        // throws has told us nothing about the credential's validity either
        // way, so it is recorded as a failure — the reading that makes an
        // owner look, rather than the one that stays quiet.
        this.deps.store.recordResult(request.resource, false, now());
        return {
          ok: false as const,
          refusal: 'operation_failed' as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.deps.store.recordResult(request.resource, outcome.ok, now());
      return outcome.ok
        ? { ok: true as const, result: outcome.result }
        : {
            ok: false as const,
            refusal: 'operation_failed' as const,
            // The executor's own message. Executors are composition-root code
            // that knows not to quote the secret; what THIS file guarantees is
            // that it never adds one.
            error: outcome.error,
          };
    });
  }

  /** §18.3 — what an owner may see about their credentials. Status only. */
  statuses(): CredentialStatus[] {
    return this.deps.store.list();
  }
}

/**
 * A narrowly scoped lease, for the connector that genuinely cannot work
 * through a typed operation (§8.3).
 *
 * All five bindings are REQUIRED. A lease missing any one of them is a generic
 * secret read wearing a scope, and §8.3 forbids the former in the same sentence
 * that permits the latter.
 */
export interface CredentialLease {
  tenantId: string;
  installId: string;
  resource: string;
  operation: string;
  expiresAtMs: number;
  /** The owner consent that authorized this exact scope. */
  consentId: string;
}

export type LeaseVerdict = { ok: true } | { ok: false; refusal: CredentialRefusal; error: string };

/**
 * May this lease be redeemed for this request, right now?
 *
 * Every binding is compared, and an empty consent is refused: a lease nobody
 * consented to is the thing the lease shape exists to make impossible. A lease
 * checked on four of five bindings is a lease that works for a fifth thing the
 * owner never saw.
 */
export function redeemLease(args: {
  lease: CredentialLease;
  request: BrokeredOperation & { tenantId: string };
  nowMs: number;
}): LeaseVerdict {
  if (args.lease.consentId === '') {
    return {
      ok: false,
      refusal: 'lease_scope_mismatch',
      error: 'this lease records no owner consent',
    };
  }
  if (args.lease.expiresAtMs <= args.nowMs) {
    return { ok: false, refusal: 'lease_expired', error: 'this lease has expired' };
  }
  const mismatches: string[] = [];
  if (args.lease.tenantId !== args.request.tenantId) mismatches.push('tenant');
  if (args.lease.installId !== args.request.installId) mismatches.push('install');
  if (args.lease.resource !== args.request.resource) mismatches.push('resource');
  if (args.lease.operation !== args.request.operation) mismatches.push('operation');
  if (mismatches.length > 0) {
    return {
      ok: false,
      refusal: 'lease_scope_mismatch',
      error: `lease does not cover this request: ${mismatches.join(', ')}`,
    };
  }
  return { ok: true };
}
