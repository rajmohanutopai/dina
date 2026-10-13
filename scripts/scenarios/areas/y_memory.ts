/** Y. Memory over months (docs/REAL_LIFE_SCENARIOS_2.md). Past dates are stated in the facts. */

import { ask, notHere, remember } from './part2_util';

import type { Scenario } from '../scenario';

export const areaY: Scenario[] = [
  {
    id: 'Y1',
    title: 'A fact that changes',
    async run(c) {
      await remember(c, 'in January 2026 Rohan lived in Pune');
      await remember(c, 'Rohan moved to Bangalore in June 2026');
      const q = 'Where does Rohan live?';
      await c.judge('the current city', q, await ask(c, q), 'The reply says Bangalore (it may mention he used to live in Pune, never as current).');
    },
  },
  {
    id: 'Y2',
    title: 'A contradiction',
    async run(c) {
      await remember(c, "Diya's class teacher is Ms Rao");
      const r = await remember(c, "Diya's class teacher is Mr Iyer");
      await c.judge('notices the change', "/remember Diya's class teacher is Mr Iyer", r, 'The reply notices this differs from the stored Ms Rao: it asks whether the teacher changed or records it as a change. It does not silently keep both as current.');
    },
  },
  {
    id: 'Y3',
    title: 'Forgetting on request',
    async run(c) {
      await remember(c, 'Rhea and I broke up in May; she still has my blue jacket');
      await remember(c, "Rhea's birthday is 9 August");
      const t = 'forget';
      const r = await ask(c, 'Forget everything about Rhea.', t);
      await c.judge('says a card is waiting', 'Forget everything about Rhea.', r, 'Dina says a card or approval is waiting that lists what will be forgotten; she does not claim it is already deleted.');
      // The owner approves the card (REAL_LIFE_FIXES_2 §4), as on the phone.
      const card = (await c.alonso.tasks('approval', 'pending_approval')).find((x) => String(x.payload ?? '').includes('owner_forget'));
      c.check('a forget card waits', card !== undefined);
      if (card !== undefined) await c.alonso.core('POST', `/v1/workflow/tasks/${card.id}/approve`, { body: {} });
      const left = (await c.alonso.vaultQuery('general', 'Rhea')).length;
      c.check('nothing about Rhea remains', left === 0, `${left} items`);
      c.check('Rhea is gone from people', !(await c.alonso.people()).some((p) => /^rhea$/i.test(p.canonicalName)));
    },
  },
  {
    id: 'Y4',
    title: 'A year in review',
    async run(c) {
      await remember(c, 'in February 2026 Mum had cataract surgery on her left eye');
      await remember(c, 'in May 2026 Mum started physiotherapy for her knee');
      await remember(c, "in August 2026 Mum's thyroid dose went up to 75mcg");
      const q = "What happened with Mum's health this year?";
      await c.judge('a dated summary, nothing invented', q, await ask(c, q), "The reply lists February cataract surgery (left eye), May knee physiotherapy and August thyroid dose up to 75mcg, in order, and invents nothing else.");
    },
  },
  {
    id: 'Y5',
    title: 'Recall from a weak cue',
    async run(c) {
      await remember(c, "Sancho said Fisherman's Wharf in Cavelossim is the best seafood place in Goa");
      const q = 'What was that restaurant Sancho recommended in Goa?';
      await c.judge('finds it and credits Sancho', q, await ask(c, q, 'recall'), "The reply names Fisherman's Wharf (Cavelossim) and says Sancho recommended it.");
    },
  },
  {
    id: 'Y6',
    title: 'Habits without nagging',
    async run(c) {
      for (const d of ['1', '3', '8', '15', '22']) await remember(c, `went for a 5 km run on ${d} September 2026`);
      const q = 'How consistent have I been with running in September?';
      const r = await ask(c, q);
      await c.judge('an honest count', q, r, 'The reply says five runs in September 2026 (on the 1st, 3rd, 8th, 15th and 22nd), and does not overstate it.');
      const rem = (await c.alonso.allReminders()).filter((x) => /run/i.test(x.message) && x.created_at > Date.now() - 600_000);
      c.check('no unasked running reminders', rem.length === 0, rem.map((x) => x.message).join(' | '));
    },
  },
  notHere('Y7', 'A new phone', 'restoring from the recovery phrase on a new device is a phone flow'),
];
