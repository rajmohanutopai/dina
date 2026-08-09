/**
 * How a runner asks for a host operation (§3.4, WS-3.4).
 *
 * The spec is explicit about the shape, and it rules out the obvious design:
 *
 *   "a runner requests an operation only by completing its current claim with
 *    a typed proposal naming a registered operation; the request rides the
 *    existing plugin task envelope and claim-token discipline — THERE IS NO
 *    SEPARATE IN-PROCESS CALLBACK SURFACE."
 *
 * So there is no `POST /v1/plugins/host-operations`. A route would be a second
 * way into the same authority with none of the claim-token, idempotency,
 * cancellation or lease discipline the task lane already enforces — and a
 * runner that had one could ask for effects outside any claim it holds.
 *
 * The lane is therefore: the runner COMPLETES its claim with a proposal, Core
 * recognises it here, brokers it, and the verified result reaches the runner
 * as its NEXT task. Four things follow from that and each is a rule below.
 *
 * WHAT THE RUNNER SUPPLIES AND WHAT IT DOES NOT. It names an operation and
 * gives params. It does not name the install (that comes from the claim it
 * held), the capability's consented scope (that comes from the pinned
 * manifest), or the decision (that is Dina's). A runner that could name any of
 * those would be choosing its own authority through a payload.
 *
 * THE DECISION IS THE EXISTING ACTION PLANE, NOT A NEW ONE. §3.4: "an
 * effectful operation routes through the canonical action plane exactly like
 * any other plugin effect: authority-domain evaluation, approval or
 * standing-grant check ... and the deny-by-default safety floor." So the
 * permit decision runs `evaluatePluginIntent` over the operation's
 * `action_class` — the same table, the same floors, the same first-N rule that
 * govern every other plugin effect. Inventing a second policy here would give
 * the owner two consent surfaces that disagree.
 */

import { evaluatePluginIntent } from '../gatekeeper/intent';

import type { ExtensionOperationBroker, ExtensionProposal } from './extension_broker';
import type { ExtensionOperationRegistry, RegisteredExtensionOperation } from './extension_ops';
import type { HostOperationDispatcher } from './host_operations';
import type { PluginInstall } from './registry';
import type { PluginPublisherRing } from '../gatekeeper/intent';
import type { PluginCapabilityDecl } from '@dina/protocol';

/** The marker a runner puts on a completion to make it a proposal. */
export const HOST_OPERATION_PROPOSAL_KIND = 'host_operation_proposal';

/** What the runner asked for. Nothing identity-shaped: see the module note. */
export interface HostOperationRequest {
  operationName: string;
  params: unknown;
  idempotencyKey: string;
}

/**
 * Recognise a completion that is asking for a host operation.
 *
 * Returns null for everything else, and "everything else" is the common case:
 * an ordinary completion must pass through untouched. Unparseable JSON is
 * also null rather than an error — a runner's malformed result is the
 * completion path's problem, not this one's.
 */
export function parseHostOperationRequest(resultJSON: string): HostOperationRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(resultJSON);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== HOST_OPERATION_PROPOSAL_KIND) return null;
  if (typeof v.operation_name !== 'string' || v.operation_name === '') return null;
  if (typeof v.idempotency_key !== 'string' || v.idempotency_key === '') return null;
  // A runner naming its own install would be choosing whose authority to
  // spend. REFUSED by returning null rather than ignored: a proposal that
  // silently dropped the field would leave the runner believing it chose.
  if (v.install_id !== undefined) return null;
  return {
    operationName: v.operation_name,
    params: v.params ?? null,
    idempotencyKey: v.idempotency_key,
  };
}

/**
 * The consented capability, from the PINNED manifest and the install's own
 * consent record — never from anything the runner sent.
 *
 * BOTH checks matter and they are different. `manifest.capabilities` says the
 * capability exists in the release the owner installed; `capabilityHashes`
 * says the owner actually consented to THIS capability's scope. A manifest
 * capability with no consented hash is one the owner declined or has not yet
 * seen, and treating the manifest alone as authority would let it run.
 */
export function consentedCapability(
  install: PluginInstall,
  capabilityId: string,
): PluginCapabilityDecl | null {
  const declared = install.manifest.capabilities.find((c) => c.id === capabilityId);
  if (declared === undefined) return null;
  if (install.capabilityHashes[capabilityId] === undefined) return null;
  return declared;
}

export type ProposalDecision =
  | { kind: 'permit' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'approval'; reason: string };

/**
 * Should this proposal run, be refused, or wait for the owner?
 *
 * Delegates to `evaluatePluginIntent`, the deterministic table every other
 * plugin effect goes through: `payment` is BLOCKED at every ring, `write` /
 * `booking` / `agentic` floor at HIGH and card, `read` / `quote` may run
 * silent, and anything the table does not know falls to MODERATE. No LLM, no
 * second opinion, no per-operation special case.
 */
export function decideExtensionProposal(args: {
  operation: RegisteredExtensionOperation;
  capability: PluginCapabilityDecl;
  capabilityKind: 'canonical' | 'custom';
  publisherRing: PluginPublisherRing;
  touchesSensitivePersona: boolean;
  touchesLockedPersona: boolean;
  priorInvocations: number;
  hasStandingApproval: boolean;
}): ProposalDecision {
  const decision = evaluatePluginIntent({
    actionClass: args.operation.actionClass,
    capabilityId: args.capability.id,
    capabilityKind: args.capabilityKind,
    publisherRing: args.publisherRing,
    touchesSensitivePersona: args.touchesSensitivePersona,
    touchesLockedPersona: args.touchesLockedPersona,
    priorInvocations: args.priorInvocations,
    hasStandingApproval: args.hasStandingApproval,
    ...(args.capability.privacy_class !== undefined
      ? { privacyClass: args.capability.privacy_class }
      : {}),
  });
  if (!decision.allowed || decision.mode === 'blocked') {
    return { kind: 'refuse', reason: decision.reason };
  }
  // `card` means an owner decides. The proposal stays `proposed` and durable,
  // which is precisely what makes an approval card answerable later — there is
  // a row to permit.
  if (decision.mode === 'card') return { kind: 'approval', reason: decision.reason };
  return { kind: 'permit' };
}

export type LaneRefusal =
  | 'not_a_proposal'
  | 'install_not_active'
  | 'capability_not_consented'
  | 'no_host_runtime'
  | 'proposal_refused'
  | 'dispatch_failed';

export type HostOperationLaneResult =
  | { kind: 'not_a_proposal' }
  /** Brokered and settled. The proposal carries the verified result. */
  | { kind: 'settled'; proposal: ExtensionProposal }
  /** Recorded and waiting for the owner. Nothing has happened yet. */
  | { kind: 'awaiting_owner'; proposal: ExtensionProposal; reason: string }
  | { kind: 'refused'; refusal: LaneRefusal; detail: string };

/**
 * The whole lane, from a runner's completion to a settled proposal.
 *
 * ORDERING IS THE SAFETY PROPERTY, as everywhere else in this substrate:
 * record the proposal durably, decide, and only then act. A crash after any
 * step leaves a row that says what stage it reached.
 */
export async function brokerHostOperation(args: {
  install: PluginInstall;
  /** The capability the completed claim was dispatched under. */
  capabilityId: string;
  request: HostOperationRequest;
  registry: ExtensionOperationRegistry;
  broker: ExtensionOperationBroker;
  dispatcher: HostOperationDispatcher;
  decide: (args: {
    operation: RegisteredExtensionOperation;
    capability: PluginCapabilityDecl;
  }) => ProposalDecision;
}): Promise<HostOperationLaneResult> {
  // A PAUSED or REVOKED install must not broker an effect, even for a claim it
  // held while active. The claim guard gates claiming; this gates acting, and
  // the window between them is exactly a pause (§14).
  if (args.install.status !== 'active') {
    return {
      kind: 'refused',
      refusal: 'install_not_active',
      detail: `install ${args.install.installId} is ${args.install.status}`,
    };
  }

  const capability = consentedCapability(args.install, args.capabilityId);
  if (capability === null) {
    return {
      kind: 'refused',
      refusal: 'capability_not_consented',
      detail: `capability "${args.capabilityId}" is not a consented capability of this install`,
    };
  }

  const proposed = args.broker.propose({
    installId: args.install.installId,
    capability,
    operationName: args.request.operationName,
    params: args.request.params,
    idempotencyKey: args.request.idempotencyKey,
    registry: args.registry,
  });
  if (!proposed.ok) {
    return {
      kind: 'refused',
      refusal: 'proposal_refused',
      detail: `${proposed.refusal}${proposed.detail === undefined ? '' : `: ${proposed.detail}`}`,
    };
  }
  const proposal = proposed.value;

  // A retry of the same idempotency key returns the SAME row in whatever state
  // it reached. Re-deciding a settled proposal would let a runner that lost a
  // response spend a second permit for one asked-for effect.
  if (proposal.state !== 'proposed') {
    return proposal.state === 'permitted' || proposal.state === 'executing'
      ? { kind: 'awaiting_owner', proposal, reason: `already ${proposal.state}` }
      : { kind: 'settled', proposal };
  }

  const operation = args.registry.get(args.request.operationName);
  if (operation === undefined) {
    // `propose` already refused an unregistered operation, so reaching here
    // means the registry changed underneath us. Refuse rather than guess.
    return {
      kind: 'refused',
      refusal: 'proposal_refused',
      detail: `operation "${args.request.operationName}" left the registry mid-decision`,
    };
  }

  const decision = args.decide({ operation, capability });
  if (decision.kind === 'refuse') {
    // RECORDED, not dropped. "We said no" is an answer the runner is owed and
    // an auditor needs.
    args.broker.refuseProposal(proposal.proposalId, decision.reason);
    const refused = args.broker.get(proposal.proposalId);
    return refused === null
      ? { kind: 'refused', refusal: 'proposal_refused', detail: decision.reason }
      : { kind: 'settled', proposal: refused };
  }
  if (decision.kind === 'approval') {
    return { kind: 'awaiting_owner', proposal, reason: decision.reason };
  }

  const permitted = args.broker.permit(proposal.proposalId);
  if (!permitted.ok) {
    return {
      kind: 'refused',
      refusal: 'proposal_refused',
      detail: `permit lost the CAS: ${permitted.refusal}`,
    };
  }
  const run = await args.dispatcher.run(proposal.proposalId);
  if (!run.ok) {
    return {
      kind: 'refused',
      refusal: 'dispatch_failed',
      detail: `${run.refusal}${run.detail === undefined ? '' : `: ${run.detail}`}`,
    };
  }
  const settled = args.broker.get(proposal.proposalId);
  return settled === null
    ? { kind: 'refused', refusal: 'dispatch_failed', detail: 'proposal vanished after dispatch' }
    : { kind: 'settled', proposal: settled };
}

/**
 * The owner's answer to an approval card, applied to a parked proposal.
 *
 * This IS the "owner-facing permit surface" §3.4 asks for, and it deliberately
 * is not a new endpoint: the owner already answers plugin effects through the
 * approval inbox, and a second surface would be a second place to say yes with
 * its own rules. Approving runs the effect; denying records the refusal.
 */
export async function applyOwnerDecision(args: {
  proposalId: string;
  approved: boolean;
  /** Why, when denied. Recorded so the runner and an auditor both see it. */
  reason?: string;
  broker: ExtensionOperationBroker;
  dispatcher: HostOperationDispatcher;
}): Promise<HostOperationLaneResult> {
  const existing = args.broker.get(args.proposalId);
  if (existing === null) {
    return { kind: 'refused', refusal: 'proposal_refused', detail: 'no such proposal' };
  }
  if (!args.approved) {
    const refused = args.broker.refuseProposal(
      args.proposalId,
      args.reason ?? 'the owner declined this operation',
    );
    if (!refused.ok) {
      return { kind: 'refused', refusal: 'proposal_refused', detail: refused.refusal };
    }
    const row = args.broker.get(args.proposalId);
    return row === null
      ? { kind: 'refused', refusal: 'proposal_refused', detail: 'proposal vanished' }
      : { kind: 'settled', proposal: row };
  }
  const permitted = args.broker.permit(args.proposalId);
  if (!permitted.ok) {
    // The CAS is what stops a double tap on the card from running the effect
    // twice: only the first transition out of `proposed` lands.
    return {
      kind: 'refused',
      refusal: 'proposal_refused',
      detail: `permit lost the CAS: ${permitted.refusal}`,
    };
  }
  const run = await args.dispatcher.run(args.proposalId);
  if (!run.ok) {
    return {
      kind: 'refused',
      refusal: 'dispatch_failed',
      detail: `${run.refusal}${run.detail === undefined ? '' : `: ${run.detail}`}`,
    };
  }
  const settled = args.broker.get(args.proposalId);
  return settled === null
    ? { kind: 'refused', refusal: 'dispatch_failed', detail: 'proposal vanished after dispatch' }
    : { kind: 'settled', proposal: settled };
}
