/**
 * The term engine's owner cards in the workflow inbox
 * (SHELF_SPACE_NEGOTIATION §7.2–7.4): raising them, taking them down, and
 * routing the owner's decision back to the engine.
 *
 * The approval itself goes through the workflow's owner-only approve route,
 * which is where presence is enforced (`PRESENCE_GATED_PAYLOAD_TYPES`; on a
 * node that cannot check it the cards fall open, by the owner's decision of
 * 2026-10-14, and the card warns) and where Brain is refused
 * (`CORE_MINTED_PAYLOAD_TYPES`). This module only translates: a card is a
 * workflow approval task whose payload `type` is one of `TERM_CARD_TYPES`
 * and whose `card_id` names the engine's own card row.
 */

import { getCommerceRuntime } from '../runtime';

import { TERM_CARD_TYPES } from './term_engine';
import { readTermCardPayload } from './term_rehydrate';
import { finishTermCardTask } from './term_runtime';

import type { WorkflowHooks } from '../../workflow/service';

/**
 * The owner decided a term card. The engine owns what the decision means;
 * here the workflow task is closed so it never sits queued afterwards.
 */
export function termWorkflowHooks(over: { nowMs?: () => number } = {}): WorkflowHooks {
  const nowMs = over.nowMs ?? Date.now;
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: ({ task, decision }) => {
      const card = readTermCardPayload(task.payload, TERM_CARD_TYPES);
      if (card === null) return;
      const engine = getCommerceRuntime()?.terms ?? null;
      if (engine === null) return;
      if (decision === 'lapsed') {
        engine.lapseCard(card.cardId);
        return;
      }
      const outcome = engine.decideCard(card.cardId, decision === 'approved');
      if (decision !== 'approved') return;
      // If this process dies before here, the engine's sweep finds the task
      // still queued and finishes the decision itself (`TermCardPort.answer`).
      finishTermCardTask(task.id, outcome, nowMs());
    },
  };
}
