/**
 * agent_gateway tests.
 */

import {
  DEFAULT_ALWAYS_REVIEW_RISKS,
  DEFAULT_GRANTED_RISKS,
  createAgentGateway,
  type AgentIntent,
} from '../src/brain/agent_gateway';
import { RateLimiter } from '../src/brain/rate_limiter';

function gateway(overrides: Parameters<typeof createAgentGateway>[0] = {
  rateLimiter: new RateLimiter({ capacity: 10, refillPerSec: 1 }),
}) {
  return createAgentGateway(overrides);
}

function intent(overrides: Partial<AgentIntent> = {}): AgentIntent {
  return {
    agentDid: 'did:plc:agent',
    risk: 'read',
    persona: { name: 'general', tier: 'default', open: true },
    op: 'read',
    sessionGrant: { ops: ['read'], expiresAtSec: 9_999_999_999 },
    nowSec: 1_000_000,
    ...overrides,
  };
}

describe('createAgentGateway — construction', () => {
  it('throws without rateLimiter', () => {
    expect(() =>
      createAgentGateway(
        {} as unknown as Parameters<typeof createAgentGateway>[0],
      ),
    ).toThrow(/rateLimiter/);
  });

  it('DEFAULT_ALWAYS_REVIEW_RISKS includes pay/delete/execute', () => {
    expect(DEFAULT_ALWAYS_REVIEW_RISKS).toContain('pay');
    expect(DEFAULT_ALWAYS_REVIEW_RISKS).toContain('delete');
    expect(DEFAULT_ALWAYS_REVIEW_RISKS).toContain('execute');
  });

  it('DEFAULT_GRANTED_RISKS is [read]', () => {
    expect(DEFAULT_GRANTED_RISKS).toEqual(['read']);
  });
});

describe('decide — input validation', () => {
  it.each([
    ['null intent', null],
    ['non-DID agentDid', { ...intent(), agentDid: 'agent' }],
    ['empty persona name', { ...intent(), persona: { name: '', tier: 'default' as const, open: true } }],
    ['bogus risk', { ...intent(), risk: 'bogus' as AgentIntent['risk'] }],
  ] as const)('%s → block invalid_input', (_l, bad) => {
    const decide = gateway();
    const r = decide(bad as AgentIntent);
    expect(r.action).toBe('block');
    if (r.action === 'block') expect(r.reason).toBe('invalid_input');
  });
});

describe('decide — persona gate paths', () => {
  it('persona gate denies (locked) → block persona_denied with passphrase required', () => {
    const decide = gateway();
    const r = decide(
      intent({
        persona: { name: 'financial', tier: 'locked', open: false },
      }),
    );
    if (r.action !== 'block') throw new Error('expected block');
    expect(r.reason).toBe('persona_denied');
    expect(r.detail).toBe('denied_locked_passphrase_required');
    expect(r.required).toBe('passphrase');
  });

  it('sensitive persona blocks non-owner agent with approval-required', () => {
    const decide = gateway();
    const r = decide(
      intent({
        persona: { name: 'health', tier: 'sensitive', open: true },
      }),
    );
    if (r.action !== 'block') throw new Error('expected block');
    expect(r.reason).toBe('persona_denied');
    expect(r.required).toBe('approval');
  });

  it('agent without grant on default persona → block persona_denied', () => {
    const decide = gateway();
    const r = decide(
      intent({
        sessionGrant: undefined,
      }),
    );
    if (r.action !== 'block') throw new Error('expected block');
    expect(r.reason).toBe('persona_denied');
  });
});

describe('decide — rate limit', () => {
  it('rate-limit exhaustion → block rate_limited with retryAfterMs', () => {
    const limiter = new RateLimiter({
      capacity: 2,
      refillPerSec: 1,
      nowMsFn: () => 0,
    });
    const decide = gateway({ rateLimiter: limiter });
    expect(decide(intent()).action).toBe('allow');
    expect(decide(intent()).action).toBe('allow');
    const r = decide(intent());
    if (r.action !== 'block') throw new Error('expected block');
    expect(r.reason).toBe('rate_limited');
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('separate agents get separate buckets', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    const decide = gateway({ rateLimiter: limiter });
    expect(decide(intent({ agentDid: 'did:plc:a' })).action).toBe('allow');
    expect(decide(intent({ agentDid: 'did:plc:b' })).action).toBe('allow');
    // Both agents have used their 1-token budget.
    expect(decide(intent({ agentDid: 'did:plc:a' })).action).toBe('block');
    expect(decide(intent({ agentDid: 'did:plc:b' })).action).toBe('block');
  });
});

describe('decide — review paths', () => {
  it.each(['pay', 'delete', 'execute'] as const)(
    'risk=%s → review with risk_always_review',
    (risk) => {
      const decide = gateway();
      const r = decide(
        intent({
          risk,
          op: 'write',
          sessionGrant: { ops: ['read', 'write', 'share', 'export'], expiresAtSec: 9e9 },
        }),
      );
      if (r.action !== 'review') throw new Error('expected review');
      expect(r.reason).toBe('risk_always_review');
      expect(r.risk).toBe(risk);
    },
  );

  it('risk outside grant (e.g. send) → review with risk_over_grant', () => {
    const decide = gateway();
    const r = decide(
      intent({
        risk: 'send',
        op: 'write',
        sessionGrant: { ops: ['read', 'write'], expiresAtSec: 9e9 },
      }),
    );
    if (r.action !== 'review') throw new Error('expected review');
    expect(r.reason).toBe('risk_over_grant');
  });

  it('label is echoed on review outcomes', () => {
    const decide = gateway();
    const r = decide(
      intent({
        risk: 'pay',
        op: 'write',
        label: 'Pay $12 to merchant X',
        sessionGrant: { ops: ['read', 'write'], expiresAtSec: 9e9 },
      }),
    );
    if (r.action !== 'review') throw new Error('expected review');
    expect(r.label).toBe('Pay $12 to merchant X');
  });

  it('custom alwaysReviewRisks overrides defaults', () => {
    const decide = gateway({
      rateLimiter: new RateLimiter({ capacity: 10, refillPerSec: 1 }),
      alwaysReviewRisks: [], // opt-out; payments pass through.
      grantedRisks: ['read', 'pay'], // and granted.
    });
    const r = decide(intent({ risk: 'pay' }));
    expect(r.action).toBe('allow');
  });
});

describe('decide — allow path', () => {
  it('granted read on open default persona → allow', () => {
    const decide = gateway();
    const r = decide(intent());
    expect(r.action).toBe('allow');
    if (r.action === 'allow') expect(r.reason).toBe('gated_and_rate_limited_ok');
  });

  it('custom grantedRisks expand the safe set', () => {
    const decide = gateway({
      rateLimiter: new RateLimiter({ capacity: 10, refillPerSec: 1 }),
      grantedRisks: ['read', 'send', 'share'],
    });
    const r = decide(
      intent({
        risk: 'send',
        op: 'write',
        sessionGrant: { ops: ['read', 'write', 'share'], expiresAtSec: 9e9 },
      }),
    );
    expect(r.action).toBe('allow');
  });
});

describe('decide — rule ordering', () => {
  it('invalid input short-circuits before rate limiter', () => {
    const limiter = new RateLimiter({ capacity: 0.0001, refillPerSec: 0.001 });
    const decide = gateway({ rateLimiter: limiter });
    const r = decide({ agentDid: 'bad', risk: 'read' } as unknown as AgentIntent);
    if (r.action !== 'block') throw new Error('expected block');
    expect(r.reason).toBe('invalid_input');
  });

  it('persona denied short-circuits before rate limiter', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    limiter.consume('did:plc:agent'); // exhaust first.
    const decide = gateway({ rateLimiter: limiter });
    const r = decide(
      intent({
        persona: { name: 'financial', tier: 'locked', open: false },
      }),
    );
    // Persona denial takes precedence over rate limit denial.
    if (r.action !== 'block') throw new Error('expected block');
    expect(r.reason).toBe('persona_denied');
  });

  it('rate-limited short-circuits before risk-review check', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    const decide = gateway({ rateLimiter: limiter });
    // First call exhausts the bucket.
    decide(intent({ risk: 'pay', op: 'write', sessionGrant: { ops: ['write'], expiresAtSec: 9e9 } }));
    const r = decide(intent({ risk: 'pay', op: 'write', sessionGrant: { ops: ['write'], expiresAtSec: 9e9 } }));
    if (r.action !== 'block') throw new Error('expected block');
    expect(r.reason).toBe('rate_limited');
  });
});
