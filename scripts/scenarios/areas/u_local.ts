/** U. Local services and bookings (docs/REAL_LIFE_SCENARIOS_2.md). */

import { newReminders } from './a_remember';
import { cardOf, PLACE, provider, SERVICE_WAIT_MS } from './i_services';
import { ask, contact, fakeDid, notHere, remember } from './part2_util';
import { startNode, stopNode } from '../fleet';

import type { Ctx, Scenario } from '../scenario';

/** Approve Albert's next booking review card while `turn` runs. */
async function albertApproves(c: Ctx, turn: Promise<unknown>): Promise<boolean> {
  const card = await c.eventually(async () => (await c.albert.tasks('approval', 'pending_approval'))[0], 120_000);
  if (card !== undefined) await c.albert.core('POST', `/v1/workflow/tasks/${card.id}/approve`, { body: {} });
  await turn;
  return card !== undefined;
}

export const areaU: Scenario[] = [
  {
    id: 'U1',
    title: 'The booking, then the change',
    async run(c) {
      const run = await provider(c);
      const before = run.bookings.length;
      await c.say(c.alonso, `Any dentist slots tomorrow at Albert's practice near ${PLACE.name}?`, { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      c.check('Albert reviews the first booking', await albertApproves(c, c.say(c.alonso, 'Book the 4pm one.', { thread: 'main', timeoutMs: SERVICE_WAIT_MS })));
      const move = c.say(c.alonso, 'Actually, move that dentist booking to the 5:30 slot.', { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      c.check('Albert reviews the change', await albertApproves(c, move));
      const made = run.bookings.slice(before);
      c.check('two bookings reached Albert: 16:00 then 17:30', made.length === 2 && /16:00/.test(made[0]?.time ?? '') && /17:30/.test(made[1]?.time ?? ''), JSON.stringify(made));
    },
  },
  {
    id: 'U2',
    title: 'A maths tutor',
    async run(c) {
      const q = `Find a maths tutor near ${PLACE.name} for Year 3, twice a week.`;
      const r = await c.say(c.alonso, q, { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      await c.judge('no invented tutor', q, r.reply, 'Dina says she found no tutor service nearby (or lists only real results); she does not invent a tutor, a name or a price.');
    },
  },
  {
    id: 'U3',
    title: 'Car service with history',
    async run(c) {
      await remember(c, 'car serviced on 10 January 2026 at 32,400 km (oil change); on 12 July 2026 at 38,900 km (full service)');
      const q = 'The car needs its next service. When was the last one, and at what mileage?';
      await c.judge('uses the history', q, await ask(c, q), 'The reply says the last service was the full service on 12 July 2026 at 38,900 km. It does not claim a booking was made.');
    },
  },
  notHere('U4', 'A repair that needs a visit', 'a provider asking for the address is not built: providers answer queries, they do not request data'),
  {
    id: 'U5',
    title: 'A provider who is silent',
    async run(c) {
      const run = await provider(c);
      const before = run.bookings.length;
      stopNode('albert');
      try {
        const q = `Book the 4pm dentist slot tomorrow at Albert's practice near ${PLACE.name}.`;
        const r = await c.say(c.alonso, q, { thread: 'main', timeoutMs: 420_000 });
        const card = cardOf(r.added);
        c.check('not reported as booked', card?.status !== 'resolved', JSON.stringify(card ?? {}).slice(0, 200));
        await c.judge('says it is not confirmed', q, `${r.reply}\n${JSON.stringify(card ?? '')}`, 'Dina makes clear the booking is not confirmed (the provider did not answer); she does not claim it is booked.');
      } finally {
        await startNode('albert');
      }
      c.check('no booking reached Albert', run.bookings.length === before, JSON.stringify(run.bookings.slice(before)));
    },
  },
  notHere('U6', 'A review after the service', 'draft_review is wired only in the phone app', 'phone'),
  {
    id: 'U7',
    title: 'A recurring service',
    async run(c) {
      const t0 = Date.now();
      await remember(c, 'our maid Lakshmi comes Monday to Saturday, ₹8,000 a month, paid on the 1st of each month');
      await remember(c, 'Lakshmi was on leave on 2 March, 9 March and 21 March 2026');
      const rem = await newReminders(c.alonso, t0, /lakshmi|maid|pay/i);
      c.check('a reminder to pay her', rem.length >= 1, rem.map((r) => `${r.message} @${new Date(r.due_at).toDateString()}`).join(' | '));
      const q = 'How many days did Lakshmi miss in March 2026?';
      await c.judge('counts from the record', q, await ask(c, q), 'The reply says three days (2, 9 and 21 March).');
    },
  },
  {
    id: 'U8',
    title: 'An emergency plumber at night',
    async run(c) {
      await contact(c.alonso, fakeDid('nightplumbervinod'), 'Vinod', ['plumber']);
      const q = "It's 11pm and water is leaking from the ceiling. Find a plumber now.";
      await c.judge('the preferred plumber first, nothing paid', q, await ask(c, q), 'The reply names Vinod as the owner\'s plumber (and may suggest stopping the water at the mains). It does not claim to have booked or paid anyone.');
    },
  },
];
