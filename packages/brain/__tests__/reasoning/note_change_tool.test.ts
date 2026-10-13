/** REAL_LIFE_FIXES_2 §8.2 — a change can only name an earlier memory the run actually saw. */

import { createNoteChangeTool, emptyRememberSideEffects } from '../../src/reasoning/remember_tools';
import { formatReminderDue } from '../../src/chat/reminder_card';

it('records a change against a seen item, with that item\'s own text', async () => {
  const collect = emptyRememberSideEffects();
  const tool = createNoteChangeTool({ collect, seen: new Map([['item-7', 'The gym coach is Ravi']]) });
  expect(await tool.execute({ prior_item_id: 'item-7', relation: 'supersedes' })).toEqual({ noted: true });
  expect(collect.changes).toEqual([{ priorItemId: 'item-7', priorSummary: 'The gym coach is Ravi', relation: 'supersedes' }]);
});

it('refuses an id no search returned, and a bad relation', async () => {
  const collect = emptyRememberSideEffects();
  const tool = createNoteChangeTool({ collect, seen: new Map() });
  expect(await tool.execute({ prior_item_id: 'made-up', relation: 'conflicts' })).toHaveProperty('error');
  expect(await tool.execute({ prior_item_id: 'made-up', relation: 'maybe' })).toHaveProperty('error');
  expect(collect.changes).toEqual([]);
});

it('formats a reminder date in the given zone', () => {
  // 3 Dec 2026 04:30 UTC = 10:00 in Kolkata.
  expect(formatReminderDue(Date.UTC(2026, 11, 3, 4, 30), 'Asia/Kolkata')).toBe('3 Dec, 10:00');
});
