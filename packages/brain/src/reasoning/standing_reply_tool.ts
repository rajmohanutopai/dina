/**
 * `standing_reply` — "I'm off next week; if Sancho's Dina asks, say I'm back
 * on Monday" (REAL_LIFE_FIXES_2 §14). Owner chat only.
 *
 * `set` proposes a rule: Core checks the reply is the owner's own words,
 * that every name is one contact, and the end date, then raises a card; the
 * rule is live only after the owner's OK. `list` shows the rules; `cancel`
 * stops one, proven by the owner's turn.
 */

import { getCurrentOwnerTurn, proveOwnerWords } from '../chat/owner_turns';

import type { AgentTool } from './tool_registry';
import type { CoreClient } from '@dina/core';

type Core = Pick<CoreClient, 'standingReplyPropose' | 'standingReplyList' | 'standingReplyRevoke'>;

export function createStandingReplyTool(opts: { thread: string; core: Core }): AgentTool {
  return {
    name: 'standing_reply',
    description:
      'Set, list or cancel an automatic reply to named contacts while the user is away. action "set": `contacts` (names as the user said them; never a group like "colleagues"), `reply_text` (the user\'s own words, copied exactly), `until` (an ISO date-time for when it ends, worked out from what the user said; at most 30 days). The reply goes to ANY request from those people until then, and only after the user approves a card: say so. action "list": the rules. action "cancel": `id` from list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'cancel'] },
        contacts: { type: 'array', items: { type: 'string' } },
        reply_text: { type: 'string' },
        until: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
    async execute(args) {
      if (args.action === 'list') return opts.core.standingReplyList();
      const turn = getCurrentOwnerTurn(opts.thread);
      if (turn === null) return { error: 'no owner message is on record for this turn' };
      const proven = proveOwnerWords(opts.thread, turn.text);
      if (!proven.ok) return { error: proven.error };
      if (args.action === 'cancel') {
        if (typeof args.id !== 'string' || args.id === '') return { error: 'id is required' };
        return opts.core.standingReplyRevoke(args.id, proven.proof);
      }
      if (args.action !== 'set') return { error: 'action must be set, list or cancel' };
      const contacts = Array.isArray(args.contacts) ? args.contacts.filter((x): x is string => typeof x === 'string') : [];
      if (typeof args.reply_text !== 'string' || typeof args.until !== 'string') return { error: 'reply_text and until are required' };
      const out = await opts.core.standingReplyPropose({ proof: proven.proof, contacts, replyText: args.reply_text, until: args.until });
      // Core cannot tell a work request from any other, so the rule answers
      // every request from these contacts; the reply must not promise less.
      return out.status === 'confirm_pending'
        ? { ...out, scope: 'Once approved, this answers EVERY request from these contacts until the end date, whatever the subject. Tell the user so.' }
        : out;
    },
  };
}
