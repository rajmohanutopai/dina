/**
 * `list_promises` — what the owner is owed and owes, from every place Dina
 * tracks it (docs/PROMISES_AND_WAITS.md §2.1): waits on people, promises
 * tracked from Talk, group bookings waiting on guests, quotes and orders
 * waiting on suppliers, and shelf-agreement promises.
 */

import type { AgentTool } from '../reasoning/tool_registry';
import type { CoreClient, PromiseItem } from '@dina/core';

const MAX_ITEMS = 40;

function day(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function brief(item: PromiseItem): Record<string, unknown> {
  return {
    who: item.who,
    what: item.what,
    ...(item.dueAt !== null ? { due: day(item.dueAt) } : {}),
    ...(item.late ? { late: true } : {}),
    from: item.source,
  };
}

export function createListPromisesTool(opts: {
  core: Pick<CoreClient, 'promisesList'>;
  now?: () => number;
}): AgentTool {
  const now = opts.now ?? Date.now;
  return {
    name: 'list_promises',
    description:
      'List what the user is waiting on from other people and what they promised others, across goals, Talk, group bookings, quotes, orders and shelf deals. Use it for "what am I waiting on?", "what did I promise?", "who owes me something?", "anything late?". Answer briefly from the result, late ones first; say if some sources could not be read.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['owed_to_me', 'owed_by_me', 'both'],
          description:
            'owed_to_me: what others owe the user. owed_by_me: what the user promised. Default both.',
        },
      },
    },
    async execute(args) {
      const want =
        args.direction === 'owed_to_me' || args.direction === 'owed_by_me'
          ? args.direction
          : 'both';
      const { items, missing } = await opts.core.promisesList(now());
      const pick = (d: PromiseItem['direction']): PromiseItem[] =>
        items.filter((i) => i.direction === d);
      const owedToMe = want === 'owed_by_me' ? [] : pick('owed_to_me');
      const owedByMe = want === 'owed_to_me' ? [] : pick('owed_by_me');
      return {
        ...(want !== 'owed_by_me'
          ? { waiting_on_others: owedToMe.slice(0, MAX_ITEMS).map(brief) }
          : {}),
        ...(want !== 'owed_to_me' ? { you_promised: owedByMe.slice(0, MAX_ITEMS).map(brief) } : {}),
        ...(owedToMe.length > MAX_ITEMS || owedByMe.length > MAX_ITEMS
          ? { more_not_shown: true }
          : {}),
        ...(missing.length > 0 ? { could_not_read: missing } : {}),
      };
    },
  };
}
