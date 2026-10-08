/**
 * I. Services (docs/REAL_LIFE_SCENARIOS.md). Albert publishes a public
 * listing (bus ETAs, a dentist's appointment book) at a place no other test
 * listing uses (Tórshavn harbour), so Alonso's location search finds only him.
 * Albert's answers come from a paired runner agent here (the stand-in for the
 * Python agent-daemon): it claims each `service_query_execution` task and
 * completes it with a result of the capability's schema.
 */

import { capabilitySchemaHash, listCapabilities } from '@dina/core';

import { Agent, type Dina } from '../client';
import { startNode, stopNode } from '../fleet';

import type { Ctx, Scenario } from '../scenario';

const PLACE = { name: 'Tórshavn harbour', lat: 62.0107, lng: -6.7741, radiusKm: 15 };
const RUNNER = 'albert_runner';

function tomorrowIso(): string {
  const d = new Date(Date.now() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Albert's runner: claims and answers his service tasks while it runs. */
class AlbertRunner {
  readonly bookings: { time: string; date?: string }[] = [];
  readonly seen: string[] = [];
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly agent: Agent) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const r = await this.agent.call('POST', '/v1/workflow/tasks/claim', { body: { lease_seconds: 120, runner_filter: RUNNER } }).catch(() => ({ status: 0, body: null }));
        if (r.status !== 200 || r.body === null) {
          await new Promise((x) => setTimeout(x, 1_000));
          continue;
        }
        const task = r.body as { id: string; claim_id: string; payload: string };
        const p = JSON.parse(task.payload) as { capability: string; params: Record<string, unknown> };
        this.seen.push(p.capability);
        await this.agent.call('POST', `/v1/workflow/tasks/${encodeURIComponent(task.id)}/complete`, {
          body: { result: JSON.stringify(this.answer(p.capability, p.params)), claim_id: task.claim_id },
        });
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private answer(capability: string, params: Record<string, unknown>): Record<string, unknown> {
    if (capability === 'eta_query')
      return { status: 'on_route', eta_minutes: 7, route_name: String(params.route_id ?? '42'), stop_name: 'Harbour', message: 'Bus 42 is about 7 minutes away.' };
    if (capability === 'appointment_availability')
      return { status: 'ok', date: tomorrowIso(), slots: [{ time: '16:00', date: tomorrowIso() }, { time: '17:30', date: tomorrowIso() }] };
    if (capability === 'appointment_book') {
      const time = String(params.time ?? '');
      this.bookings.push({ time, ...(typeof params.date === 'string' ? { date: params.date } : {}) });
      return { status: 'confirmed', time, date: typeof params.date === 'string' ? params.date : tomorrowIso(), service: 'check-up', message: `Booked for ${time}.` };
    }
    return { status: 'unknown', message: 'not offered' };
  }
}

function schemaOf(name: string) {
  const cap = listCapabilities().find((c) => c.name === name);
  if (cap === undefined) throw new Error(`no capability ${name}`);
  const schemaHash = capabilitySchemaHash({ params: cap.paramsSchema, result: cap.resultSchema, description: cap.description });
  return { cap, schemaHash };
}

function listing(policy: { availability: 'auto' | 'review' } = { availability: 'auto' }): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  const capabilitySchemas: Record<string, unknown> = {};
  const caps: [string, 'auto' | 'review', string][] = [
    ['eta_query', 'auto', 'transit'],
    ['appointment_availability', policy.availability, 'appointments'],
    ['appointment_book', 'review', 'appointments'],
  ];
  for (const [name, responsePolicy, category] of caps) {
    const { cap, schemaHash } = schemaOf(name);
    capabilities[name] = { mcpServer: RUNNER, mcpTool: name, responsePolicy, category, schemaHash };
    capabilitySchemas[name] = { params: cap.paramsSchema, result: cap.resultSchema, schemaHash, description: cap.description, defaultTtlSeconds: cap.defaultTtlSeconds };
  }
  return {
    isDiscoverable: true,
    discoverability: 'public',
    name: 'Albert — Harbour bus and dentist',
    description: 'Bus 42 arrival times at Tórshavn harbour, and dentist appointments.',
    status: 'active',
    capabilities,
    capabilitySchemas,
    serviceArea: { lat: PLACE.lat, lng: PLACE.lng, radiusKm: PLACE.radiusKm },
  };
}

let runner: AlbertRunner | null = null;
let published = false;
/** Albert, once he has published, so the run can withdraw his listings. */
let publisher: Ctx['albert'] | null = null;

/** Publish Albert's listing once, wait for test-appview to index it, start his runner. */
async function provider(c: Ctx): Promise<AlbertRunner> {
  if (runner === null) runner = new AlbertRunner(await Agent.pair(c.albert, 'albert-runner'));
  runner.start();
  if (!published) {
    const r = await c.albert.core('PUT', '/v1/service/config', { body: listing() });
    if (r.status >= 300) throw new Error(`publish listing ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    publisher = c.albert;
    const indexed = await c.eventually(async () => {
      const res = await fetch(`https://test-appview.dinakernel.com/xrpc/com.dinakernel.service.search?capability=eta_query&lat=${PLACE.lat}&lng=${PLACE.lng}&radiusKm=20`).catch(() => null);
      const text = res === null ? '' : await res.text();
      return text.includes(c.albert.did) ? true : undefined;
    }, 180_000, 5_000);
    if (indexed !== true) throw new Error('test-appview did not index Albert within 3 minutes');
    published = true;
  }
  return runner;
}

/*
 * Service scenarios ask in the `main` thread: Core posts every service result
 * to `main` (a card asked in another thread stays pending there; noted in
 * docs/REAL_LIFE_SCENARIOS.md findings).
 */

/** Service-query tasks on Alonso created after `since`. */
async function queries(d: Dina, since: number): Promise<{ id: string; state: string; created_at?: number }[]> {
  const out: { id: string; state: string; created_at?: number }[] = [];
  for (const state of ['created', 'queued', 'running', 'completed', 'failed', 'expired', 'cancelled'])
    for (const t of await d.tasks('service_query', state)) if (Number((t as { created_at?: number }).created_at ?? Date.now()) >= since - 1_000) out.push(t as never);
  return out;
}

function cardOf(added: { metadata?: Record<string, unknown> }[]): Record<string, unknown> | undefined {
  return added.map((m) => m.metadata?.lifecycle as Record<string, unknown> | undefined).find((l) => l?.kind === 'service_query');
}

/**
 * How long a service turn may take to settle. A read-only query may move to
 * up to two more providers when one goes quiet (REAL_LIFE_FIXES §9), each
 * with its own deadline, so a card can stay pending for several minutes.
 */
const SERVICE_WAIT_MS = 480_000;

export const areaI: Scenario[] = [
  {
    id: 'I1',
    title: 'When is the bus?',
    async run(c) {
      await provider(c);
      const t0 = Date.now();
      const r = await c.say(c.alonso, `When does bus 42 reach ${PLACE.name}?`, { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      const card = cardOf(r.added);
      c.check('a service query went out', (await queries(c.alonso, t0)).length >= 1);
      c.check('the card resolved', card?.status === 'resolved', JSON.stringify(card ?? {}).slice(0, 200));
      await c.judge('gives the 7 minutes', `When does bus 42 reach ${PLACE.name}?`, `${r.reply}\n${JSON.stringify(card?.result ?? '')}`, 'Dina tells the user bus 42 is about 7 minutes away (from the reply text or the result card).');
    },
  },
  {
    id: 'I2',
    title: 'Any dentist slots tomorrow?',
    async run(c) {
      await provider(c);
      const q = `Any dentist slots tomorrow at Albert's practice near ${PLACE.name}?`;
      const r = await c.say(c.alonso, q, { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      const card = cardOf(r.added);
      c.check('the card resolved', card?.status === 'resolved', JSON.stringify(card ?? {}).slice(0, 200));
      c.check('the slots came back', /16:00/.test(JSON.stringify(card ?? {}) + r.reply), r.reply.slice(0, 160));
    },
  },
  {
    id: 'I3',
    title: 'Book the 4pm (Albert reviews bookings)',
    async run(c) {
      const run = await provider(c);
      const before = run.bookings.length;
      const t = 'main';
      await c.say(c.alonso, `Any dentist slots tomorrow at Albert's practice near ${PLACE.name}?`, { thread: t, timeoutMs: SERVICE_WAIT_MS });
      const ask = c.say(c.alonso, 'Book the 4pm one please.', { thread: t, timeoutMs: SERVICE_WAIT_MS });
      const approval = await c.eventually(async () => (await c.albert.tasks('approval', 'pending_approval'))[0], 120_000);
      c.check('Albert gets a review card for the booking', approval !== undefined);
      if (approval !== undefined) await c.albert.core('POST', `/v1/workflow/tasks/${approval.id}/approve`, { body: {} });
      const r = await ask;
      c.check('booked once on Albert', run.bookings.length === before + 1, JSON.stringify(run.bookings));
      c.check('the booking is for 16:00', run.bookings.slice(before).some((b) => /16:00|4 ?pm/i.test(b.time)), JSON.stringify(run.bookings.slice(before)));
      await c.judge('Alonso is told it is booked', 'Book the 4pm one please.', `${r.reply}\n${JSON.stringify(cardOf(r.added)?.result ?? '')}`, 'Dina tells the user the 4pm appointment is confirmed.');
    },
  },
  {
    id: 'I4',
    title: 'Albert reviews availability questions too',
    async run(c) {
      await provider(c);
      await c.albert.core('PUT', '/v1/service/config', { body: listing({ availability: 'review' }) });
      const ask = c.say(c.alonso, `Is Albert's dentist free on Friday near ${PLACE.name}?`, { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      const approval = await c.eventually(async () => (await c.albert.tasks('approval', 'pending_approval'))[0], 120_000);
      c.check('Albert gets a review card', approval !== undefined);
      if (approval !== undefined) await c.albert.core('POST', `/v1/workflow/tasks/${approval.id}/approve`, { body: {} });
      const r = await ask;
      c.check('the answer arrives after Albert approves', cardOf(r.added)?.status === 'resolved', JSON.stringify(cardOf(r.added) ?? {}).slice(0, 200));
      await c.albert.core('PUT', '/v1/service/config', { body: listing() });
    },
  },
  {
    id: 'I5',
    title: 'Albert declines a booking',
    async run(c) {
      await provider(c);
      const t = 'main';
      await c.say(c.alonso, `Any dentist slots tomorrow at Albert's practice near ${PLACE.name}?`, { thread: t, timeoutMs: SERVICE_WAIT_MS });
      const ask = c.say(c.alonso, 'Book the 5:30 one.', { thread: t, timeoutMs: SERVICE_WAIT_MS });
      const approval = await c.eventually(async () => (await c.albert.tasks('approval', 'pending_approval'))[0], 120_000);
      c.check('Albert gets a review card', approval !== undefined);
      if (approval !== undefined)
        await c.albert.core('POST', '/v1/service/respond', { body: { task_id: approval.id, response_body: { status: 'unavailable', error: 'denied_by_operator' } } });
      const r = await ask;
      await c.judge('Alonso is told it was not booked', 'Book the 5:30 one.', `${r.reply}\n${JSON.stringify(cardOf(r.added) ?? '')}`, 'Dina tells the user the booking was not made (declined or unavailable); it does not claim it is confirmed.');
    },
  },
  {
    id: 'I6',
    title: 'Nobody offers it',
    async run(c) {
      const run = await provider(c);
      const before = run.seen.length;
      const q = `Book me a seat at the sports centre in ${PLACE.name} for Saturday.`;
      const r = await c.say(c.alonso, q, { thread: 'main', timeoutMs: SERVICE_WAIT_MS });
      c.check('Albert (a bus and dentist) is not asked', run.seen.length === before, run.seen.slice(before).join());
      await c.judge('says nobody offers this', q, r.reply, 'Dina says it found no service or provider for booking a sports-centre seat; it does not claim a booking.');
    },
  },
  {
    id: 'I7',
    title: 'A service only friends can find',
    async run(c) {
      const { cap, schemaHash } = schemaOf('eta_query');
      const put = await c.albert.core('PUT', '/v1/service/config/albert_private', {
        body: {
          isDiscoverable: false,
          discoverability: 'known_only',
          name: 'Albert private shuttle',
          status: 'active',
          capabilities: { eta_query: { mcpServer: RUNNER, mcpTool: 'eta_query', responsePolicy: 'auto', category: 'transit', schemaHash } },
          capabilitySchemas: { eta_query: { params: cap.paramsSchema, result: cap.resultSchema, schemaHash, description: cap.description, defaultTtlSeconds: cap.defaultTtlSeconds } },
        },
      });
      c.check('the private listing saves', put.status < 300, `${put.status} ${JSON.stringify(put.body).slice(0, 160)}`);
      // known_only is for people Albert knows and grants (dina_details.md): Albert adds Alonso first.
      await c.albert.addContact(c.alonso.did, 'Alonso');
      // Core refuses an offer from anyone who is not a contact (receive_pipeline 7b), so Alonso adds Albert too.
      await c.alonso.addContact(c.albert.did, 'Albert');
      const offer = await c.albert.core('POST', '/v1/service/offer', { body: { to_did: c.alonso.did, rkey: 'albert_private', capability: 'eta_query' } });
      c.check('Albert offers it to Alonso', offer.status < 300 && typeof offer.body?.grant_id === 'string', `${offer.status} ${JSON.stringify(offer.body).slice(0, 160)}`);
      const seen = await c.eventually(async () => {
        const o = await c.alonso.core('GET', '/v1/service/offers', { query: { provider_did: c.albert.did, capability: 'eta_query' } });
        return JSON.stringify(o.body).includes('albert_private') || JSON.stringify(o.body).includes(String(offer.body?.grant_id ?? '~')) ? true : undefined;
      }, 90_000);
      c.check('Alonso receives the offer', seen === true);
      const sancho = await c.sancho.core('GET', '/v1/service/offers', { query: { provider_did: c.albert.did, capability: 'eta_query' } });
      c.check('Sancho has no such offer', !JSON.stringify(sancho.body).includes('albert_private'));
    },
  },
  {
    id: 'I9',
    title: 'dina_details known_only: a forwarded grant is refused',
    async run(c) {
      await provider(c);
      // Alonso's grant from I7; Sancho tries to use it.
      const offers = await c.alonso.core('GET', '/v1/service/offers', { query: { provider_did: c.albert.did, capability: 'eta_query' } });
      const text = JSON.stringify(offers.body);
      const grant = /"grant_?[iI]d":"([^"]+)"/.exec(text)?.[1] ?? '';
      const uri = /"service_?[uU]ri":"([^"]+)"/.exec(text)?.[1] ?? '';
      c.check('Alonso holds a grant to forward', grant !== '', text.slice(0, 160));
      if (grant === '') return;
      await c.sancho.addContact(c.albert.did, 'Albert');
      const { schemaHash } = schemaOf('eta_query');
      const q = await c.sancho.core('POST', '/v1/service/query', {
        body: { to_did: c.albert.did, capability: 'eta_query', query_id: `fwd-${c.tag}`, ttl_seconds: 60, params: { route_id: '42' }, schema_hash: schemaHash, grant_id: grant, ...(uri !== '' ? { service_uri: uri } : {}) },
      });
      const taskId = String(q.body?.task_id ?? '');
      const final = await c.eventually(async () => {
        for (const state of ['completed', 'failed', 'expired'])
          if ((await c.sancho.tasks('service_query', state)).some((t) => t.id === taskId)) return state;
        return undefined;
      }, 120_000, 3_000);
      const answered = final === 'completed' && JSON.stringify((await c.sancho.tasks('service_query', 'completed')).find((t) => t.id === taskId) ?? {}).includes('eta_minutes');
      c.check("Albert does not answer Sancho with Alonso's grant", !answered, `final state ${final ?? 'none'}`);
    },
  },
  {
    id: 'I8',
    title: 'The provider is offline',
    async run(c) {
      await provider(c);
      stopNode('albert');
      try {
        const q = `When does bus 42 reach ${PLACE.name}?`;
        const r = await c.say(c.alonso, q, { thread: 'main', timeoutMs: 420_000 });
        const card = cardOf(r.added);
        c.check('the card ends (failed or expired), not stuck', card !== undefined && ['failed', 'expired'].includes(String(card.status)), JSON.stringify(card ?? {}).slice(0, 200));
        await c.judge('says it could not get an answer', q, `${r.reply}\n${JSON.stringify(card ?? '')}`, 'Dina makes clear the provider did not answer (failed, expired, unreachable); it does not invent an arrival time.');
      } finally {
        await startNode('albert');
      }
    },
  },
];

/**
 * Stop Albert's runner at the end of a run, and withdraw his listings. Each
 * `fleet up` makes new identities, so a listing left behind is a provider
 * that will never answer again — and the shared AppView keeps ranking it.
 */
export async function stopServices(): Promise<void> {
  await runner?.stop();
  if (publisher !== null) {
    for (const rkey of ['self', 'albert_private']) {
      await publisher.core('DELETE', `/v1/service/config/${rkey}`).catch(() => undefined);
    }
  }
}
