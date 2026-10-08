/** C. Reminders (docs/REAL_LIFE_SCENARIOS.md). */

import { dayAt, type Ctx, type Scenario } from '../scenario';

import type { Dina } from '../client';

interface Reminder {
  id: string;
  message: string;
  due_at: number;
  status: string;
  recurring: string;
  created_at: number;
}

async function create(d: Dina, body: Record<string, unknown>): Promise<Reminder> {
  const r = await d.core('POST', '/v1/reminders', { body: { persona: 'general', kind: 'manual', ...body } });
  if (r.status >= 300) throw new Error(`create reminder ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return (r.body?.reminder ?? r.body) as Reminder;
}

async function get(d: Dina, id: string, persona = 'general'): Promise<Reminder | undefined> {
  return ((await d.reminders(persona)) as unknown as Reminder[]).find((r) => r.id === id);
}

async function waitFired(c: Ctx, id: string, ms: number): Promise<Reminder | undefined> {
  return c.eventually(async () => {
    const r = await get(c.alonso, id);
    return r !== undefined && r.status === 'fired' ? r : undefined;
  }, ms, 3_000);
}

export const areaC: Scenario[] = [
  {
    id: 'C1',
    title: 'A reminder fires',
    async run(c) {
      const r = await create(c.alonso, { message: `Take the bins out ${c.tag}`, due_at: Date.now() + 45_000 });
      c.check('fired within two minutes', (await waitFired(c, r.id, 120_000)) !== undefined, (await get(c.alonso, r.id))?.status ?? 'missing');
    },
  },
  {
    id: 'C2',
    title: 'Snooze a fired reminder',
    async run(c) {
      const r = await create(c.alonso, { message: `Stretch break ${c.tag}`, due_at: Date.now() + 30_000 });
      if ((await waitFired(c, r.id, 120_000)) === undefined) {
        c.check('fired first', false);
        return;
      }
      const s = await c.alonso.core('POST', `/v1/reminders/${r.id}/snooze`, { body: { snooze_ms: 3_600_000 } });
      c.check('snooze accepted', s.status < 300, String(s.status));
      const after = await get(c.alonso, r.id);
      c.check('due about an hour from now', after !== undefined && Math.abs(after.due_at - (Date.now() + 3_600_000)) < 5 * 60_000, after ? new Date(after.due_at).toString() : 'missing');
      await c.sleep(40_000);
      c.check('not fired again within the minute', (await get(c.alonso, r.id))?.status !== 'fired', (await get(c.alonso, r.id))?.status ?? '');
    },
  },
  {
    id: 'C3',
    title: 'Complete one, delete another',
    async run(c) {
      const a = await create(c.alonso, { message: `Renew parking permit ${c.tag}`, due_at: dayAt(3, 9) });
      const b = await create(c.alonso, { message: `Water the ferns ${c.tag}`, due_at: dayAt(4, 9) });
      await c.alonso.core('POST', `/v1/reminders/${a.id}/complete`);
      await c.alonso.core('DELETE', `/v1/reminders/${b.id}`);
      const done = await get(c.alonso, a.id);
      c.check('the completed one is marked completed', done !== undefined && done.status === 'completed', done?.status ?? 'missing');
      c.check('the deleted one is gone', (await get(c.alonso, b.id)) === undefined);
    },
  },
  {
    id: 'C4',
    title: 'A weekly reminder comes back',
    async run(c) {
      const r = await create(c.alonso, { message: `Team timesheet ${c.tag}`, due_at: dayAt(1, 17), recurring: 'weekly' });
      await c.alonso.core('POST', `/v1/reminders/${r.id}/complete`);
      const next = ((await c.alonso.reminders('general')) as unknown as Reminder[]).find((x) => x.id !== r.id && x.message === r.message);
      c.check('the next one exists', next !== undefined);
      c.check('a week later', next !== undefined && Math.abs(next.due_at - (r.due_at + 7 * 86_400_000)) < 2 * 3_600_000, next ? new Date(next.due_at).toString() : '');
    },
  },
  {
    id: 'C5',
    title: 'Reminders stay in their own vault',
    async run(c) {
      const h = await create(c.alonso, { message: `Blood test fasting ${c.tag}`, due_at: dayAt(5, 8), persona: 'health' });
      const g = await create(c.alonso, { message: `Return library books ${c.tag}`, due_at: dayAt(5, 18) });
      const health = (await c.alonso.reminders('health')).map((r) => r.id);
      const general = (await c.alonso.reminders('general')).map((r) => r.id);
      c.check('health reminder listed under health only', health.includes(h.id) && !general.includes(h.id));
      c.check('general reminder listed under general only', general.includes(g.id) && !health.includes(g.id));
    },
  },
  {
    id: 'C6',
    title: "A reminder's text uses what Dina knows",
    async run(c) {
      await c.say(c.alonso, '/remember Rosa loves orchids, especially white ones');
      const t0 = Date.now();
      await c.say(c.alonso, "/remember Rosa's birthday is next Friday");
      const made = (await c.alonso.allReminders()).filter((r) => r.created_at >= t0 && /Rosa/i.test(r.message));
      c.check('a birthday reminder exists', made.length >= 1);
      c.check('it mentions orchids', made.some((r) => /orchid/i.test(r.message)), made.map((r) => r.message).join(' | '));
    },
  },
  {
    id: 'C9',
    title: "dina_details 3.3/13.2: Emma's birthday makes two reminders",
    async run(c) {
      await c.say(c.alonso, '/remember Emma loves dinosaurs');
      const t0 = Date.now();
      const r = await c.say(c.alonso, "/remember Emma's birthday is on Nov 7th");
      c.expectReply('stored in General', r.reply, /general/i);
      const made = (await c.alonso.allReminders()).filter((x) => x.created_at >= t0);
      const on = (month: number, day: number) => made.filter((x) => new Date(x.due_at).getMonth() === month && new Date(x.due_at).getDate() === day);
      const before = on(10, 6);
      const dayOf = on(10, 7);
      c.check('a reminder the day before (Nov 6)', before.length >= 1, made.map((x) => `${new Date(x.due_at).toString()} ${x.message}`).join(' | '));
      c.check('the day-before reminder suggests a dinosaur gift', before.some((x) => /dinosaur/i.test(x.message)), before.map((x) => x.message).join(' | '));
      c.check('a reminder on the day (Nov 7)', dayOf.length >= 1);
    },
  },
  {
    id: 'C7',
    title: 'A repeating reminder from chat',
    mark: 'gap',
    async run(c) {
      const t0 = Date.now();
      await c.say(c.alonso, 'Remind me every Monday at 8am to water the plants.', { thread: c.thread('ask') });
      const made = (await c.alonso.allReminders()).filter((r) => r.created_at >= t0 && /plant/i.test(r.message));
      c.check('a weekly reminder', made.some((r) => (r as unknown as Reminder).recurring === 'weekly'), made.map((r) => `${r.message} (${(r as unknown as Reminder).recurring})`).join(' | '));
    },
  },
  {
    id: 'C8',
    title: 'Thirty reminders in a month',
    async run(c) {
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push((await create(c.alonso, { message: `Daily step goal ${c.tag} #${i + 1}`, due_at: dayAt(i + 1, 7) })).id);
      const listed = ((await c.alonso.reminders('general')) as unknown as Reminder[]).filter((r) => ids.includes(r.id));
      c.check('all thirty listed', listed.length === 30, String(listed.length));
      const dues = listed.map((r) => r.due_at);
      c.check('listed in due order', dues.every((d, i) => i === 0 || (dues[i - 1] as number) <= d));
    },
  },
];
