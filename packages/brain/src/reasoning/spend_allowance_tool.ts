/**
 * `spend_allowance` — "let my shopping agent spend up to ₹5,000 this month on
 * household items" (REAL_LIFE_FIXES_2 §15; owner decision 2026-10-09).
 * Owner chat only.
 *
 * `set` proposes a budget for one paired agent; Core always raises a card
 * that needs the owner present. Purchases the agent declares inside it are
 * answered without a card; anything else still comes to the owner. Dina
 * never pays: the agent pays at the shop. `list` shows budgets and what each
 * used this period; `cancel` stops one.
 */

import { getCurrentOwnerTurn, proveOwnerWords } from '../chat/owner_turns';

import { currencyExponent, type CoreClient } from '@dina/core';

import type { AgentTool } from './tool_registry';

type Core = Pick<CoreClient, 'spendAllowancePropose' | 'spendAllowanceList' | 'spendAllowanceRevoke'>;

export function createSpendAllowanceTool(opts: { thread: string; core: Core }): AgentTool {
  return {
    name: 'spend_allowance',
    description:
      'Set, list or cancel a spending budget for one of the user\'s paired agents (the dina-agent devices paired in Settings → Agents, not outside A2A agents). If you are not sure of an agent\'s name, call "list" first: it returns `agents`, the paired agents\' names. action "set": `agent` (its name, as listed), `amount` (a number in the main unit, e.g. 5000 for ₹5,000), `currency` (three letters, e.g. INR), `period` ("week" or "month"), `category` (the user\'s own words, e.g. "household items"), optional `per_item_cap` and `until` (ISO date). Dina never pays: the agent pays at the shop; purchases outside the budget still come to the user. The budget starts only after the user approves a card in person: say so. action "list": budgets, spending this period, and each purchase (amount, shop, time; "auto" means within the budget with no card). action "cancel": `id` from list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'cancel'] },
        agent: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        period: { type: 'string', enum: ['week', 'month'] },
        category: { type: 'string' },
        per_item_cap: { type: 'number' },
        until: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
    async execute(args) {
      if (args.action === 'list') return opts.core.spendAllowanceList();
      const turn = getCurrentOwnerTurn(opts.thread);
      if (turn === null) return { error: 'no owner message is on record for this turn' };
      const proven = proveOwnerWords(opts.thread, turn.text);
      if (!proven.ok) return { error: proven.error };
      if (args.action === 'cancel') {
        if (typeof args.id !== 'string' || args.id === '') return { error: 'id is required' };
        return opts.core.spendAllowanceRevoke(args.id, proven.proof);
      }
      if (args.action !== 'set') return { error: 'action must be set, list or cancel' };
      if (typeof args.currency !== 'string' || !/^[A-Za-z]{3}$/.test(args.currency)) return { error: 'currency must be a three-letter code' };
      const currency = args.currency.toUpperCase();
      // The currency's own minor unit: ¥5,000 is 5000, ₹5,000 is 500000.
      const scale = 10 ** currencyExponent(currency);
      const minor = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * scale) : undefined);
      const amountMinor = minor(args.amount);
      if (amountMinor === undefined || typeof args.agent !== 'string' || typeof args.period !== 'string' || typeof args.category !== 'string') {
        return { error: 'agent, amount, currency, period and category are required' };
      }
      const cap = minor(args.per_item_cap);
      return opts.core.spendAllowancePropose({
        proof: proven.proof,
        agent: args.agent,
        amountMinor,
        currency,
        period: args.period,
        category: args.category,
        ...(cap !== undefined ? { perItemCapMinor: cap } : {}),
        ...(typeof args.until === 'string' ? { until: args.until } : {}),
      });
    },
  };
}
