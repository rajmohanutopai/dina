/** B. Asking (docs/REAL_LIFE_SCENARIOS.md). Each plants its own facts first. */

import { dayAt, type Scenario } from '../scenario';

export const areaB: Scenario[] = [
  {
    id: 'B1',
    title: 'Recall a fact',
    async run(c) {
      await c.say(c.alonso, '/remember Kai is allergic to sesame');
      const before = (await c.alonso.tasks('approval', 'pending_approval')).length;
      const q = 'what is Kai allergic to?';
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('says sesame', q, r.reply, 'The reply says Kai is allergic to sesame.');
      c.check('no approval asked of the owner', (await c.alonso.tasks('approval', 'pending_approval')).length === before);
    },
  },
  {
    id: 'B2',
    title: 'Joining facts across vaults',
    async run(c) {
      await c.say(c.alonso, '/remember my fasting glucose was 7.2 at the check last week');
      await c.say(c.alonso, '/remember my monthly budget for fitness is £60');
      const q = 'can I afford a gym membership, and would going help my sugar levels?';
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('uses the budget', q, r.reply, 'The reply refers to the £60 monthly fitness budget.');
      await c.judge('uses the glucose reading', q, r.reply, 'The reply refers to the fasting glucose reading (7.2) or to blood sugar from the stored check.');
    },
  },
  {
    id: 'B3',
    title: 'An honest "I don\'t know"',
    async run(c) {
      const q = "What's Sancho's shoe size?";
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('admits it does not know', q, r.reply, 'The reply says it does not know or has nothing stored about this, and does NOT state any shoe size.');
    },
  },
  {
    id: 'B4',
    title: 'General knowledge',
    async run(c) {
      const r = await c.say(c.alonso, "What's the capital of Portugal?", { thread: c.thread('ask') });
      c.expectReply('says Lisbon', r.reply, /Lisbon/i);
    },
  },
  {
    id: 'B5',
    title: 'A follow-up in the same conversation',
    async run(c) {
      await c.say(c.alonso, "/remember Nora's pickup is at 4:30");
      await c.say(c.alonso, "/remember Nora's teacher is Mr Diaz");
      const t = c.thread('ask');
      await c.say(c.alonso, "When is Nora's pickup?", { thread: t });
      const q = 'and who is her teacher?';
      const r = await c.say(c.alonso, q, { thread: t });
      await c.judge('resolves "her" to Nora', `(earlier in the chat: "When is Nora's pickup?") ${q}`, r.reply, "The reply says Nora's teacher is Mr Diaz.");
    },
  },
  {
    id: 'B6',
    title: 'A gift idea from memory',
    async run(c) {
      await c.say(c.alonso, '/remember Bruno loves cold brew coffee and has a new espresso machine');
      const q = 'what should I get Bruno for his birthday?';
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('draws on the stored likes', q, r.reply, 'The reply suggests something connected to coffee, cold brew or his espresso machine.');
    },
  },
  {
    id: 'B7',
    title: 'A reminder by asking',
    async run(c) {
      const t0 = Date.now();
      await c.say(c.alonso, 'Remind me to call the plumber tomorrow at 9am.', { thread: c.thread('ask') });
      const want = dayAt(1, 9);
      const hit = (await c.alonso.allReminders()).find((r) => r.created_at >= t0 && /plumber/i.test(r.message));
      c.check('a plumber reminder exists', hit !== undefined);
      c.check('due tomorrow at 9:00', hit !== undefined && Math.abs(hit.due_at - want) < 60 * 60_000, hit ? new Date(hit.due_at).toString() : '');
    },
  },
  {
    id: 'B8',
    title: 'A reminder in the past',
    async run(c) {
      const t0 = Date.now();
      const q = 'Remind me to call Sancho yesterday at 5pm.';
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      const made = (await c.alonso.allReminders()).filter((x) => x.created_at >= t0 && x.due_at < Date.now());
      c.check('no reminder in the past', made.length === 0, made.map((x) => new Date(x.due_at).toString()).join(' | '));
      await c.judge('says the time has passed', q, r.reply, 'The reply points out that the time is in the past (or asks for a future time) rather than claiming a reminder was set for yesterday.');
    },
  },
  {
    id: 'B9',
    title: 'Two people with one name',
    async run(c) {
      await c.say(c.alonso, '/remember Alex Chen said the Porto trip should be in May');
      await c.say(c.alonso, '/remember Alex Romero said the Porto trip is too expensive');
      const q = 'What did Alex say about the Porto trip?';
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('does not mix the two Alexes', q, r.reply, 'The reply either asks which Alex is meant, or names both Alex Chen and Alex Romero with what each said; it does not merge them into one person.');
    },
  },
  {
    id: 'B10',
    title: 'A product question with no reviews',
    async run(c) {
      const q = 'Which ergonomic chair under £300 is best?';
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('no unverified product pick', q, r.reply, 'The reply does not present a specific chair model as the best one from its own general knowledge; it says it has no trusted reviews or network data for this (it may ask what matters to the user).');
    },
  },
  {
    id: 'B11',
    title: 'A question with only a pronoun',
    async run(c) {
      const q = 'Is she still allergic?';
      const r = await c.say(c.alonso, q, { thread: c.thread('fresh') });
      await c.judge('asks who', q, r.reply, 'The reply asks who "she" is, or says it cannot tell who is meant; it does not pick one person and answer as if it knew.');
    },
  },
  {
    id: 'B13',
    title: "dina_details 13.1/13.2: my daughter's name is Emma",
    async run(c) {
      const r1 = await c.say(c.alonso, '/remember My daughters name is Emma');
      const r2 = await c.say(c.alonso, '/remember My daughter loves dinosaurs');
      c.expectReply('first stored in General', r1.reply, /general/i);
      c.expectReply('second stored in General', r2.reply, /general/i);
      const q = '/ask What does Emma like?';
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('Emma loves dinosaurs', q, r.reply, 'The reply says Emma loves dinosaurs (linking "my daughter" to Emma).');
    },
  },
  {
    id: 'B12',
    title: 'Several questions at once',
    async run(c) {
      await c.say(c.alonso, '/remember my eye test recheck is on 2 December');
      await c.say(c.alonso, '/remember home insurance renews on 9 January');
      await c.say(c.alonso, "/remember Ivo's swimming lesson is on Saturdays at 10");
      const q = "When's my eye test recheck, when does home insurance renew, and when is Ivo's swimming lesson?";
      const r = await c.say(c.alonso, q, { thread: c.thread('ask') });
      await c.judge('answers all three', q, r.reply, 'The reply gives all three: the eye test recheck on 2 December, home insurance renewal on 9 January, and the swimming lesson on Saturdays at 10.');
    },
  },
];
