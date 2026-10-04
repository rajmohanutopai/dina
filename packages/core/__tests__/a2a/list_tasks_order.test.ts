/**
 * ListTasks (A2A §3.1.4): newest status first, a cursor that is a status
 * time, and `statusTimestampAfter` inclusive ("greater than or equal to this
 * value", a2a.proto v1.0.1). A view of a task can still change it (a round
 * that ended is settled; a result whose authority lapsed is ended), and that
 * moves its status time to now; every such change is made before the list is
 * counted, ordered and paged, so the order, the total and the pages agree
 * with the times the client reads.
 */

import {
  issueA2AGrant,
  ingressListTasks,
} from '../../src/a2a';
import { clearServiceConfigDurable } from '../../src/service/service_config';
import { WorkflowTaskState } from '../../src/workflow/domain';

import { InboundWorld, listing, resultOf, save, sentTask } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
  await save(listing({}), 'tram');
});
afterEach(() => iw.close());

interface Listed {
  id: string;
  status: { state: string; timestamp: string };
}

function list(params: Record<string, unknown> = {}): { tasks: Listed[]; totalSize: number; nextPageToken: string } {
  return resultOf(ingressListTasks(iw.rt, iw.request('ListTasks', params))) as unknown as {
    tasks: Listed[];
    totalSize: number;
    nextPageToken: string;
  };
}

/** A call to `skill`, run to its result at the current time. */
function finished(skill: string, route: string, extra: Record<string, unknown> = {}): string {
  const id = sentTask(iw.call({ skill, params: { route_id: route }, ...extra })).id as string;
  iw.runChild(id, { eta_minutes: 3 });
  return id;
}

const times = (tasks: Listed[]) => tasks.map((t) => Date.parse(t.status.timestamp));

/** Every page of the list, `size` at a time. */
function allPages(size: number): Listed[] {
  const seen: Listed[] = [];
  let token = '';
  for (let pages = 0; pages < 10; pages += 1) {
    const page = list({ pageSize: size, ...(token === '' ? {} : { pageToken: token }) });
    seen.push(...page.tasks);
    token = page.nextPageToken;
    if (token === '') return seen;
  }
  throw new Error('no last page');
}

describe('changes a view would make are made before the list (§3.1.4 order)', () => {
  it('a result whose listing went since: the list shows it first, at the time it ended, newest first throughout', async () => {
    const T = iw.world.clock;
    const older = finished('eta_query@bus', '1');
    iw.world.clock = T + 1_000;
    const newer = finished('eta_query@tram', '2');
    await clearServiceConfigDurable('bus');
    iw.world.clock = T + 2_000;
    const listed = list();
    expect(listed.tasks.map((t) => [t.id, t.status.state])).toEqual([
      [older, 'TASK_STATE_FAILED'],
      [newer, 'TASK_STATE_COMPLETED'],
    ]);
    expect(times(listed.tasks)).toEqual([T + 2_000, T + 1_000]);
    expect(listed.totalSize).toBe(2);
  });

  it('the same across pages of one: each task once, in order, none lost behind the cursor', async () => {
    const T = iw.world.clock;
    const older = finished('eta_query@bus', '1');
    iw.world.clock = T + 1_000;
    const newer = finished('eta_query@tram', '2');
    await clearServiceConfigDurable('bus');
    iw.world.clock = T + 2_000;
    const seen = allPages(1);
    expect(seen.map((t) => t.id)).toEqual([older, newer]);
    expect(times(seen)).toEqual([T + 2_000, T + 1_000]);
  });

  it('a result whose grant expired: ended before the list, and listed at the time it ended', async () => {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const T = iw.world.clock;
    const expiresAt = Math.floor(T / 1000) + 60;
    const issued = issueA2AGrant(iw.world.store, iw.grants, { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query', expires_at: expiresAt }, T);
    if (!issued.ok) throw new Error(issued.reason);
    const granted = finished('eta_query@private', '1', { grant_id: issued.grant.grantId });
    iw.world.clock = T + 1_000;
    const plain = finished('eta_query@tram', '2');
    iw.world.clock = (expiresAt + 1) * 1000;
    const listed = list();
    expect(listed.tasks.map((t) => [t.id, t.status.state])).toEqual([
      [granted, 'TASK_STATE_FAILED'],
      [plain, 'TASK_STATE_COMPLETED'],
    ]);
    expect(times(listed.tasks)[0]).toBe((expiresAt + 1) * 1000);
  });

  it('a round that ended with nothing noticing is settled before the list, and listed at the time it settled', () => {
    const T = iw.world.clock;
    const quiet = sentTask(iw.call({ skill: 'eta_query@bus', params: { route_id: '1' } })).id as string;
    // The round ends in the store alone: no hook ran, nothing settled it.
    iw.world.store.db.run(`UPDATE workflow_tasks SET state = ? WHERE id = ?`, [WorkflowTaskState.Failed, iw.childOf(quiet).id]);
    iw.world.clock = T + 1_000;
    const done = finished('eta_query@tram', '2');
    iw.world.clock = T + 2_000;
    const listed = list();
    expect(listed.tasks.map((t) => [t.id, t.status.state])).toEqual([
      [quiet, 'TASK_STATE_FAILED'],
      [done, 'TASK_STATE_COMPLETED'],
    ]);
    expect(times(listed.tasks)).toEqual([T + 2_000, T + 1_000]);
  });
});

describe('one time for the whole list, while the clock moves (round 6, CX-9)', () => {
  /** A grant-backed result and a newer public one; the grant's last second, in seconds. */
  async function grantAndPlain(): Promise<{ expiresAt: number }> {
    await save(listing({ discoverability: 'known_only', isDiscoverable: false }), 'private');
    const T = iw.world.clock;
    const expiresAt = Math.floor(T / 1000) + 60;
    const issued = issueA2AGrant(iw.world.store, iw.grants, { client_id: iw.clientId, service_rkey: 'private', capability: 'eta_query', expires_at: expiresAt }, T);
    if (!issued.ok) throw new Error(issued.reason);
    finished('eta_query@private', '1', { grant_id: issued.grant.grantId });
    iw.world.clock = T + 1_000;
    finished('eta_query@tram', '2');
    return { expiresAt };
  }

  const cursorOf = (token: string) => JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as [number, string];

  // The clock moves 1 ms at every reading, from `lead` ms before a second boundary
  // around the grant's expiry, so the grant runs out at a different point of the request each time.
  it.each(
    [0, 1].flatMap((second) => [1, 2, 3, 4, 5, 8, 13].map((lead) => [second, lead] as const)),
  )('the grant’s second +%i, %i ms before it: ordered by the times shown, and the cursor is the last task shown', async (second, lead) => {
    const { expiresAt } = await grantAndPlain();
    let t = (expiresAt + second) * 1000 - lead;
    iw.rt.a2a.nowMs = () => t++;
    const whole = list();
    expect(times(whole.tasks)).toEqual([...times(whole.tasks)].sort((a, b) => b - a));
    const first = list({ pageSize: 1 });
    expect(first.tasks).toHaveLength(1);
    const shown = first.tasks[0];
    if (shown === undefined) throw new Error('no task');
    expect(cursorOf(first.nextPageToken)).toEqual([Date.parse(shown.status.timestamp), shown.id]);
  });
});

describe('statusTimestampAfter is inclusive (a2a.proto v1.0.1)', () => {
  it('a task at exactly the boundary is listed, and counted; one before it is not', () => {
    const T = iw.world.clock;
    const before = finished('eta_query@bus', '1');
    iw.world.clock = T + 1_000;
    const atA = finished('eta_query@bus', '2');
    const atB = finished('eta_query@tram', '3');
    iw.world.clock = T + 2_000;
    const after = finished('eta_query@tram', '4');
    const from = (ms: number) => list({ statusTimestampAfter: new Date(ms).toISOString() });
    const at = from(T + 1_000);
    expect(at.tasks.map((t) => t.id).sort()).toEqual([after, atA, atB].sort());
    expect(at.totalSize).toBe(3);
    expect(from(T + 1_001).tasks.map((t) => t.id)).toEqual([after]);
    expect(from(T).tasks.map((t) => t.id).sort()).toEqual([after, atA, atB, before].sort());
  });
});
