/**
 * The external order boundary (§9.9 step 3, §15.5 — WS-9.4).
 *
 * WS-9.4's acceptance: an accepted order appears exactly once externally, or
 * the ambiguity is reconciled honestly. Two endings, and the tests here are
 * mostly about keeping a third out of reach — "it probably worked, send it
 * again". The ORDERING tests are the load-bearing ones: `effect_started` must
 * be durable before the boundary is crossed, because the reverse leaves an
 * executed external order behind a record that still looks safe to expire.
 */

import { CredentialBroker, type BrokeredExecutor } from '../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../src/commerce/credential_store';
import {
  MAX_PROVEN_ATTEMPTS,
  performOrderEffect,
  type EffectDeps,
} from '../../src/commerce/effect_executor';
import {
  DEFAULT_RETENTION_REQUIREMENT,
  MIN_PROBE_GAP_MS,
  requiredRetentionMs,
  type IdempotencyEvidence,
} from '../../src/commerce/idempotency_evidence';

const NOW = Date.parse('2026-08-08T09:00:00.000Z');
const REQUEST = {
  buyerDid: 'did:plc:sancho',
  purchaseOrderId: 'po-1',
  idempotencyKey: 'idem-1',
  resource: 'erp.primary',
  operation: 'submit_purchase_order',
  installId: 'install-1',
  params: { lines: [{ sku: 'CHAIR-1', qty: '2' }] },
};

function provenEvidence(): IdempotencyEvidence {
  return {
    resource: 'erp.primary',
    operation: 'submit_purchase_order',
    declaredRetentionMs: requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT),
    probe: {
      idempotencyKey: 'probe-1',
      firstExternalRef: 'EXT-1',
      secondExternalRef: 'EXT-1',
      secondCreatedNewOrder: false,
      firstAtMs: NOW - 2 * MIN_PROBE_GAP_MS,
      secondAtMs: NOW - MIN_PROBE_GAP_MS,
    },
    recordedAtMs: NOW - 1_000,
  };
}

interface Harness {
  deps: EffectDeps;
  events: string[];
  brokerCalls: unknown[];
}

function harness(options: {
  executor: BrokeredExecutor;
  evidence?: IdempotencyEvidence | null;
  alreadyStarted?: boolean;
  markSucceeds?: boolean;
  installId?: string;
}): Harness {
  const events: string[] = [];
  const brokerCalls: unknown[] = [];
  const store = new InMemoryCredentialStore();
  store.rotate({
    resource: 'erp.primary',
    installId: options.installId ?? 'install-1',
    operations: ['submit_purchase_order'],
    material: 'sk-live-erp-token-0123456789abcd',
    nowMs: NOW,
  });
  const wrapped: BrokeredExecutor = async (args) => {
    events.push('boundary_crossed');
    brokerCalls.push(args.params);
    return options.executor(args);
  };
  return {
    events,
    brokerCalls,
    deps: {
      broker: new CredentialBroker({
        store,
        executors: () => ({ 'erp.primary:submit_purchase_order': wrapped }),
      }),
      markEffectStarted: () => {
        events.push('effect_started_recorded');
        return options.markSucceeds !== false;
      },
      effectAlreadyStarted: () => options.alreadyStarted === true,
      readEvidence: () => options.evidence ?? null,
      requirement: DEFAULT_RETENTION_REQUIREMENT,
      now: () => NOW,
    },
  };
}

describe('the ordering §15.5 states', () => {
  it('records effect_started BEFORE crossing the boundary', async () => {
    const h = harness({ executor: async () => ({ ok: true, result: { external_ref: 'EXT-9' } }) });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome).toEqual({ kind: 'succeeded', externalRef: 'EXT-9', attempts: 1 });
    // The reverse order would leave an executed external order behind a record
    // that still looks safe to time out.
    expect(h.events).toEqual(['effect_started_recorded', 'boundary_crossed']);
  });

  it('attempts nothing when the boundary could not be recorded', async () => {
    const h = harness({
      executor: async () => ({ ok: true, result: { external_ref: 'EXT-9' } }),
      markSucceeds: false,
    });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome).toMatchObject({
      kind: 'refused_before_sending',
      refusal: 'effect_phase_not_recorded',
    });
    expect(h.events).toEqual(['effect_started_recorded']);
  });

  it('refuses a second effect on an order that already crossed', async () => {
    const h = harness({
      executor: async () => ({ ok: true, result: { external_ref: 'EXT-9' } }),
      alreadyStarted: true,
      evidence: provenEvidence(),
    });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    // AMBIGUOUS, not an error: whatever happened out there happened, and the
    // answer is reconciliation. Proven evidence does NOT unlock this path —
    // the crash recovery case is not a retry of a known-failed attempt.
    expect(outcome).toEqual({
      kind: 'ambiguous',
      error: expect.stringContaining('already crossed'),
      attempts: 0,
      retriedAutomatically: false,
    });
    expect(h.events).toEqual([]);
  });
});

describe('one key, every attempt (§15.5)', () => {
  it('sends the order idempotency key, not a fresh one', async () => {
    const h = harness({ executor: async () => ({ ok: true, result: { external_ref: 'EXT-9' } }) });
    await performOrderEffect(REQUEST, h.deps);
    expect(h.brokerCalls).toEqual([{ idempotency_key: 'idem-1', order: REQUEST.params }]);
  });

  it('repeats the SAME key on a permitted retry', async () => {
    let calls = 0;
    const h = harness({
      evidence: provenEvidence(),
      executor: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, error: 'gateway timeout' }
          : { ok: true, result: { external_ref: 'EXT-9' } };
      },
    });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome).toEqual({ kind: 'succeeded', externalRef: 'EXT-9', attempts: 2 });
    // A fresh key would have made the retry a second order.
    expect(h.brokerCalls).toEqual([
      { idempotency_key: 'idem-1', order: REQUEST.params },
      { idempotency_key: 'idem-1', order: REQUEST.params },
    ]);
  });
});

describe('retry is earned, not assumed', () => {
  it('does not retry an ambiguous attempt without proven evidence', async () => {
    let calls = 0;
    const h = harness({
      evidence: null,
      executor: async () => {
        calls += 1;
        return { ok: false, error: 'gateway timeout' };
      },
    });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome).toEqual({
      kind: 'ambiguous',
      error: 'gateway timeout',
      attempts: 1,
      retriedAutomatically: false,
    });
    expect(calls).toBe(1);
  });

  it('does not retry when the evidence exists but does not prove enough', async () => {
    const weak = provenEvidence();
    weak.declaredRetentionMs = 1;
    let calls = 0;
    const h = harness({
      evidence: weak,
      executor: async () => {
        calls += 1;
        return { ok: false, error: 'gateway timeout' };
      },
    });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome).toMatchObject({ kind: 'ambiguous', retriedAutomatically: false });
    expect(calls).toBe(1);
  });

  it('retries with proven evidence, and stops at the cap', async () => {
    let calls = 0;
    const h = harness({
      evidence: provenEvidence(),
      executor: async () => {
        calls += 1;
        return { ok: false, error: 'still down' };
      },
    });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(calls).toBe(MAX_PROVEN_ATTEMPTS);
    expect(outcome).toEqual({
      kind: 'ambiguous',
      error: 'still down',
      attempts: MAX_PROVEN_ATTEMPTS,
      retriedAutomatically: true,
    });
  });

  it('reads the evidence once, before the first attempt', async () => {
    // Evidence written mid-flight must not authorise a retry that was not
    // authorised when the ambiguity arose.
    let evidence: IdempotencyEvidence | null = null;
    let calls = 0;
    const h = harness({ executor: async () => ({ ok: false, error: 'down' }) });
    const deps: EffectDeps = {
      ...h.deps,
      readEvidence: () => {
        calls += 1;
        const answer = evidence;
        evidence = provenEvidence();
        return answer;
      },
    };
    const outcome = await performOrderEffect(REQUEST, deps);
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ attempts: 1, retriedAutomatically: false });
  });
});

describe('what never left the node can be answered cleanly', () => {
  const PRE_NETWORK: [string, () => Harness][] = [
    [
      'install_not_permitted',
      () =>
        harness({
          installId: 'somebody-else',
          executor: async () => ({ ok: true, result: {} }),
        }),
    ],
  ];

  it.each(PRE_NETWORK)('reports %s as refused before sending', async (_refusal, make) => {
    const h = make();
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome.kind).toBe('refused_before_sending');
    // The boundary was recorded but never crossed — the order can be rejected
    // cleanly because nothing exists out there.
    expect(h.events).toEqual(['effect_started_recorded']);
  });

  it('reports an unknown credential as refused before sending', async () => {
    const h = harness({ executor: async () => ({ ok: true, result: {} }) });
    const outcome = await performOrderEffect({ ...REQUEST, resource: 'erp.missing' }, h.deps);
    expect(outcome).toMatchObject({
      kind: 'refused_before_sending',
      refusal: 'no_such_resource',
    });
  });

  it('reports an undeclared operation as refused before sending', async () => {
    const h = harness({ executor: async () => ({ ok: true, result: {} }) });
    const outcome = await performOrderEffect({ ...REQUEST, operation: 'wire_money' }, h.deps);
    expect(outcome.kind).toBe('refused_before_sending');
  });

  it('treats a THROWN executor as ambiguous, never as refused', async () => {
    // The safety property: a throw may still have created the order.
    const h = harness({
      executor: async () => {
        throw new Error('socket hang up');
      },
    });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome).toMatchObject({ kind: 'ambiguous', error: 'socket hang up' });
  });

  it('treats an error ANSWER as ambiguous, never as refused', async () => {
    const h = harness({ executor: async () => ({ ok: false, error: 'HTTP 500' }) });
    const outcome = await performOrderEffect(REQUEST, h.deps);
    expect(outcome).toMatchObject({ kind: 'ambiguous', error: 'HTTP 500' });
  });
});

describe('the external reference', () => {
  it('is carried through when the system returns one', async () => {
    const h = harness({ executor: async () => ({ ok: true, result: { external_ref: 'SO-42' } }) });
    expect(await performOrderEffect(REQUEST, h.deps)).toMatchObject({ externalRef: 'SO-42' });
  });

  it('is empty rather than a placeholder when it is missing', async () => {
    // A reconciliation searching for `"unknown"` would find nothing and report
    // the order missing.
    for (const result of [{}, { external_ref: 7 }, 'text', null]) {
      const h = harness({ executor: async () => ({ ok: true, result }) });
      expect(await performOrderEffect(REQUEST, h.deps)).toMatchObject({
        kind: 'succeeded',
        externalRef: '',
      });
    }
  });
});
