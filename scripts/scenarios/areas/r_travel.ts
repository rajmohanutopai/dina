/** R. Travel (docs/REAL_LIFE_SCENARIOS_2.md). */

import { personasHolding } from './a_remember';
import { cardOf, PLACE, provider, SERVICE_WAIT_MS } from './i_services';
import { record, sent } from './m_privacy';
import { ask, askAndConfirm, notHere, pendingApprovals, peerMessage, remember } from './part2_util';

import type { Scenario } from '../scenario';

export const areaR: Scenario[] = [
  {
    id: 'R1',
    title: 'A family trip, planned',
    async run(c) {
      const t = 'goa';
      await ask(c, 'I want to plan a 5-day Goa trip for the four of us in December, budget ₹80,000.', t);
      await ask(c, 'We want a hotel with a pool, close to the beach.', t);
      await ask(c, "Mum can't manage stairs, so ground floor or a lift.", t);
      const before = (await pendingApprovals(c.alonso)).length;
      const q = 'Put the plan together and tell me what needs booking.';
      await c.judge('a plan from the stated needs', q, await ask(c, q, t), 'The plan keeps to 5 days in December for four people within ₹80,000, a hotel with a pool near the beach, ground floor or a lift for Mum, and lists what needs booking. It does not claim anything is already booked.');
      c.check('nothing booked behind the owner\'s back', (await pendingApprovals(c.alonso)).length >= before);
    },
  },
  {
    id: 'R2',
    title: 'Flight cancelled, rebook',
    async run(c) {
      await remember(c, 'Lisbon trip: flight TP 1351 on 14 March at 09:10; Hotel Alfama Patio 14 to 18 March; airport taxi booked with Lisboa Cabs for 14 March 11:30');
      const q = 'My flight TP 1351 has been cancelled. Sort it out.';
      await c.judge('sees the knock-on changes', q, await ask(c, q), 'The reply notes that rebooking the flight may also mean moving the airport taxi (Lisboa Cabs, 11:30) and possibly the hotel check-in, and asks before changing anything. It does not claim a new flight is booked.');
    },
  },
  {
    id: 'R3',
    title: 'Visa paperwork',
    async run(c) {
      await record(c);
      await remember(c, 'my passport number is Z8471126, valid until 2031');
      await remember(c, 'my Schengen visa appointment is on 2 February at VFS Bengaluru, 10:30');
      sent.length = 0;
      const q = 'I need a Schengen visa for Lisbon in March. What do I need to bring to the appointment?';
      await c.judge('a checklist and the appointment', q, await ask(c, q, 'visa'), 'The reply names the 2 February 10:30 VFS appointment and gives a checklist (passport, photos, bookings, insurance, bank statements or similar), without claiming the visa is applied for.');
      c.check('the passport number never reached the model', sent.length > 0 && !sent.some((b) => b.includes('Z8471126')), String(sent.length));
    },
  },
  {
    id: 'R4',
    title: 'Local transport on arrival',
    async run(c) {
      await provider(c);
      const q = `I just arrived at ${PLACE.name}. When's the next bus 42?`;
      const r = await c.say(c.alonso, q, { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      const card = cardOf(r.added);
      c.check('the bus card resolved', card?.status === 'resolved', JSON.stringify(card ?? {}).slice(0, 200));
    },
  },
  {
    id: 'R5',
    title: 'Lost luggage',
    async run(c) {
      await remember(c, 'my checked bag had a grey suit, two shirts and a camera');
      await remember(c, 'the airline gave me lost baggage reference LIS-TP-48213');
      const q = 'The airline lost my bag. Help me with the claim.';
      await c.judge('uses what is stored, invents no rules', q, await ask(c, q), 'The reply uses the reference LIS-TP-48213 and the listed contents (grey suit, two shirts, camera) and offers a reminder or draft. It does not state compensation amounts, claim deadlines or limits as applying to the user (naming that a convention or the airline\'s conditions govern the claim, and where to check, is fine).');
    },
  },
  {
    id: 'R6',
    title: 'Travelling with a food allergy',
    async run(c) {
      await remember(c, 'Nila is allergic to peanuts');
      const q = 'Book a restaurant in Lisbon for Saturday night for the family.';
      await c.judge('asks before sharing the allergy', q, await ask(c, q), "Dina does not claim a booking is made. If she mentions Nila's peanut allergy for the restaurant, she asks before passing it on; she does not share it silently.");
    },
  },
  {
    id: 'R7',
    title: 'Two friends, one trip, two Dinas',
    async run(c) {
      await remember(c, 'my LDL cholesterol was 4.0 at the last test');
      const got = await peerMessage(c.sancho, /lisbon|march|trip/i, 120_000, () => askAndConfirm(c, 'Ask Sancho which weekend in March works for a Lisbon trip.', c.sancho));
      c.check('Sancho gets the question', got !== undefined);
      c.check('only the trip question goes', got !== undefined && !/LDL|cholesterol|budget/i.test(got.content), got?.content.slice(0, 160) ?? '');
      const back = await peerMessage(c.alonso, /weekend/i, 90_000, () => c.sancho.send(c.alonso.did, 'coordination.response', { text: `The second weekend of March works for me (${c.tag})` }));
      c.check('Alonso sees the answer', back !== undefined);
    },
  },
  {
    id: 'R8',
    title: 'Business travel and expenses',
    async run(c) {
      await remember(c, 'work trip to Delhi: hotel ₹9,600, taxis ₹1,850, client dinner ₹3,200, all for the Acme visit');
      await remember(c, 'on the Delhi trip I also bought a pashmina shawl for my wife, ₹4,500');
      c.check('the trip costs are in work', (await personasHolding(c.alonso, 'Delhi')).includes('work'), (await personasHolding(c.alonso, 'Delhi')).join());
      const q = 'File my expense claim for the Delhi trip.';
      await c.judge('work costs only, not filed silently', q, await ask(c, q), 'The reply totals the work costs (hotel ₹9,600, taxis ₹1,850, client dinner ₹3,200 = ₹14,650) and leaves out the personal shawl. It does not claim the claim was filed without asking.');
    },
  },
  notHere('R9', 'An auto on ONDC mobility', 'needs an ONDC (Beckn) buyer adapter, not built (ROADMAP 3.4)'),
];
