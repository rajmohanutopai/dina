/**
 * Typed host operations (§3.4 / FR-P9, WS-3.5).
 *
 * The broker records what a runner ASKED for. This module is what actually
 * happens, and the rule it exists to enforce is one sentence: the runner
 * supplies the PARAMS, Dina supplies the AUTHORITY. A runner never holds a
 * credential, a DID, a session, or a key; it names a registered operation and
 * Core performs it under Core's own identity.
 *
 * That is why an executor's signature gives it the validated params and
 * nothing else identity-shaped. Anything an executor needs in order to ACT —
 * an AppView client, a D2D sender, the node's own DID — is closed over at
 * composition time by the boot that owns those things. A runner cannot reach
 * them by putting them in a payload, because there is no field for them.
 *
 * WHY A THROW MEANS `outcome_unknown`. An executor that throws mid-effect
 * cannot tell Core whether the effect happened: a socket can die after the
 * bytes left. Treating that as `failed` would invite a retry that sends
 * twice. So an escaping exception settles as `outcome_unknown`, which is
 * terminal and forbids retry, and executors are expected to catch the
 * failures they can actually characterise and return `failed` themselves.
 * The asymmetry is deliberate: a false "unknown" costs an operator a manual
 * check, a false "failed" costs a duplicate effect.
 */

import { ExtensionOperationBroker } from './extension_broker';

import type { ExtensionProposal } from './extension_broker';
import type { ExtensionOperationRegistry } from './extension_ops';
import type { DatabaseAdapter } from '../storage/db_adapter';

/**
 * What an executor may see. Deliberately narrow: the params the broker
 * already validated, and the identity of the install that asked — for audit
 * and for scoping, never as authority the runner supplied.
 */
export interface HostOperationContext {
  readonly proposalId: string;
  readonly installId: string;
  readonly capabilityId: string;
  readonly operationName: string;
  /** Parsed from the proposal's recorded params. Already schema-checked. */
  readonly params: unknown;
}

export type HostOperationOutcome =
  | { kind: 'completed'; result: unknown }
  | { kind: 'failed'; error: string }
  | { kind: 'outcome_unknown'; detail: string };

export type HostOperationExecutor = (ctx: HostOperationContext) => Promise<HostOperationOutcome>;

export type DispatchRefusal =
  | 'proposal_unknown'
  | 'not_permitted'
  | 'no_executor'
  | 'params_unreadable';

export type DispatchResult =
  | { ok: true; state: 'completed' | 'failed' | 'outcome_unknown' }
  | { ok: false; refusal: DispatchRefusal; detail?: string };

export interface HostOperationDispatcherDeps {
  broker: ExtensionOperationBroker;
  /**
   * Result schema for an operation, read at SETTLE time from the same pinned
   * digest the proposal recorded. Supplied by the composition root, which
   * owns the registry.
   */
  resultSchemaFor: (operationName: string) => unknown;
}

/**
 * Drives a permitted proposal through execution.
 *
 * Executors are registered by operation name, by the boot that can build them.
 * An operation with no executor on this node is a REFUSAL, not a crash: a
 * manifest may legitimately declare an operation a given node does not ship.
 */
export class HostOperationDispatcher {
  private readonly executors = new Map<string, HostOperationExecutor>();

  constructor(private readonly deps: HostOperationDispatcherDeps) {}

  register(operationName: string, executor: HostOperationExecutor): void {
    if (this.executors.has(operationName)) {
      throw new Error(
        `host operations: "${operationName}" already has an executor — two adapters cannot claim one operation (§3.4)`,
      );
    }
    this.executors.set(operationName, executor);
  }

  has(operationName: string): boolean {
    return this.executors.has(operationName);
  }

  /**
   * Execute a PERMITTED proposal and record its outcome.
   *
   * The order is fixed and each step is durable before the next begins:
   * claim `executing` (so a crash is discoverable), run the effect, settle.
   * Claiming first is what makes a crash mid-effect a question rather than a
   * silence.
   */
  async run(proposalId: string): Promise<DispatchResult> {
    const proposal = this.deps.broker.get(proposalId);
    if (proposal === null) return { ok: false, refusal: 'proposal_unknown' };
    // Layered with the broker's own `permitted` CAS in `beginExecution`, and
    // the pair is load-bearing: defeating either alone leaves the other
    // refusing, defeating both lets an unpermitted proposal execute. This one
    // reports WHICH state blocked it and avoids parsing params for a proposal
    // that cannot run; the CAS is what makes two concurrent dispatchers
    // resolve to one winner.
    if (proposal.state !== 'permitted') {
      return { ok: false, refusal: 'not_permitted', detail: `state is ${proposal.state}` };
    }
    const executor = this.executors.get(proposal.operationName);
    if (executor === undefined) {
      return {
        ok: false,
        refusal: 'no_executor',
        detail: `this node ships no executor for "${proposal.operationName}"`,
      };
    }

    let params: unknown;
    try {
      params = JSON.parse(proposal.paramsJson);
    } catch (err) {
      // The row was written by `propose` from a value it had just validated,
      // so unreadable params here mean storage corruption, not a bad runner.
      // Refuse without claiming `executing`: nothing was attempted.
      return {
        ok: false,
        refusal: 'params_unreadable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const claimed = this.deps.broker.beginExecution(proposalId);
    if (!claimed.ok) {
      // Lost the claim to a concurrent dispatcher. Ordinary, not corruption.
      return { ok: false, refusal: 'not_permitted', detail: claimed.refusal };
    }

    const outcome = await this.execute(executor, proposal, params);
    if (outcome.kind === 'completed') {
      const settled = this.deps.broker.settle(proposalId, {
        kind: 'completed',
        result: outcome.result,
        resultSchema: this.deps.resultSchemaFor(proposal.operationName),
      });
      // A result that fails its pinned schema is recorded `failed` by the
      // broker; report what actually landed rather than what we hoped.
      return { ok: true, state: settled.ok ? 'completed' : 'failed' };
    }
    if (outcome.kind === 'failed') {
      this.deps.broker.settle(proposalId, { kind: 'failed', error: outcome.error });
      return { ok: true, state: 'failed' };
    }
    this.deps.broker.settle(proposalId, { kind: 'outcome_unknown', detail: outcome.detail });
    return { ok: true, state: 'outcome_unknown' };
  }

  private async execute(
    executor: HostOperationExecutor,
    proposal: ExtensionProposal,
    params: unknown,
  ): Promise<HostOperationOutcome> {
    try {
      return await executor({
        proposalId: proposal.proposalId,
        installId: proposal.installId,
        capabilityId: proposal.capabilityId,
        operationName: proposal.operationName,
        params,
      });
    } catch (err) {
      // See the module docstring: a throw cannot distinguish "never
      // happened" from "happened and the wire died", so it settles as
      // unknown. An executor that CAN tell returns `failed` itself.
      return {
        kind: 'outcome_unknown',
        detail: `executor threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/**
 * The first concrete typed operation: a BOUNDED AppView search (§3.4 FR-P9).
 *
 * "Bounded" is the security property, not a performance note. An unbounded
 * search lets a runner page the whole index through a channel the owner
 * approved for one lookup, so the cap is applied HERE, in Core, after the
 * search returns — never passed to the caller as a limit it may choose to
 * respect.
 */
export function makeBoundedAppViewSearch(deps: {
  search: (query: string) => Promise<readonly unknown[]>;
  maxResults: number;
}): HostOperationExecutor {
  return async (ctx) => {
    const params = ctx.params;
    const query =
      params !== null && typeof params === 'object'
        ? (params as { query?: unknown }).query
        : undefined;
    if (typeof query !== 'string' || query === '') {
      // A schema-valid proposal cannot reach here, so this is defence at the
      // boundary rather than the primary check. Characterised, so it is
      // `failed` and retryable rather than an unknown.
      return { kind: 'failed', error: 'appview_search: params.query must be a non-empty string' };
    }
    const hits = await deps.search(query);
    return {
      kind: 'completed',
      // Truncated by Core. A runner cannot widen this by asking for more,
      // because the request carries no limit at all.
      result: { hits: hits.slice(0, deps.maxResults), truncated: hits.length > deps.maxResults },
    };
  };
}

// ---------------------------------------------------------------------------
// Composition (WS-3.5)
// ---------------------------------------------------------------------------

/**
 * The §3.4 host-operation plane as one installed object.
 *
 * Composed HERE rather than at each boot for the reason this codebase has
 * relearned repeatedly: an option every composition root must remember to
 * pass is an option one of them forgets, and the result is a subsystem that
 * validates, publishes, and then refuses on the node where the line is
 * missing. Both boots call one function.
 */
export interface PluginHostRuntime {
  broker: ExtensionOperationBroker;
  dispatcher: HostOperationDispatcher;
  registry: ExtensionOperationRegistry;
}

let hostRuntime: PluginHostRuntime | null = null;

export function createPluginHostRuntime(deps: {
  db: DatabaseAdapter;
  registry: ExtensionOperationRegistry;
  now?: () => number;
  /** Injected so Core carries no schema library (see the broker's deps). */
  validate?: (value: unknown, schema: unknown) => string | null;
}): PluginHostRuntime {
  const now = deps.now ?? (() => Date.now());
  const broker = new ExtensionOperationBroker({
    db: deps.db,
    now,
    ...(deps.validate === undefined ? {} : { validate: deps.validate }),
  });
  const dispatcher = new HostOperationDispatcher({
    broker,
    // Read from the registry at settle time, resolved through the digest the
    // proposal pinned — the broker compares against what it was given, so a
    // registry that has since changed cannot retroactively widen a result.
    resultSchemaFor: (name) => deps.registry.get(name)?.resultSchema,
  });
  return { broker, dispatcher, registry: deps.registry };
}

/** Install at boot; pass null on shutdown. */
export function installPluginHostRuntime(value: PluginHostRuntime | null): void {
  hostRuntime = value;
}

/** Null until composed. Callers must fail closed — a node with no host-op
 *  plane cannot broker an effect, and must not pretend otherwise. */
export function getPluginHostRuntime(): PluginHostRuntime | null {
  return hostRuntime;
}
