/**
 * §3.4 — the OWNER's surface for brokered host operations.
 *
 * WHAT WAS MISSING, and why it made the whole lane inert. A runner's proposal
 * that the gatekeeper cards parks in state `proposed` and waits for a person.
 * The proposal was recorded durably and the decision engines
 * (`applyOwnerDecision`, `settleOwnerDecision`) were built and tested — and
 * nothing connected the two. No route listed a parked proposal, so an owner
 * could not see what they were being asked; no route answered one, so nothing
 * could ever move. Two docstrings claimed "the owner already answers plugin
 * effects through the approval inbox", which was true of tool tasks and false
 * of host operations.
 *
 * Because neither composition root injects `capabilityKind`, `publisherRing`
 * or a standing approval, every registered operation currently evaluates at
 * custom/unverified and cards — so this is not an edge case, it is the only
 * path host operations take today. Without these routes a Buyer or Supplier
 * runner could never perform an AppView search, a D2D send, or a connector
 * call.
 *
 * OWNER ONLY, both of them. A proposal is a request for authority the runner
 * does not have; letting the runner's own lane answer it would make the card
 * a formality.
 */

import { getPluginHostRuntime } from '../../plugins/host_operations';
import { getPluginInstallRepository } from '../../plugins/registry';
import { settleOwnerDecision } from '../../plugins/host_operation_completion';
import { getWorkflowService } from '../../workflow/service';
import { parsePluginEnvelope } from '../../workflow/plugin_envelope';

import { makeOwnerGuard } from './owner_guard';

import type { CoreResponse, CoreRouter } from '../router';

export function registerHostOperationRoutes(router: CoreRouter, ownerCapability?: string): void {
  const ownerOnlyGuard = makeOwnerGuard(
    ownerCapability,
    'only the owner may answer a host-operation proposal',
  );

  /**
   * Everything waiting on a decision.
   *
   * The PARAMS travel, because an owner cannot judge "may this plugin search
   * the AppView" without seeing what it wants to search for. The retained
   * envelope does NOT: it is Core's own dispatch record, not something a
   * surface needs, and shipping it would put a claim token on a screen.
   */
  router.get('/v1/plugins/host-operations', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const runtime = getPluginHostRuntime();
    if (runtime === null) {
      return { status: 200, body: { proposals: [], host_operations_available: false } };
    }
    const proposals = runtime.broker.listAwaitingOwner().map((p) => ({
      proposal_id: p.proposalId,
      install_id: p.installId,
      capability_id: p.capabilityId,
      operation_name: p.operationName,
      params_json: p.paramsJson,
      created_at: p.createdAt,
      // Whether this one can actually be answered. A proposal parked before
      // the envelope was retained cannot be settled, and saying so is better
      // than offering a button that fails.
      resolvable: p.sourceEnvelopeJson !== null,
    }));
    return { status: 200, body: { proposals, host_operations_available: true } };
  });

  /**
   * Answer one.
   *
   * APPROVED MEANS EXECUTE. `settleOwnerDecision` permits the proposal, runs
   * the operation through the dispatcher, records the verified result, and
   * enqueues the follow-up that carries it back to the runner — all of which
   * needs the envelope of the claim that proposed it. A proposal parked
   * without one is refused here rather than half-settled: permitting an effect
   * whose result can never be delivered would spend the authority and tell
   * nobody.
   */
  router.post('/v1/plugins/host-operations/decide', async (req): Promise<CoreResponse> => {
    const denied = ownerOnlyGuard(req);
    if (denied !== null) return denied;

    const body = (req.body ?? {}) as {
      proposal_id?: unknown;
      approved?: unknown;
      reason?: unknown;
    };
    const proposalId = typeof body.proposal_id === 'string' ? body.proposal_id : '';
    if (proposalId === '' || typeof body.approved !== 'boolean') {
      return { status: 400, body: { error: 'proposal_id and approved are required' } };
    }

    const runtime = getPluginHostRuntime();
    if (runtime === null) {
      return { status: 503, body: { error: 'this node has no plugin host runtime' } };
    }
    const proposal = runtime.broker.get(proposalId);
    if (proposal === null) {
      return { status: 404, body: { error: 'no such proposal' } };
    }
    if (proposal.state !== 'proposed') {
      // Already decided. Answering twice would let one card spend two permits.
      return { status: 409, body: { error: `proposal is already ${proposal.state}` } };
    }
    if (proposal.sourceEnvelopeJson === null) {
      return { status: 409, body: { error: 'this proposal cannot be settled — no retained source' } };
    }
    const source = parsePluginEnvelope(proposal.sourceEnvelopeJson);
    if (source === null) {
      return { status: 409, body: { error: 'the retained source is unreadable' } };
    }
    const install = getPluginInstallRepository()?.getById(proposal.installId) ?? null;
    if (install === null) {
      return { status: 409, body: { error: 'the proposing install is gone' } };
    }
    // Same reasoning as the retained-source check, one step later: the runner
    // learns BOTH answers — a permitted operation's verified result and a
    // refusal — as its next task on its own lane. With no workflow store there
    // is nothing to enqueue, so settling here would spend the decision and
    // leave the runner waiting on a lane that will never fill.
    const workflow = getWorkflowService();
    if (workflow === null) {
      return { status: 503, body: { error: 'this node has no workflow store' } };
    }

    const outcome = await settleOwnerDecision({
      proposalId,
      approved: body.approved,
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      source,
      install,
      broker: runtime.broker,
      dispatcher: runtime.dispatcher,
      workflow,
    });
    return { status: outcome.kind === 'settled' ? 200 : 409, body: { outcome } };
  });
}
