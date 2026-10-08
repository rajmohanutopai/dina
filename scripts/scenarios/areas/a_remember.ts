/** A. Remembering things (docs/REAL_LIFE_SCENARIOS.md). */

import type { Dina } from '../client';
import type { Scenario } from '../scenario';

const PERSONAS = ['general', 'health', 'finance', 'work'] as const;

/** Which personas hold an item matching `word` (FTS). */
export async function personasHolding(d: Dina, word: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of PERSONAS) if ((await d.vaultQuery(p, word)).length > 0) out.push(p);
  return out;
}

/** Reminders created after `since` whose text matches `pattern`. */
export async function newReminders(d: Dina, since: number, pattern?: RegExp) {
  return (await d.allReminders()).filter(
    (r) => r.created_at >= since && (pattern === undefined || pattern.test(r.message)),
  );
}

export const areaA: Scenario[] = [
  {
    id: 'A1',
    title: "A new parent's week",
    async run(c) {
      const approvalsBefore = (await c.alonso.tasks('approval', 'pending_approval')).length;
      await c.say(c.alonso, "/remember Mira's school pickup is 3:15 on weekdays");
      await c.say(c.alonso, '/remember Mira is allergic to peanuts');
      await c.say(c.alonso, "/remember Mira's teacher is Ms Rao");
      for (const w of ['pickup', 'Rao'])
        c.check(`"${w}" stored in general`, (await personasHolding(c.alonso, w)).join() === 'general', (await personasHolding(c.alonso, w)).join());
      // A child's allergy may fairly go to health or general, but to one place.
      const allergy = await personasHolding(c.alonso, 'peanuts');
      c.check('the allergy stored once, in health or general', allergy.length === 1 && ['health', 'general'].includes(allergy[0] as string), allergy.join());
      const mira = (await c.alonso.people()).find((p) => /^mira$/i.test(p.canonicalName));
      c.check('one person "Mira" exists', mira !== undefined);
      c.check('no approval task raised', (await c.alonso.tasks('approval', 'pending_approval')).length === approvalsBefore);
    },
  },
  {
    id: 'A2',
    title: 'Health after a doctor visit',
    async run(c) {
      const t0 = Date.now();
      const r1 = await c.say(c.alonso, '/remember my HbA1c came back 6.1, doctor wants a recheck in 3 months');
      await c.say(c.alonso, '/remember I started metformin 500mg twice a day');
      c.expectReply('reply names the Health vault', r1.reply, /health/i);
      c.check('HbA1c in health only', (await personasHolding(c.alonso, 'HbA1c')).join() === 'health', (await personasHolding(c.alonso, 'HbA1c')).join());
      c.check('metformin in health only', (await personasHolding(c.alonso, 'metformin')).join() === 'health', (await personasHolding(c.alonso, 'metformin')).join());
      const rem = await newReminders(c.alonso, t0);
      const inRange = rem.filter((r) => r.due_at > Date.now() + 60 * 86_400_000 && r.due_at < Date.now() + 120 * 86_400_000);
      c.check('a recheck reminder about 3 months out', inRange.length >= 1, rem.map((r) => `${r.message} @${new Date(r.due_at).toISOString()}`).join(' | '));
    },
  },
  {
    id: 'A3',
    title: 'Money admin',
    async run(c) {
      const t0 = Date.now();
      await c.say(c.alonso, '/remember my Barclays account ends 0102');
      await c.say(c.alonso, '/remember car insurance renews 14 March, premium £640');
      c.check('Barclays in finance only', (await personasHolding(c.alonso, 'Barclays')).join() === 'finance', (await personasHolding(c.alonso, 'Barclays')).join());
      c.check('insurance in finance only', (await personasHolding(c.alonso, 'insurance')).join() === 'finance', (await personasHolding(c.alonso, 'insurance')).join());
      const rem = await newReminders(c.alonso, t0, /insurance|renew/i);
      c.check('a renewal reminder exists', rem.length >= 1, rem.map((r) => r.message).join(' | '));
    },
  },
  {
    id: 'A4',
    title: 'Work context',
    async run(c) {
      const t0 = Date.now();
      await c.say(c.alonso, '/remember the Q4 roadmap review is with Priya on Thursday 10am');
      await c.say(c.alonso, '/remember Acme contract renewal is due end of November');
      c.check('roadmap in work', (await personasHolding(c.alonso, 'roadmap')).includes('work'), (await personasHolding(c.alonso, 'roadmap')).join());
      c.check('Acme in work', (await personasHolding(c.alonso, 'Acme')).includes('work'), (await personasHolding(c.alonso, 'Acme')).join());
      const rem = await newReminders(c.alonso, t0, /roadmap|Priya|review/i);
      c.check('a reminder for the Thursday review', rem.some((r) => new Date(r.due_at).getDay() === 4), rem.map((r) => `${r.message} @${new Date(r.due_at).toString()}`).join(' | '));
      c.check('person "Priya" exists', (await c.alonso.people()).some((p) => /^priya$/i.test(p.canonicalName)));
    },
  },
  {
    id: 'A5',
    title: 'A fact that is both money and a friend',
    async run(c) {
      await c.say(c.alonso, '/remember Sancho lent me £200 for the concert tickets');
      const where = await personasHolding(c.alonso, 'concert');
      c.check('stored exactly once', where.length === 1, where.join());
      c.check('in finance or general', where.length === 1 && ['finance', 'general'].includes(where[0] as string), where.join());
    },
  },
  {
    id: 'A6',
    title: 'Saying the same thing twice',
    async run(c) {
      await c.say(c.alonso, '/remember Sancho is vegetarian');
      const second = await c.say(c.alonso, '/remember Sancho is vegetarian');
      c.expectReply('second reply says it is already stored', second.reply, /already/i);
      c.check('one item', (await c.alonso.vaultQuery('general', 'vegetarian')).length === 1, String((await c.alonso.vaultQuery('general', 'vegetarian')).length));
    },
  },
  {
    id: 'A7',
    title: 'A correction',
    async run(c) {
      await c.say(c.alonso, "/remember Teo's birthday is 3 June");
      await c.say(c.alonso, "/remember actually Teo's birthday is 13 June, not the 3rd");
      const q = "when is Teo's birthday?";
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('answer gives 13 June', q, r.reply, 'The reply says the birthday is 13 June (it may mention the earlier 3 June note as corrected, but must give 13 June as the answer).');
      const rem = (await c.alonso.allReminders()).filter((x) => /Teo/i.test(x.message));
      c.check('a reminder on 13 June', rem.some((x) => new Date(x.due_at).getDate() === 13 && new Date(x.due_at).getMonth() === 5), rem.map((x) => new Date(x.due_at).toDateString()).join(' | '));
    },
  },
  {
    id: 'A8',
    title: 'Dated facts make reminders, others do not',
    async run(c) {
      const t0 = Date.now();
      await c.say(c.alonso, '/remember dentist appointment on the 21st at 4pm');
      const mid = Date.now();
      await c.say(c.alonso, '/remember my favourite colour is green');
      c.check('the dentist made a reminder', (await newReminders(c.alonso, t0, /dentist/i)).length >= 1);
      const after = (await c.alonso.allReminders()).filter((r) => r.created_at >= mid);
      c.check('the colour made none', after.length === 0, after.map((r) => r.message).join(' | '));
    },
  },
  {
    id: 'A9',
    title: "Someone else's health",
    async run(c) {
      await c.say(c.alonso, "/remember Sancho's mother had knee surgery last week");
      const where = await personasHolding(c.alonso, 'knee');
      // The spec leaves the vault to the classifier: someone else's surgery
      // may fairly go to health (its description lists doctor visits) or to
      // general — but to one place, like A1.
      c.check('stored once, in health or general', where.length === 1 && ['health', 'general'].includes(where[0] as string), where.join());
    },
  },
  {
    id: 'A10',
    title: 'A long trip plan',
    async run(c) {
      const plan = [
        'Lisbon trip plan. Flights: TP1351 out on 12 May at 07:40, back TP1360 on 19 May.',
        'Hotel: Memmo Alfama, booking ref 88213, three rooms.',
        'Coming: Sancho, Rafa and Ines. Ines needs a vegetarian option every night.',
        'My passport number is 533812947 and expires in 2029.',
        ...Array.from({ length: 40 }, (_, i) => `Day note ${i + 1}: walk the Alfama, tram 28, pasteis de nata at Manteigaria, a fado bar in the evening.`),
      ].join(' ');
      const r = await c.say(c.alonso, `/remember ${plan}`, { timeoutMs: 240_000 });
      c.check('stored', /stored|already/i.test(r.reply), r.reply.slice(0, 120));
      c.check('found by search', (await personasHolding(c.alonso, 'Manteigaria')).length >= 1);
      // People are linked as the item is stored; give the drain a moment.
      const want = (names: string[]) => ['rafa', 'ines'].every((n) => names.some((p) => p.toLowerCase() === n));
      await c.eventually(async () => (want((await c.alonso.people()).map((p) => p.canonicalName)) ? true : undefined), 30_000);
      const people = (await c.alonso.people()).map((p) => p.canonicalName);
      c.check('Rafa and Ines linked as people', want(people), people.join());
    },
  },
  {
    id: 'A11',
    // dina_details.md 3.1: "dina can add to memory, even if it is a normal convo and something feels like it should be remembered".
    title: 'Plain chat "remember this"',
    async run(c) {
      const r = await c.say(c.alonso, 'please remember that my locker code is 4471');
      c.check('the locker code was stored', (await personasHolding(c.alonso, 'locker')).length >= 1, r.reply.slice(0, 160));
    },
  },
  {
    id: 'A12',
    title: '/search scope',
    async run(c) {
      await c.say(c.alonso, "/remember Lena's flat is on the fourth floor of the blue building");
      await c.say(c.alonso, '/remember I take atorvastatin 20mg at night');
      const a = await c.say(c.alonso, '/search blue building');
      c.expectReply('/search finds the general fact', a.reply, /Found [1-9]/);
      const b = await c.say(c.alonso, '/search atorvastatin');
      c.expectReply('/search does not reach health', b.reply, /No results/i);
    },
  },
];
