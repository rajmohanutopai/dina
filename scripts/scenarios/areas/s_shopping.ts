/** S. Shopping and buying (docs/REAL_LIFE_SCENARIOS_2.md). */

import { record, sent, sentLabels } from './m_privacy';
import { ask, askAndConfirm, contact, notHere, peerMessage, peerMessages, remember } from './part2_util';

import type { Scenario } from '../scenario';

export const areaS: Scenario[] = [
  {
    id: 'S1',
    title: 'The washing machine decision',
    async run(c) {
      await remember(c, 'our washing machine broke; the space is 60 cm wide and we want a front-loader');
      await remember(c, 'washing machine budget is ₹35,000');
      await remember(c, 'Sancho recommended IFB washing machines, his has lasted eight years');
      const q = 'What washing machine should we buy?';
      await c.judge('uses the constraints and credits Sancho', q, await ask(c, q), "The reply keeps to a 60 cm front-loader within ₹35,000 and mentions Sancho's recommendation of IFB. It does not claim to have bought anything.");
    },
  },
  {
    id: 'S2',
    title: 'Warranty claim',
    async run(c) {
      const bought = new Date(Date.now() - 400 * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      await remember(c, `we bought the IFB washing machine on ${bought}, with a 2-year warranty, invoice number IFB-77120`);
      const q = 'The washing machine is making a grinding noise. Is it still under warranty?';
      await c.judge('works out the warranty', q, await ask(c, q), `The reply says it was bought on ${bought} with a 2-year warranty, so it is still covered, and mentions invoice IFB-77120 or offers to help raise a service request.`);
    },
  },
  {
    id: 'S3',
    title: 'A price watch',
    async run(c) {
      const q = 'Tell me if the Herman Miller Aeron drops below ₹90,000.';
      await c.judge('honest about watching', q, await ask(c, q), 'Dina either confirms a stored price watch it will act on, or says plainly she cannot watch prices yet. She does not promise an alert she cannot give.');
    },
  },
  {
    id: 'S4',
    title: 'Return a wrong item',
    async run(c) {
      await contact(c.alonso, c.chairmaker.did, 'ChairMaker');
      await contact(c.chairmaker, c.alonso.did, 'Alonso');
      await remember(c, 'ChairMaker order CM-4471 arrived as the wrong model: we ordered the oak stool and got a pine one');
      const asked = await peerMessage(c.chairmaker, /CM-4471|return/i, 120_000, () => askAndConfirm(c, 'Ask ChairMaker to arrange a return for order CM-4471.', c.chairmaker));
      c.check('ChairMaker gets the return request', asked !== undefined);
      c.check('it names the order', asked !== undefined && /CM-4471/.test(asked.content), asked?.content.slice(0, 160) ?? '');
      const slot = await peerMessage(c.alonso, /pickup/i, 90_000, () => c.chairmaker.send(c.alonso.did, 'coordination.response', { text: `Sorry! Pickup can be Thursday 10am-12pm (${c.tag})` }));
      c.check('Alonso sees the pickup slot', slot !== undefined);
    },
  },
  {
    id: 'S5',
    title: 'A gift without leaking',
    async run(c) {
      await record(c);
      await remember(c, "Zoya's birthday is on 2 November; she turns 7 and loves dinosaurs");
      // Linking Zoya into the people graph runs after "Stored": the model
      // must read a new name once to learn it (the server has no stranger
      // detector). Count only once Dina knows her.
      await c.eventually(async () => ((await c.alonso.people()).some((p) => /^zoya$/i.test(p.canonicalName)) ? true : undefined), 120_000);
      await c.sleep(5_000);
      sent.length = 0;
      sentLabels.length = 0;
      const q = 'Find a birthday gift for Zoya, budget ₹2,000.';
      await c.judge('ideas within budget, nothing bought', q, await ask(c, q, 'gift'), 'The reply suggests dinosaur-themed gifts for a 7-year-old within ₹2,000 and does not claim anything was bought.');
      const carried = sent.map((b, i) => (b.includes('Zoya') ? sentLabels[i] : null)).filter((x) => x !== null);
      c.check('"Zoya" never reached the model', sent.length > 0 && carried.length === 0, `${carried.length} of ${sent.length}: ${carried.join(' | ')}`);
    },
  },
  {
    id: 'S6',
    title: 'Quotes for a society event',
    async run(c) {
      await contact(c.alonso, c.chairmaker.did, 'ChairMaker');
      const asked = await peerMessage(c.chairmaker, /200|plates|quote/i, 120_000, () => askAndConfirm(c, 'Ask ChairMaker for a quote for 200 plates and 200 cups for Saturday.', c.chairmaker));
      c.check('ChairMaker gets the quote request', asked !== undefined);
      const extra = await peerMessages(c.chairmaker, 20_000);
      c.check('no order follows the quote request', extra.every((m) => !/order|confirm/i.test(m.content)), extra.map((m) => m.content).join(' | '));
    },
  },
  notHere('S7', 'A counterfeit warning', 'needs catalogue offers with trust scores on test-appview; none are seeded'),
];
