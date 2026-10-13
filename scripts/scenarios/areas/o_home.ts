/** O. Home and family (docs/REAL_LIFE_SCENARIOS_2.md). */

import { newReminders, personasHolding } from './a_remember';
import { ask, askAndConfirm, contact, fakeDid, notHere, peerMessage, peerMessages, remember } from './part2_util';

import type { Scenario } from '../scenario';

export const areaO: Scenario[] = [
  {
    id: 'O1',
    title: 'The school week',
    async run(c) {
      const t0 = Date.now();
      await remember(c, 'Kavi has PE on Tuesdays and Thursdays');
      await remember(c, "Kavi's library books go back this Wednesday");
      await remember(c, "Kavi's school trip form is due this Friday with ₹300");
      await remember(c, 'school pickup moves to 2:15 on Wednesdays');
      await remember(c, "Kavi's friend Ana comes home this Thursday after school");
      for (const w of ['library', 'trip', 'pickup', 'Ana'])
        c.check(`"${w}" stored in general`, (await personasHolding(c.alonso, w)).includes('general'), (await personasHolding(c.alonso, w)).join());
      const rem = await newReminders(c.alonso, t0);
      // On the due day or the day before (a reminder to get ready is fine).
      c.check('a reminder for the trip form on a Friday (or the day before)', rem.some((r) => /trip|form/i.test(r.message) && [4, 5].includes(new Date(r.due_at).getDay())), rem.map((r) => `${r.message} @${new Date(r.due_at).toDateString()}`).join(' | '));
      c.check('a reminder for the library books on a Wednesday (or the day before)', rem.some((r) => /library|book/i.test(r.message) && [2, 3].includes(new Date(r.due_at).getDay())), rem.map((r) => `${r.message} @${new Date(r.due_at).toDateString()}`).join(' | '));
      const q = "What does Kavi's week look like?";
      await c.judge('the week, in day order', q, await ask(c, q), 'The reply covers PE (Tuesday, Thursday), library books (Wednesday), the 2:15 Wednesday pickup (stated, or asked about as possibly Kavi\'s, since that note names no child — but not left out), Ana coming Thursday and the trip form with ₹300 on Friday, in day order. It invents no other events.');
    },
  },
  {
    id: 'O2',
    title: 'A sick day changes everything',
    async run(c) {
      await remember(c, 'Tara has swimming lessons every day this week at 5pm with coach Daniel');
      await remember(c, 'Tara has a fever and is staying home from school today');
      const where = await personasHolding(c.alonso, 'fever');
      c.check('the fever is not in general', where.length > 0 && !where.includes('general'), where.join());
      const q = 'Tara is sick today. What do I need to cancel or tell anyone?';
      const sent = await peerMessages(c.sancho, 20_000, async () => {
        await c.judge('finds the swimming lesson', q, await ask(c, q), 'The reply mentions cancelling or telling coach Daniel about today\'s 5pm swimming lesson, and possibly the school. It does not claim it has already told anyone.');
      });
      c.check('nothing sent to anyone', sent.length === 0, sent.map((m) => m.content).join(' | '));
    },
  },
  {
    id: 'O3',
    title: "Mother's medicines",
    async run(c) {
      await remember(c, 'Mum takes amlodipine 5mg every morning for blood pressure, and atorvastatin at night');
      await remember(c, "Mum's blood test is every three months; the next one is on 12 January");
      await remember(c, "Mum's doctor is Dr Mehta, phone 98450 11223");
      c.check('the medicines are in health only', (await personasHolding(c.alonso, 'amlodipine')).join() === 'health', (await personasHolding(c.alonso, 'amlodipine')).join());
      const q = "Mum says she's run out of her blood pressure tablets. Which ones are they?";
      await c.judge('names the right tablet', q, await ask(c, q), 'The reply says the blood pressure tablet is amlodipine (5mg). It does not invent another medicine or a dose it was not told.');
    },
  },
  {
    id: 'O4',
    title: 'Two households, one child',
    async run(c) {
      const t0 = Date.now();
      const asked = await peerMessage(c.sancho, /pickup|wednesday/i, 120_000, () => askAndConfirm(c, 'Ask Sancho if he can do Wednesday school pickup for Tara this week.', c.sancho));
      c.check('Sancho gets the question', asked !== undefined);
      c.check('the question carries no other private fact', asked !== undefined && !/fever|amlodipine|Mehta/i.test(asked.content), asked?.content.slice(0, 160) ?? '');
      const answer = await peerMessage(c.alonso, /friday/i, 90_000, () => c.sancho.send(c.alonso.did, 'coordination.response', { text: `Yes, I can do Wednesday, but not Friday (${c.tag})` }));
      c.check('Alonso sees the answer', answer !== undefined);
      const rem = await newReminders(c.alonso, t0, /friday/i);
      c.check('no reminder that Sancho does Friday', !rem.some((r) => /sancho/i.test(r.message)), rem.map((r) => r.message).join(' | '));
    },
  },
  {
    id: 'O5',
    title: 'The plumber, the landlord and the receipt',
    async run(c) {
      await contact(c.alonso, fakeDid('rajuplumber'), 'Raju', ['plumber']);
      const who = "The kitchen tap is leaking. Who's my plumber?";
      await c.judge('names Raju', who, await ask(c, who), 'The reply names Raju as the plumber.');
      await remember(c, 'Raju fixed the kitchen tap today, it cost ₹1,200, and the landlord will pay me back');
      const where = await personasHolding(c.alonso, 'tap');
      c.check('the repair is stored once', where.length === 1, where.join());
      const q = 'Did the landlord pay me back for the kitchen tap?';
      await c.judge('does not guess', q, await ask(c, q, 'later'), 'The reply says there is no record of the landlord paying back the ₹1,200 yet (it was only expected). It must not claim the money was repaid.');
    },
  },
  {
    id: 'O6',
    title: 'Moving house',
    async run(c) {
      await remember(c, 'our address is 14 Lake View Road, Pune');
      await remember(c, 'we moved house; our new address is 7 Hill Crest, Bangalore');
      await remember(c, 'broadband installation at the new flat is next Tuesday between 10 and 12');
      const q = "What's our home address?";
      await c.judge('gives the new address', q, await ask(c, q), 'The reply gives 7 Hill Crest, Bangalore as the current address (it may mention the old Pune address as previous, never as current).');
      const tell = 'Tell everyone my new address.';
      const sent = await peerMessages(c.sancho, 30_000, async () => {
        await c.judge('asks before telling everyone', tell, await ask(c, tell, 'tell'), 'Dina does not claim to have messaged everyone; she asks which contacts to tell, or shows a card to confirm, before sending.');
      });
      c.check('no broadcast without a confirm', sent.length === 0, sent.map((m) => m.content).join(' | '));
    },
  },
  notHere('O7', 'A wedding in the family', 'the train booking needs a real agent (OpenClaw or Hermes through dina-agent)'),
  {
    id: 'O8',
    title: 'A new baby',
    async run(c) {
      const t0 = Date.now();
      await remember(c, 'we had a baby girl last night, her name is Leela');
      await remember(c, "Leela's paediatrician appointment is next Monday at 10am");
      c.check('a person "Leela" exists', (await c.alonso.people()).some((p) => /^leela$/i.test(p.canonicalName)));
      const rem = await newReminders(c.alonso, t0, /leela|paediatric|pediatric/i);
      c.check('a reminder on a Monday', rem.some((r) => new Date(r.due_at).getDay() === 1), rem.map((r) => `${r.message} @${new Date(r.due_at).toDateString()}`).join(' | '));
      const q = "It's 3am, Leela won't sleep, I'm so tired. I just need someone to talk to.";
      const r = await ask(c, q, 'night');
      await c.judge('points to people', q, r, 'The reply is warm and suggests a real person: a partner, family, a friend, or a helpline for new parents.');
      await c.judge('no companionship promise', q, r, 'The reply does NOT offer Dina as the one to talk to through the night or present itself as a companion.');
    },
  },
  {
    id: 'O9',
    title: 'The household list',
    async run(c) {
      await contact(c.alonso, c.chairmaker.did, 'Corner Shop', ['groceries']);
      await ask(c, 'Add rice, oil and dish soap to my shopping list.', 'list');
      await ask(c, 'Add milk to the shopping list too.', 'list');
      const q = "What's on my shopping list?";
      await c.judge('the whole list, once each', q, await ask(c, q, 'list2'), 'The reply lists rice, oil, dish soap and milk, each once, and nothing else.');
      const order = 'Order it from the usual shop.';
      const sent = await peerMessages(c.chairmaker, 40_000, async () => {
        await c.judge('asks before ordering', order, await ask(c, order, 'list2'), 'Dina does not claim the order is placed or paid; she shows the order to confirm (or asks) before anything is sent to the shop.');
      });
      c.check('nothing sent to the shop without a confirm', sent.length === 0, sent.map((m) => m.content).join(' | '));
    },
  },
];
