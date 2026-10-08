/**
 * J. Group plans (docs/REAL_LIFE_SCENARIOS.md). Sancho and Albert each answer
 * availability from their own notes: a `talk` listing whose capability is
 * answered by their own Brain (an instruction, no runner), offered to Alonso.
 */

import type { Dina } from '../client';
import type { Ctx, Scenario } from '../scenario';

let guestsReady = false;

async function makeGuest(c: Ctx, guest: Dina, freeNote: string): Promise<void> {
  await c.say(guest, `/remember ${freeNote}`, { thread: c.thread(`${guest.name}-notes`) });
  const put = await guest.core('PUT', '/v1/service/config/availability', {
    body: {
      name: 'My availability',
      isDiscoverable: false,
      discoverability: 'known_only',
      surface: 'talk',
      defaultOfferable: true,
      status: 'active',
      capabilities: {
        availability_coordination: {
          instruction: 'Answer meeting-time requests from my calendar notes. Accept the times my notes say I am free; offer a counter time otherwise.',
          responsePolicy: 'auto',
          category: 'appointments',
        },
      },
    },
  });
  if (put.status >= 300) throw new Error(`${guest.name}: availability listing ${put.status} ${JSON.stringify(put.body).slice(0, 160)}`);
  const offer = await guest.core('POST', '/v1/service/offer', { body: { to_did: c.alonso.did, rkey: 'availability', capability: 'availability_coordination' } });
  if (offer.status >= 300) throw new Error(`${guest.name}: offer ${offer.status} ${JSON.stringify(offer.body).slice(0, 160)}`);
}

async function guests(c: Ctx): Promise<void> {
  if (guestsReady) return;
  // Guests must be mutual contacts with the organiser (dina_details.md 3.5).
  await c.alonso.addContact(c.albert.did, 'Albert');
  await c.albert.addContact(c.alonso.did, 'Alonso');
  await makeGuest(c, c.sancho, 'I am free Thursday evening from 6pm, and busy all day Friday');
  await makeGuest(c, c.albert, 'I am free Thursday after 7pm; Friday evening is fine too');
  guestsReady = true;
}

async function newestPlan(c: Ctx, since: number, intent: RegExp): Promise<{ id: string; state: string; body: any } | undefined> {
  const h = await c.alonso.core('GET', '/v1/coordination/handles');
  const plans = (h.body?.plans ?? []) as { plan_id: string; intent: string; updated_at: number }[];
  const fresh = plans.filter((x) => x.updated_at >= since - 1_000 && intent.test(x.intent)).sort((x, y) => y.updated_at - x.updated_at)[0];
  if (fresh === undefined) return undefined;
  const p = await c.alonso.core('GET', `/v1/coordination/plans/${encodeURIComponent(fresh.plan_id)}`);
  return { id: fresh.plan_id, state: String(p.body?.state ?? p.body?.plan?.state ?? ''), body: p.body };
}

let planId = '';

export const areaJ: Scenario[] = [
  {
    id: 'J1',
    title: 'Dinner for three',
    async run(c) {
      await guests(c);
      const t0 = Date.now();
      const q = 'Plan dinner with Sancho and Albert — Thursday at 7pm or Friday at 8pm, whichever works.';
      const r = await c.say(c.alonso, q, { thread: c.thread('plan'), timeoutMs: 240_000 });
      const plan = await c.eventually(() => newestPlan(c, t0, /dinner/i), 60_000);
      c.check('a plan was made', plan !== undefined, r.reply.slice(0, 160));
      if (plan === undefined) return;
      planId = plan.id;
      const spokes = JSON.stringify(plan.body);
      c.check('both guests asked', spokes.includes(c.sancho.did) && spokes.includes(c.albert.did));
      const folded = await c.eventually(async () => {
        const p = await c.alonso.core('GET', `/v1/coordination/plans/${encodeURIComponent(plan.id)}`);
        const s = String(p.body?.state ?? p.body?.plan?.state ?? '');
        return ['folded', 'confirming', 'settled'].includes(s) ? p.body : undefined;
      }, 360_000, 5_000);
      c.check('both answered within the window', folded !== undefined);
      c.check('Thursday 7pm suits both', /thu|7 ?pm|19:00/i.test(JSON.stringify(folded ?? {})), JSON.stringify(folded ?? {}).slice(0, 240));
    },
  },
  {
    id: 'J2',
    title: 'Two people called Sam',
    async run(c) {
      await c.alonso.addContact('did:plc:samaaaaaaaaaaaaaaaaaaaaa', 'Sam Okafor');
      await c.alonso.addContact('did:plc:sambbbbbbbbbbbbbbbbbbbbb', 'Sam Lindqvist');
      const q = 'Plan lunch with Sam next Tuesday at 1pm.';
      const r = await c.say(c.alonso, q, { thread: c.thread('plan'), timeoutMs: 180_000 });
      await c.judge('asks which Sam', q, r.reply, 'Dina asks which Sam is meant (or names both and asks the user to pick) instead of picking one.');
    },
  },
  {
    id: 'J3',
    title: 'A guest who is not a contact',
    async run(c) {
      const q = 'Plan lunch with Zorro on Wednesday at noon.';
      const r = await c.say(c.alonso, q, { thread: c.thread('plan'), timeoutMs: 180_000 });
      await c.judge('says Zorro is unknown', q, r.reply, 'Dina says it does not know Zorro (not a contact) and does not start a plan with an unknown person.');
    },
  },
  {
    id: 'J4',
    title: 'Choosing the time',
    async run(c) {
      if (planId === '') {
        c.check('a plan from J1 to choose on', false);
        return;
      }
      const p = await c.alonso.core('GET', `/v1/coordination/plans/${encodeURIComponent(planId)}`);
      const slot = (p.body?.fold?.best ?? p.body?.plan?.fold?.best ?? p.body?.candidates?.[0] ?? p.body?.plan?.candidates?.[0]) as unknown;
      const r = await c.alonso.coreOwner('POST', `/v1/coordination/plans/${encodeURIComponent(planId)}/choose`, { slot });
      c.check('choose accepted', r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      const settled = await c.eventually(async () => {
        const x = await c.alonso.core('GET', `/v1/coordination/plans/${encodeURIComponent(planId)}`);
        return ['confirming', 'settled'].includes(String(x.body?.state ?? x.body?.plan?.state)) ? true : undefined;
      }, 180_000, 5_000);
      c.check('the plan settles', settled === true);
    },
  },
  {
    id: 'J5',
    title: 'Calling a plan off',
    async run(c) {
      await guests(c);
      const t0 = Date.now();
      await c.say(c.alonso, 'Plan a coffee with Sancho on Saturday at 10am.', { thread: c.thread('plan'), timeoutMs: 180_000 });
      const plan = await c.eventually(() => newestPlan(c, t0, /coffee/i), 60_000);
      c.check('a plan was made', plan !== undefined);
      if (plan === undefined) return;
      const r = await c.alonso.coreOwner('POST', `/v1/coordination/plans/${encodeURIComponent(plan.id)}/abandon`, {});
      c.check('abandon accepted', r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      const p = await c.alonso.core('GET', `/v1/coordination/plans/${encodeURIComponent(plan.id)}`);
      c.check('state abandoned', String(p.body?.state ?? p.body?.plan?.state) === 'abandoned', JSON.stringify(p.body).slice(0, 160));
    },
  },
];
