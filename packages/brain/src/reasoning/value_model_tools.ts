/**
 * Drawing out the owner's value model (COMMITMENT_KERNEL §7, §15 step 5).
 *
 * `read_deal_values` shows Brain what it may see of the model for a kind of
 * deal; `propose_deal_values` turns what the owner just said into up to four
 * changes on one card. Registered only for the owner's chat turns. Nothing
 * changes until the owner says yes on the card. Brain helps the owner say what
 * they value; it never decides it.
 *
 * Brain never asks for, and never proposes, the walk-away point, the comfort
 * zone, per-part limits, totals or asking terms: the owner sets those on the
 * Core form. A never-rule with a figure is such a limit, so Core refuses it.
 */

import { getCurrentOwnerTurn, proveOwnerWords } from '../chat/owner_turns';

import type { AgentTool } from './tool_registry';
import type { CoreClient } from '@dina/core';

const KINDS = ['shelf_space.host', 'shelf_space.vendor', 'goods.buyer', 'goods.seller'];

const KIND_WORDS =
  '`shelf_space.host` is the owner renting out shelf space (a store); `shelf_space.vendor` is the owner renting it (a brand); `goods.buyer` is the owner buying stock (what each delivery day is worth to them); `goods.seller` is the owner selling stock (what delivering on each day costs them, as a negative value, and `saving_share`: how much of what a cheaper day saves them they pass on — third, half or most, as one choice entry with id `saving_share` and no persona).';

export function createReadDealValuesTool(opts: {
  core: Pick<CoreClient, 'commitmentBrainView'>;
}): AgentTool {
  return {
    name: 'read_deal_values',
    description: `Read what Dina knows about what the user values in a kind of deal: the parts, choices and promises the deal can have, and the values, costs and never-rules the user has confirmed. ${KIND_WORDS} Use it before proposing changes. It never shows the walk-away point, limits, totals or asking terms, and you must never ask the user for them.`,
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: KINDS } },
      required: ['kind'],
    },
    async execute(args) {
      const kind = typeof args.kind === 'string' ? args.kind : '';
      if (!KINDS.includes(kind)) return { error: `kind: one of ${KINDS.join(', ')}` };
      return opts.core.commitmentBrainView(kind);
    },
  };
}

export function createProposeDealValuesTool(opts: {
  thread: string;
  core: Pick<CoreClient, 'commitmentProposeChanges'>;
}): AgentTool {
  return {
    name: 'propose_deal_values',
    description: `Turn what the user just told you about a kind of deal into changes Dina will show them on one card (at most 4). ${KIND_WORDS} Each change is {action:"put", entry} or {action:"remove", id}. An entry is {body}, with an optional persona; leave out its id for something new, and give the id from read_deal_values only to change or remove an entry you saw there; body is one of: {type:"choice", part, option, rupees} | {type:"flag", part, set, unset} | {type:"promise", part, dimensions, rupees} | {type:"never", label, all:[{part, flag|choice|present}]} | {type:"capacity", part, dimension, amount}. Rupees are whole rupees a month, as strings; a cost to the user is negative. Use only parts and words from read_deal_values. Never invent what the user did not say, and never propose a walk-away point, limit, total or asking price, or a never-rule with a figure: tell the user to set those themselves in the deal settings. Nothing changes until the user approves the card; tell them a card is waiting.`,
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        changes: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object' } },
      },
      required: ['kind', 'changes'],
    },
    async execute(args) {
      const kind = typeof args.kind === 'string' ? args.kind : '';
      if (!KINDS.includes(kind)) return { error: `kind: one of ${KINDS.join(', ')}` };
      const changes = Array.isArray(args.changes)
        ? args.changes.filter(
            (c): c is Record<string, unknown> => c !== null && typeof c === 'object',
          )
        : [];
      if (changes.length === 0 || changes.length > 4) return { error: 'changes: 1 to 4' };
      const turn = getCurrentOwnerTurn(opts.thread);
      if (turn === null) return { error: 'no owner message is on record for this turn' };
      const proven = proveOwnerWords(opts.thread, turn.text);
      if (!proven.ok) return { error: proven.error };
      return opts.core.commitmentProposeChanges({ kind, proof: proven.proof, changes });
    },
  };
}

/**
 * COMMITMENT_KERNEL §15 step 11: when the owner chose Brain to bargain for
 * selling goods, Brain sets the standing share of a cheaper day's saving that
 * goes to the buyer, by its own judgement. Core refuses it otherwise, spends
 * a verdict on each change, and keeps every price within the owner's floors.
 */
export function createSetSavingShareTool(opts: {
  core: Pick<CoreClient, 'commitmentSetSavingShare'>;
}): AgentTool {
  return {
    name: 'set_saving_share',
    description:
      'Only when the user has chosen you to bargain for them when selling goods: set how much of what a cheaper delivery day saves them is passed on to the buyer, in hundredths of a percent (5000 is half). Start from their own choice (`saving_share` in read_deal_values) and move from it by your judgement of what wins orders without giving away more than needed. Each change uses one of your turns, so change it rarely. Core still keeps every price within their limits.',
    parameters: {
      type: 'object',
      properties: { share_bps: { type: 'integer', minimum: 0, maximum: 10000 } },
      required: ['share_bps'],
    },
    async execute(args) {
      const bps = args.share_bps;
      if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000)
        return { error: 'share_bps: a whole number from 0 to 10000' };
      return opts.core.commitmentSetSavingShare(bps);
    },
  };
}
