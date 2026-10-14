/**
 * The term engine's live dependencies (SHELF_SPACE_NEGOTIATION §4, §5) —
 * resolved at CALL time from the node's registries, so the engine built with
 * the commerce runtime follows whatever the boot installs later (the D2D
 * dispatcher, the workflow service) without being rebuilt.
 *
 *   - activePack: an ACTIVE install of a first-party term half, proven by its
 *     `local_publisher_key` anchor. The runner's parameters ride on its row
 *     of `FIRST_PARTY_PACKS`: this node ships no config-value store.
 *   - isContact: a contact the owner keeps and has not blocked (§6.2).
 *   - isBlocked: a contact the owner blocked — no term gate lets it through.
 *   - spendProbing: the shared per-counterparty quote budget (§20.10), the
 *     same one quote requests spend — fail closed when it is unwired.
 *   - send: Core's D2D sender, as a `commerce.trade` push.
 *   - cards: the workflow inbox (term_workflow.ts).
 */

import { getContact } from '../../contacts/directory';
import { getPluginInstallRepository } from '../../plugins/registry';
import { getD2DSender } from '../../server/routes/d2d_msg';
import { WorkflowTaskKind, WorkflowTaskState } from '../../workflow/domain';
import { getWorkflowService } from '../../workflow/service';
import { firstPartyPack } from '../first_party_packs';
import { getQuoteAttemptLedger } from '../probing_ledger';
import { admitQuoteRequest, type CounterpartyStanding } from '../probing_resistance';

import { TermEngine } from './term_engine';
import { TermStore } from './term_store';

import type { ActiveTermPack, TermCardPort, TermTransaction } from './term_context';
import type { DatabaseAdapter } from '../../storage/db_adapter';

export function activeTermPack(role: 'term_seller' | 'term_buyer'): ActiveTermPack | null {
  const installs = getPluginInstallRepository();
  if (installs === null) return null;
  for (const install of installs.list()) {
    const entry = firstPartyPack(install.pluginId);
    if (entry === null || entry.role !== role) continue;
    if (install.status !== 'active' || install.trustAnchor.kind !== 'local_publisher_key') continue;
    return { entry, installId: install.installId };
  }
  return null;
}

function isKeptContact(did: string): boolean {
  const contact = getContact(did);
  return contact !== null && contact.trustLevel !== 'blocked';
}

function spendProbing(fromDid: string, nowMs: number): boolean {
  const ledger = getQuoteAttemptLedger();
  if (ledger === null) return false;
  const contact = getContact(fromDid);
  const standing: CounterpartyStanding =
    contact === null
      ? 'unknown'
      : contact.trustLevel === 'blocked'
        ? 'blocked'
        : contact.trustLevel === 'unknown'
          ? 'unknown'
          : 'known';
  const admission = admitQuoteRequest({
    fromDid,
    standing,
    recentAttempts: ledger.recent(fromDid, nowMs),
    nowMs,
  });
  if (!admission.quote) return false;
  ledger.record(fromDid, nowMs);
  return true;
}

/**
 * The engine's owner cards as workflow approval tasks. Decisions come back
 * through `termWorkflowHooks` (term_workflow.ts).
 */
function termCardPort(): TermCardPort {
  return {
    raise: (card) => {
      const workflow = getWorkflowService();
      if (workflow === null) return false;
      try {
        workflow.create({
          id: card.cardId,
          kind: WorkflowTaskKind.Approval,
          description: card.description,
          payload: JSON.stringify(card.payload),
          idempotencyKey: `term_card:${card.cardId}`,
          correlationId:
            typeof card.payload.request_id === 'string' ? card.payload.request_id : card.cardId,
          origin: 'd2d',
          initialState: WorkflowTaskState.PendingApproval,
          expiresAtSec: Math.floor(card.expiresAtMs / 1000),
        });
        return true;
      } catch {
        return false; // a card with this id already asks
      }
    },
    close: (cardId, reason) => {
      const workflow = getWorkflowService();
      try {
        workflow?.cancel(cardId, reason);
      } catch {
        /* already decided or gone */
      }
    },
    answer: (cardId) => {
      const task = getWorkflowService()?.store().getById(cardId) ?? null;
      if (task === null) return null;
      // Approved and not yet closed by the engine's hook.
      if (task.status === WorkflowTaskState.Queued || task.status === WorkflowTaskState.Running)
        return 'approved';
      if (task.status === WorkflowTaskState.Cancelled) return 'declined';
      return null;
    },
    finish: (cardId, outcome, nowMs) => finishTermCardTask(cardId, outcome, nowMs),
  };
}

/** Why an owner's yes bound nothing, as the inbox shows it. */
const TERM_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  no_longer_available: 'no longer available',
  offer_expired: 'the offer expired first',
  lapsed: 'the card had lapsed',
  already_decided: 'already decided',
  binding_failed: 'the terms changed after you saw them',
  unbuildable: 'could not be sent',
  pack_inactive: 'the Slot Pack is paused; resume it and a new card will ask again',
  pack_removed: 'the Slot Pack (brand) was removed; this deal can no longer be sent',
};

/**
 * Close an approved term card's inbox task: completed when the engine acted
 * on the yes, failed — with the reason in the owner's words (§7.1 step 6,
 * "no longer available") — when it bound nothing. Never "decided" for a yes
 * that did nothing.
 */
export function finishTermCardTask(
  taskId: string,
  outcome: { ok: true } | { ok: false; refusal: string },
  nowMs: number,
): void {
  const workflow = getWorkflowService();
  if (workflow === null) return;
  try {
    if (workflow.store().getById(taskId)?.status === WorkflowTaskState.Queued)
      workflow.store().transition(taskId, WorkflowTaskState.Queued, WorkflowTaskState.Running, nowMs);
    if (outcome.ok) workflow.complete(taskId, JSON.stringify({ decided: true }), 'term card decided');
    else workflow.fail(taskId, TERM_REFUSAL_WORDS[outcome.refusal] ?? 'not done');
  } catch {
    /* a raced transition changes nothing the owner decided */
  }
}

/**
 * Is a first-party term half installed in a state it can come back from:
 * active, or paused by the owner, an advisory or a restore. A hold for a
 * revoked device cannot be resumed (only a manual pause can), so that half is
 * gone for its listings' purposes, like a revoked one (`TermEngineDeps.packHeld`).
 */
export function termPackHeld(role: 'term_seller' | 'term_buyer'): boolean {
  return (getPluginInstallRepository()?.list() ?? []).some(
    (install) =>
      firstPartyPack(install.pluginId)?.role === role &&
      install.trustAnchor.kind === 'local_publisher_key' &&
      (install.status === 'active' ||
        (install.status === 'paused' && install.pauseReason !== 'device_revoked')),
  );
}

export function createTermEngine(args: {
  adapter: DatabaseAdapter;
  transaction: TermTransaction;
  nodeDid: () => string;
  now: () => number;
}): TermEngine {
  return new TermEngine({
    store: new TermStore(args.adapter),
    transaction: args.transaction,
    selfDid: args.nodeDid,
    now: args.now,
    activePack: activeTermPack,
    packHeld: termPackHeld,
    isContact: isKeptContact,
    isBlocked: (did) => getContact(did)?.trustLevel === 'blocked',
    // Core's own transport, as a `commerce.trade` push. The term engine is a
    // general Core piece (§5), not the Commerce Pack's money engine, so it
    // reaches the D2D sender directly rather than the pack's dispatcher.
    // Delivered, buffered at the relay or queued for retry all count as
    // sent: the outbox's receipt rule decides when sending can stop.
    send: async (toDid, kind, document) => {
      const send = getD2DSender();
      if (send === null || toDid === '') return false;
      try {
        const outcome = await send(toDid, 'commerce.trade', { kind, document });
        return outcome === undefined
          ? true
          : outcome.delivered || outcome.buffered || outcome.queued;
      } catch {
        return false;
      }
    },
    cards: termCardPort(),
    spendProbing,
  });
}
