/**
 * `forget` — the owner asks Dina to forget something (REAL_LIFE_FIXES_2 §4).
 *
 * Registered only for the owner's chat turns, never for agent asks. Brain
 * proves the owner's turn; Core plans from its own data and always raises a
 * card. Nothing is deleted until the owner approves it, so the reply says a
 * card is waiting.
 */

import { getCurrentOwnerTurn, proveOwnerWords } from '../chat/owner_turns';

import type { AgentTool } from './tool_registry';
import type { CoreClient } from '@dina/core';

export function createForgetTool(opts: { thread: string; core: Pick<CoreClient, 'forgetPropose'> }): AgentTool {
  return {
    name: 'forget',
    description:
      'Forget stored information when the user asks ("forget everything about Rhea", "delete that note about the jacket", "archive my work stuff but keep the references"). Give exactly one of: `person` (a name the user said), `persona` (a vault to clear, with `keep_item_ids` for items to keep, from vault_search), or `item_ids` (specific items from vault_search). Nothing is deleted now: Dina shows the user a card listing exactly what will go, and only their OK deletes it. Tell the user a card is waiting.',
    parameters: {
      type: 'object',
      properties: {
        person: { type: 'string', description: 'Forget everything about this person, as the user named them.' },
        persona: { type: 'string', description: 'Forget the items in this vault.' },
        keep_item_ids: { type: 'array', items: { type: 'string' }, description: 'With persona: items to keep.' },
        item_ids: { type: 'array', items: { type: 'string' }, description: 'Specific items to forget.' },
      },
      required: [],
    },
    async execute(args) {
      const person = typeof args.person === 'string' ? args.person.trim() : '';
      const persona = typeof args.persona === 'string' ? args.persona.trim() : '';
      const ids = Array.isArray(args.item_ids) ? args.item_ids.filter((x): x is string => typeof x === 'string') : [];
      const keep = Array.isArray(args.keep_item_ids) ? args.keep_item_ids.filter((x): x is string => typeof x === 'string') : [];
      const given = [person !== '', persona !== '', ids.length > 0].filter(Boolean).length;
      if (given !== 1) return { error: 'give exactly one of person, persona or item_ids' };
      const turn = getCurrentOwnerTurn(opts.thread);
      if (turn === null) return { error: 'no owner message is on record for this turn' };
      const proven = proveOwnerWords(opts.thread, turn.text);
      if (!proven.ok) return { error: proven.error };
      const request =
        person !== '' ? { person } : persona !== '' ? { persona, ...(keep.length > 0 ? { keep_item_ids: keep } : {}) } : { item_ids: ids };
      return opts.core.forgetPropose({ proof: proven.proof, request });
    },
  };
}
