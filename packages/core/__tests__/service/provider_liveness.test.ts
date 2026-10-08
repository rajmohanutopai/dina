/**
 * REAL_LIFE_FIXES §9 — choosing a live provider: an outcome record per
 * provider, failover for read-only queries within one card, and an
 * unknown-outcome card for a request that acts.
 */

import { setFailoverSender, readFallbacks } from '../../src/service/provider_failover';
import {
  BASE_EJECTION_MS,
  providerStanding,
  recordProviderOutcome,
  resetProviderOutcomes,
  setProviderLinkProbe,
} from '../../src/service/provider_outcomes';
import { WorkflowTaskKind, WorkflowTaskState } from '../../src/workflow/domain';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService } from '../../src/workflow/service';

const A = 'did:plc:providera';
const B = 'did:plc:providerb';
const C = 'did:plc:providerc';
let linkUp = true;

beforeEach(() => {
  resetProviderOutcomes();
  linkUp = true;
  setProviderLinkProbe(() => linkUp);
});
afterEach(() => {
  setProviderLinkProbe(null);
  setFailoverSender(null);
});

describe('outcome record', () => {
  const expire = (did: string, now: number) => recordProviderOutcome(did, 'expired', { handedOff: true, now });

  it('three expiries in a row eject; the ejection then lapses', () => {
    expire(A, 1);
    expire(A, 2);
    expect(providerStanding(A, 3).ejected).toBe(false);
    expire(A, 3);
    expect(providerStanding(A, 4).ejected).toBe(true);
    expect(providerStanding(A, 3 + BASE_EJECTION_MS + 1).ejected).toBe(false);
  });

  it('a failed probe after an ejection ejects again at once, for twice as long', () => {
    [1, 2, 3].forEach((t) => expire(A, t));
    const after = 3 + BASE_EJECTION_MS + 1;
    expire(A, after);
    expect(providerStanding(A, after + 1).until).toBe(after + 2 * BASE_EJECTION_MS);
  });

  it('one answer clears the count and the ejection', () => {
    [1, 2, 3].forEach((t) => expire(A, t));
    recordProviderOutcome(A, 'answered', { handedOff: true, now: 5 });
    expect(providerStanding(A, 6).ejected).toBe(false);
    expire(A, 7);
    expire(A, 8);
    expect(providerStanding(A, 9).ejected).toBe(false);
  });

  it('an error reply is still a reply', () => {
    [1, 2].forEach((t) => expire(A, t));
    recordProviderOutcome(A, 'error', { handedOff: true, now: 3 });
    expire(A, 4);
    expect(providerStanding(A, 5).ejected).toBe(false);
  });

  it('a local outage ejects nobody', () => {
    linkUp = false;
    [1, 2, 3, 4].forEach((t) => expire(A, t));
    expect(providerStanding(A, 5).ejected).toBe(false);
  });

  it('a query never handed off does not count', () => {
    [1, 2, 3].forEach((t) => recordProviderOutcome(A, 'expired', { handedOff: false, now: t }));
    expect(providerStanding(A, 4).ejected).toBe(false);
  });
});

describe('fallbacks from a request', () => {
  it('keeps well-formed public candidates, at most two, never the chosen one', () => {
    const out = readFallbacks(
      [{ to_did: A }, { to_did: B, service_uri: 'at://b/x' }, { to_did: 'nope' }, { to_did: B }, { to_did: C }, { to_did: 'did:plc:d' }],
      A,
    );
    expect(out).toEqual([{ to_did: B, service_uri: 'at://b/x' }, { to_did: C }]);
  });
});

describe('failover and unknown outcomes', () => {
  function setup() {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({ repository: repo });
    const sent: { to: string; body: Record<string, unknown> }[] = [];
    setFailoverSender(async (to, _type, body) => {
      sent.push({ to, body });
    });
    return { repo, service, sent };
  }
  function query(service: WorkflowService, capability: string, fallbacks: unknown[], nowSec: number) {
    service.create({
      id: `sq-${capability}`,
      kind: WorkflowTaskKind.ServiceQuery,
      description: 'q',
      payload: JSON.stringify({
        to_did: A,
        capability,
        params: { route: '42' },
        query_id: `q-${capability}`,
        ttl_seconds: 60,
        service_name: 'Provider A',
        fallbacks,
      }),
      expiresAtSec: nowSec + 60,
      origin: 'api',
    });
    service.store().transition(`sq-${capability}`, WorkflowTaskState.Created, WorkflowTaskState.Running, 1);
    return `sq-${capability}`;
  }

  it('a read-only query moves to the next provider on the same task, and the card says so', () => {
    const { repo, service, sent } = setup();
    const id = query(service, 'eta_query', [{ to_did: B, service_name: 'Provider B', schema_hash: 'h-b' }], 1000);
    service.expireTasks(1061, 1_061_000);
    const task = repo.getById(id)!;
    expect(task.status).toBe('running');
    expect(JSON.parse(task.payload)).toMatchObject({ to_did: B, attempts: [A], fallbacks: [] });
    expect(sent).toEqual([
      { to: B, body: { query_id: 'q-eta_query', capability: 'eta_query', params: { route: '42' }, ttl_seconds: 60, schema_hash: 'h-b' } },
    ]);
    const ev = repo.listEventsForTask(id).find((e) => e.event_kind === 'retargeted');
    expect(JSON.parse(ev!.details)).toMatchObject({ previous_service_name: 'Provider A', service_name: 'Provider B' });
  });

  it('when every candidate is spent, the query expires as before', () => {
    const { repo, service } = setup();
    const id = query(service, 'eta_query', [{ to_did: B }], 1000);
    service.expireTasks(1061, 1_061_000);
    service.expireTasks(1122, 1_122_000);
    expect(repo.getById(id)!.status).toBe('failed');
  });

  it('a booking never fails over and ends as an unknown outcome', () => {
    const { repo, service, sent } = setup();
    const id = query(service, 'appointment_book', [{ to_did: B }], 1000);
    service.expireTasks(1061, 1_061_000);
    expect(sent).toEqual([]);
    expect(repo.getById(id)!.status).toBe('outcome_unknown');
  });

  it('an ejected fallback is skipped', () => {
    const { service, sent } = setup();
    [1, 2, 3].forEach((t) => recordProviderOutcome(B, 'expired', { handedOff: true, now: t }));
    query(service, 'eta_query', [{ to_did: B }, { to_did: C }], 1000);
    service.expireTasks(1061, 1_061_000);
    expect(sent.map((s) => s.to)).toEqual([C]);
  });
});
