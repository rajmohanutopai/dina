/**
 * The seam that makes the host-operation lane run (§3.4, WS-3.4).
 *
 * `brokerHostOperation` decides and executes; `parseHostOperationRequest`
 * recognises the ask. Between them sat the gap this module closes: nothing
 * watched a plugin completion, so a runner could send a perfectly-formed
 * proposal and Core would file it as an ordinary result.
 *
 * WHAT §3.4 ASKS FOR, IN ORDER:
 *
 *   "a runner requests an operation only by completing its current claim with
 *    a typed proposal ... Core validates the proposal, records it as a durable
 *    workflow event, performs the brokered read/effect itself, and records the
 *    result event ... the next claim for that workflow delivers the validated
 *    result."
 *
 * So: recognise, broker, and enqueue a FOLLOW-UP task on the same plugin lane
 * carrying the verified result. The runner gets it as its next claim, with all
 * the claim-token and lease discipline that implies.
 *
 * THE FOLLOW-UP IS ENQUEUED EVEN WHEN THE ANSWER IS NO. A refusal that
 * produced no task would leave the runner waiting on something that will never
 * come, and "we said no" is an answer it is owed. The one case with no
 * follow-up is `awaiting_owner`: nothing has happened yet, and the task is
 * enqueued when the owner answers.
 *
 * IT NEVER THROWS INTO THE COMPLETION. The claim's completion has already
 * landed and been CAS-confirmed by the time this runs; a failure here must not
 * unwind it. Everything is reported through `onError` and the completion
 * stands.
 */

import { pluginLane } from '@dina/protocol';

import { buildPluginEnvelope } from './dispatch';
import {
  applyOwnerDecision,
  brokerHostOperation,
  decideExtensionProposal,
  parseHostOperationRequest,
} from './host_operation_lane';

import type { ExtensionOperationBroker, ExtensionProposal } from './extension_broker';
import type { ExtensionOperationRegistry, RegisteredExtensionOperation } from './extension_ops';
import type { HostOperationLaneResult, ProposalDecision } from './host_operation_lane';
import type { HostOperationDispatcher } from './host_operations';
import type { PluginInstall } from './registry';
import type { PluginTaskEnvelope } from '../workflow/plugin_envelope';
import type { PluginCapabilityDecl } from '@dina/protocol';

/** The narrow slice of the workflow store this needs. */
export interface FollowUpTaskCreator {
  create: (args: {
    id: string;
    kind: string;
    description: string;
    payload: string;
    expiresAtSec: number;
    idempotencyKey: string;
    initialState: never;
    requestedRunner: string;
  }) => { id: string };
}

export interface PluginCompletionHandlerDeps {
  broker: () => ExtensionOperationBroker | null;
  dispatcher: () => HostOperationDispatcher | null;
  registry: () => ExtensionOperationRegistry | null;
  installs: () => { getById: (installId: string) => PluginInstall | null } | null;
  workflow: () => FollowUpTaskCreator | null;
  decide: (args: {
    operation: RegisteredExtensionOperation;
    capability: PluginCapabilityDecl;
    install: PluginInstall;
  }) => ProposalDecision;
  now?: () => number;
  /** How long the follow-up task waits to be claimed. Default one hour. */
  followUpTtlSeconds?: number;
  onError?: (err: unknown) => void;
  onOutcome?: (outcome: HostOperationLaneResult) => void;
}

/**
 * What a completed plugin task hands this seam. Only the envelope's own
 * Core-written fields — never anything the runner chose beyond the result body
 * itself.
 */
export interface PluginCompletion {
  envelope: PluginTaskEnvelope;
  resultJSON: string;
}

export type PluginCompletionHandler = (completion: PluginCompletion) => Promise<void>;

const DEFAULT_FOLLOW_UP_TTL_SECONDS = 60 * 60;

/**
 * Build the follow-up envelope carrying a settled proposal.
 *
 * PARAMS ARE THE ORIGINAL CLAIM'S, unchanged. `buildPluginEnvelope` validates
 * params against the consented `params_schema`, and the operation's RESULT is
 * not that shape — putting it there would either fail validation or, worse,
 * force the schema wide enough to accept both. The result rides its own
 * `host_operation` block, which is also what keeps it out of the field the
 * egress gate governs.
 */
export function buildHostOperationFollowUp(args: {
  install: PluginInstall;
  source: PluginTaskEnvelope;
  proposal: ExtensionProposal;
}): PluginTaskEnvelope {
  const { proposal } = args;
  const state =
    proposal.state === 'completed' ||
    proposal.state === 'failed' ||
    proposal.state === 'refused' ||
    proposal.state === 'outcome_unknown'
      ? proposal.state
      : 'outcome_unknown';
  const base = buildPluginEnvelope({
    install: args.install,
    capabilityId: args.source.capability_id,
    params: args.source.params,
    context: args.source.context,
    // A NEW execution: this is the next step of the workflow, not a retry of
    // the claim that just completed. Reusing the old id would collide with
    // the completed task and be deduplicated away.
    executionId: `${args.source.execution_id}:xop:${proposal.proposalId}`,
    idempotencyKey: `${args.source.idempotency_key}:xop:${proposal.proposalId}`,
    ...(args.source.service_ingress !== undefined
      ? { serviceIngress: args.source.service_ingress }
      : {}),
  });
  return {
    ...base,
    host_operation: {
      proposal_id: proposal.proposalId,
      operation_name: proposal.operationName,
      state,
      ...(state === 'completed'
        ? { result: proposal.resultJson === null ? null : safeParse(proposal.resultJson) }
        : { detail: proposal.refusalReason ?? '' }),
    },
  };
}

/** The result column was written by `settle` from a value it had just
 *  verified, so unreadable JSON here is storage corruption. Delivered as null
 *  rather than throwing: the runner still learns the state. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function makePluginCompletionHandler(
  deps: PluginCompletionHandlerDeps,
): PluginCompletionHandler {
  const now = deps.now ?? (() => Date.now());
  const report = (err: unknown): void => {
    deps.onError?.(err);
  };

  return async (completion) => {
    try {
      const request = parseHostOperationRequest(completion.resultJSON);
      // The common case by far: an ordinary completion passes through and this
      // seam is a no-op.
      if (request === null) return;

      const broker = deps.broker();
      const dispatcher = deps.dispatcher();
      const registry = deps.registry();
      const installs = deps.installs();
      if (broker === null || dispatcher === null || registry === null || installs === null) {
        // A node with no host-operation plane cannot broker an effect and must
        // not pretend otherwise. Loud, because a runner is now waiting.
        report(
          new Error('host operations: no plane on this node — the proposal cannot be brokered'),
        );
        return;
      }
      // The install comes from the ENVELOPE, which Core wrote at dispatch —
      // never from the completion body, which the runner wrote.
      const install = installs.getById(completion.envelope.install_id);
      if (install === null) {
        report(new Error(`host operations: install ${completion.envelope.install_id} is gone`));
        return;
      }

      const outcome = await brokerHostOperation({
        install,
        capabilityId: completion.envelope.capability_id,
        request,
        registry,
        broker,
        dispatcher,
        decide: ({ operation, capability }) => deps.decide({ operation, capability, install }),
      });
      deps.onOutcome?.(outcome);

      // Nothing has happened yet and nothing is owed to the runner until the
      // owner answers; `applyOwnerDecision` enqueues the follow-up then.
      //
      // RETAIN THE PROPOSING ENVELOPE FIRST, because parking without it is
      // parking for ever. `settleOwnerDecision` needs this envelope to build
      // the follow-up that carries the verified result back to the runner, and
      // a parked proposal outlives the process that made it — so nothing else
      // can supply it later. Before this, a proposal that carded could not be
      // resolved by anyone: §3.4's brokered lane recorded the question
      // durably and then had no way to act on the answer.
      if (outcome.kind === 'awaiting_owner') {
        broker.retainSource(outcome.proposal.proposalId, JSON.stringify(completion.envelope));
        return;
      }
      if (outcome.kind === 'not_a_proposal') return;
      if (outcome.kind === 'refused') {
        // A refusal Core decided BEFORE a proposal existed (a paused install,
        // an unconsented capability). There is no proposal row to deliver, so
        // the runner learns of it the way it learns of any other dead end:
        // its lane simply has no next task. Reported so an operator can see
        // it, because a silently empty lane is indistinguishable from an idle
        // one.
        report(new Error(`host operations: ${outcome.refusal}: ${outcome.detail}`));
        return;
      }

      enqueueFollowUp({
        install,
        source: completion.envelope,
        proposal: outcome.proposal,
        workflow: deps.workflow(),
        ttlSeconds: deps.followUpTtlSeconds ?? DEFAULT_FOLLOW_UP_TTL_SECONDS,
        nowMs: now(),
        report,
      });
    } catch (err) {
      // The completion has already landed and been CAS-confirmed. A failure
      // here must not unwind it.
      report(err);
    }
  };
}

/**
 * The owner answered a parked proposal: run or refuse it, then deliver the
 * outcome to the runner exactly as the auto-permitted route does.
 *
 * ONE PATH BUILDS THE FOLLOW-UP. If the owner-approved route enqueued its own,
 * the two would drift and a runner would see a different envelope depending on
 * whether a human was involved — which is the one thing that must not be
 * visible to it.
 */
export async function settleOwnerDecision(args: {
  proposalId: string;
  approved: boolean;
  reason?: string;
  /** The envelope of the claim that PROPOSED this, held by the approval card. */
  source: PluginTaskEnvelope;
  install: PluginInstall;
  broker: ExtensionOperationBroker;
  dispatcher: HostOperationDispatcher;
  workflow: FollowUpTaskCreator | null;
  ttlSeconds?: number;
  nowMs?: number;
  report?: (err: unknown) => void;
}): Promise<HostOperationLaneResult> {
  const report = args.report ?? (() => undefined);
  const outcome = await applyOwnerDecision({
    proposalId: args.proposalId,
    approved: args.approved,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
    broker: args.broker,
    dispatcher: args.dispatcher,
  });
  if (outcome.kind !== 'settled') {
    if (outcome.kind === 'refused') report(new Error(`${outcome.refusal}: ${outcome.detail}`));
    return outcome;
  }
  enqueueFollowUp({
    install: args.install,
    source: args.source,
    proposal: outcome.proposal,
    workflow: args.workflow,
    ttlSeconds: args.ttlSeconds ?? DEFAULT_FOLLOW_UP_TTL_SECONDS,
    nowMs: args.nowMs ?? Date.now(),
    report,
  });
  return outcome;
}

/**
 * Enqueue the follow-up. Exported so `settleOwnerDecision` uses the same path
 * — one place builds the follow-up, so the owner-approved route and the
 * auto-permitted route cannot drift.
 */
export function enqueueFollowUp(args: {
  install: PluginInstall;
  source: PluginTaskEnvelope;
  proposal: ExtensionProposal;
  workflow: FollowUpTaskCreator | null;
  ttlSeconds: number;
  nowMs: number;
  report: (err: unknown) => void;
}): void {
  if (args.workflow === null) {
    args.report(
      new Error('host operations: no workflow store — the verified result cannot be delivered'),
    );
    return;
  }
  let envelope: PluginTaskEnvelope;
  try {
    envelope = buildHostOperationFollowUp({
      install: args.install,
      source: args.source,
      proposal: args.proposal,
    });
  } catch (err) {
    args.report(err);
    return;
  }
  try {
    args.workflow.create({
      id: envelope.execution_id,
      kind: 'delegation',
      description: `host operation ${args.proposal.operationName} result for install ${args.install.installId}`,
      payload: JSON.stringify(envelope),
      expiresAtSec: Math.floor(args.nowMs / 1000) + args.ttlSeconds,
      idempotencyKey: envelope.idempotency_key,
      initialState: 'queued' as never,
      // FORCED to this install's own lane. A follow-up carrying a verified
      // result must not be claimable by anything else.
      requestedRunner: pluginLane(args.install.installId),
    });
  } catch (err) {
    // A conflict is the same proposal's follow-up already enqueued — the
    // idempotency the whole lane is built on, not a fault.
    if (err instanceof Error && err.name === 'WorkflowConflictError') return;
    args.report(err);
  }
}

/**
 * The handler both composition roots install, resolved from the globals they
 * both already set.
 *
 * WHY ONE FACTORY. The server plane and the phone's bootstrap each build their
 * own `WorkflowService`; a handler assembled separately at each would drift,
 * and the half that drifted would be the one nobody tested. Everything is read
 * per call from the installed runtime, so a node whose plane is torn down goes
 * quiet rather than writing to a closed database.
 *
 * THE POLICY DEFAULTS ARE THE STRICTEST READING, and that is a decision worth
 * naming. `capabilityKind` defaults to `custom` and `publisherRing` to
 * `unverified`, so nothing above SAFE runs silent: §8's floors then card every
 * write, booking and agentic operation, and a canonical capability from a
 * verified publisher only runs silent once a root injects resolvers that say
 * so. A default that guessed `canonical`/`verified` would hand a runner silent
 * effects on the strength of an assumption.
 */
export function defaultPluginCompletionHandler(deps: {
  hostRuntime: () => {
    broker: ExtensionOperationBroker;
    dispatcher: HostOperationDispatcher;
    registry: ExtensionOperationRegistry;
  } | null;
  installs: () => { getById: (installId: string) => PluginInstall | null } | null;
  workflow: () => FollowUpTaskCreator | null;
  /** Injected by a root that can classify; absent means `custom` (stricter). */
  capabilityKind?: (capability: PluginCapabilityDecl) => 'canonical' | 'custom';
  /** Injected by a root that resolves trust; absent means `unverified`. */
  publisherRing?: (install: PluginInstall) => 'unverified' | 'verified' | 'verified_actioned';
  /** Live standing grant for this operation; absent means none. */
  standingApproval?: (args: {
    install: PluginInstall;
    capability: PluginCapabilityDecl;
    operationName: string;
  }) => boolean;
  /** Prior invocations, for §8's first-N rule; absent means zero (stricter). */
  priorInvocations?: (args: { install: PluginInstall; capability: PluginCapabilityDecl }) => number;
  now?: () => number;
  followUpTtlSeconds?: number;
  onError?: (err: unknown) => void;
  onOutcome?: (outcome: HostOperationLaneResult) => void;
}): PluginCompletionHandler {
  return makePluginCompletionHandler({
    broker: () => deps.hostRuntime()?.broker ?? null,
    dispatcher: () => deps.hostRuntime()?.dispatcher ?? null,
    registry: () => deps.hostRuntime()?.registry ?? null,
    installs: deps.installs,
    workflow: deps.workflow,
    decide: ({ operation, capability, install }) =>
      decideExtensionProposal({
        operation,
        capability,
        capabilityKind: deps.capabilityKind?.(capability) ?? 'custom',
        publisherRing: deps.publisherRing?.(install) ?? 'unverified',
        // A host operation carries no persona projection: its params are the
        // runner's own and its context is the claim's, already scope-checked
        // at dispatch. These stay false because there is nothing here to
        // widen them from, not because personas are assumed safe.
        touchesSensitivePersona: false,
        touchesLockedPersona: false,
        priorInvocations: deps.priorInvocations?.({ install, capability }) ?? 0,
        hasStandingApproval:
          deps.standingApproval?.({
            install,
            capability,
            operationName: operation.operationName,
          }) ?? false,
      }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.followUpTtlSeconds === undefined
      ? {}
      : { followUpTtlSeconds: deps.followUpTtlSeconds }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    ...(deps.onOutcome === undefined ? {} : { onOutcome: deps.onOutcome }),
  });
}
