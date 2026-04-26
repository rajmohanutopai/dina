/**
 * persona_gate tests.
 */

import {
  checkPersonaGate,
  type PersonaGateInput,
  type PersonaGateOp,
  type PersonaGateTier,
} from '../../src/ask/persona_gate';

function input(overrides: Partial<PersonaGateInput> = {}): PersonaGateInput {
  return {
    persona: { name: 'general', tier: 'default', open: true },
    caller: { role: 'user' },
    op: 'read',
    ...overrides,
  };
}

describe('checkPersonaGate — input validation', () => {
  it.each([
    ['null input', null],
    ['empty persona name', input({ persona: { name: '', tier: 'default', open: true } })],
    [
      'bogus tier',
      { ...input(), persona: { name: 'x', tier: 'bogus' as PersonaGateTier, open: true } },
    ],
    [
      'non-boolean open',
      { ...input(), persona: { name: 'x', tier: 'default', open: 1 as unknown as boolean } },
    ],
    ['bogus role', { ...input(), caller: { role: 'god' as 'user' } }],
    ['bogus op', { ...input(), op: 'delete' as PersonaGateOp }],
  ] as const)('%s → denied_invalid_input', (_l, bad) => {
    const r = checkPersonaGate(bad as PersonaGateInput);
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toBe('denied_invalid_input');
  });
});

describe('checkPersonaGate — locked tier', () => {
  it.each(['user', 'brain', 'agent', 'admin'] as const)(
    'locked persona → passphrase required regardless of %s caller',
    (role) => {
      const r = checkPersonaGate(
        input({
          persona: { name: 'financial', tier: 'locked', open: false },
          caller: { role },
        }),
      );
      expect(r.allow).toBe(false);
      if (!r.allow) {
        expect(r.reason).toBe('denied_locked_passphrase_required');
        expect(r.required).toBe('passphrase');
      }
    },
  );
});

describe('checkPersonaGate — default tier', () => {
  it.each(['user', 'brain', 'admin'] as const)('%s reading default tier → allowed', (role) => {
    const r = checkPersonaGate(input({ caller: { role } }));
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.reason).toBe('allowed_default_tier');
  });

  it('agent without grant → denied_agent_no_grant', () => {
    const r = checkPersonaGate(input({ caller: { role: 'agent' } }));
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_agent_no_grant');
    expect(r.required).toBe('session_grant');
  });

  it('agent with valid grant → allowed_session_grant', () => {
    const r = checkPersonaGate(
      input({
        caller: { role: 'agent' },
        sessionGrant: { ops: ['read'], expiresAtSec: 2_000 },
        nowSec: 1_000,
      }),
    );
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.reason).toBe('allowed_session_grant');
  });

  it('agent with expired grant → denied_agent_grant_expired', () => {
    const r = checkPersonaGate(
      input({
        caller: { role: 'agent' },
        sessionGrant: { ops: ['read'], expiresAtSec: 500 },
        nowSec: 1_000,
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_agent_grant_expired');
  });

  it('agent grant covers other op but not the requested one → denied_agent_op_outside_grant', () => {
    const r = checkPersonaGate(
      input({
        caller: { role: 'agent' },
        op: 'write',
        sessionGrant: { ops: ['read'], expiresAtSec: 2_000 },
        nowSec: 1_000,
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_agent_op_outside_grant');
  });
});

describe('checkPersonaGate — standard tier', () => {
  it.each(['user', 'brain', 'admin'] as const)(
    '%s writing to open standard persona → allowed_open_persona',
    (role) => {
      const r = checkPersonaGate(
        input({
          persona: { name: 'work', tier: 'standard', open: true },
          caller: { role },
          op: 'write',
        }),
      );
      expect(r.allow).toBe(true);
      if (r.allow) expect(r.reason).toBe('allowed_open_persona');
    },
  );

  it('closed standard persona → denied_persona_closed + unlock_session required', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'work', tier: 'standard', open: false },
        caller: { role: 'user' },
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_persona_closed');
    expect(r.required).toBe('unlock_session');
  });

  it('agent with valid grant on open standard persona → allowed_session_grant', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'work', tier: 'standard', open: true },
        caller: { role: 'agent' },
        op: 'write',
        sessionGrant: { ops: ['write'], expiresAtSec: 2_000 },
        nowSec: 1_000,
      }),
    );
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.reason).toBe('allowed_session_grant');
  });

  it('agent with grant on CLOSED standard persona → denied_persona_closed', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'work', tier: 'standard', open: false },
        caller: { role: 'agent' },
        sessionGrant: { ops: ['read'], expiresAtSec: 2_000 },
        nowSec: 1_000,
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_persona_closed');
  });
});

describe('checkPersonaGate — sensitive tier', () => {
  it('user owns sensitive content → allowed_owner', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'health', tier: 'sensitive', open: true },
        caller: { role: 'user' },
      }),
    );
    expect(r.allow).toBe(true);
    if (r.allow) expect(r.reason).toBe('allowed_owner');
  });

  it.each(['brain', 'agent', 'admin'] as const)(
    'non-user %s on open sensitive → approval required',
    (role) => {
      const r = checkPersonaGate(
        input({
          persona: { name: 'health', tier: 'sensitive', open: true },
          caller: { role },
        }),
      );
      if (r.allow) throw new Error('expected deny');
      expect(r.reason).toBe('denied_sensitive_approval_required');
      expect(r.required).toBe('approval');
    },
  );

  it('non-user on closed sensitive → denied_persona_closed', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'health', tier: 'sensitive', open: false },
        caller: { role: 'brain' },
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_persona_closed');
  });

  it('session grant does NOT bypass sensitive approval requirement', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'health', tier: 'sensitive', open: true },
        caller: { role: 'agent' },
        sessionGrant: { ops: ['read', 'write'], expiresAtSec: 10_000 },
        nowSec: 1_000,
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_sensitive_approval_required');
  });
});

describe('checkPersonaGate — export op', () => {
  it('admin exporting any tier (non-locked) → allowed_admin_export', () => {
    for (const tier of ['default', 'standard', 'sensitive'] as const) {
      const r = checkPersonaGate(
        input({
          persona: { name: 'p', tier, open: true },
          caller: { role: 'admin' },
          op: 'export',
        }),
      );
      expect(r.allow).toBe(true);
      if (r.allow) expect(r.reason).toBe('allowed_admin_export');
    }
  });

  it('admin exporting locked persona → passphrase required', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'p', tier: 'locked', open: false },
        caller: { role: 'admin' },
        op: 'export',
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_locked_passphrase_required');
  });

  it('user exporting their own default/standard persona → allowed_owner', () => {
    for (const tier of ['default', 'standard'] as const) {
      const r = checkPersonaGate(
        input({
          persona: { name: 'p', tier, open: true },
          caller: { role: 'user' },
          op: 'export',
        }),
      );
      expect(r.allow).toBe(true);
      if (r.allow) expect(r.reason).toBe('allowed_owner');
    }
  });

  it('user exporting sensitive persona → denied_export_non_admin (need admin auth)', () => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'p', tier: 'sensitive', open: true },
        caller: { role: 'user' },
        op: 'export',
      }),
    );
    if (r.allow) throw new Error('expected deny');
    expect(r.reason).toBe('denied_export_non_admin');
    expect(r.required).toBe('admin_auth');
  });

  it('brain or agent export → denied_export_non_admin', () => {
    for (const role of ['brain', 'agent'] as const) {
      const r = checkPersonaGate(
        input({
          persona: { name: 'p', tier: 'default', open: true },
          caller: { role },
          op: 'export',
        }),
      );
      if (r.allow) throw new Error('expected deny');
      expect(r.reason).toBe('denied_export_non_admin');
    }
  });
});

describe('checkPersonaGate — every op x tier matrix smoke', () => {
  it.each<[PersonaGateTier, PersonaGateOp]>([
    ['default', 'read'],
    ['default', 'write'],
    ['default', 'share'],
    ['standard', 'read'],
    ['standard', 'share'],
    ['sensitive', 'read'],
  ])('user always allowed on %s tier + %s op when open', (tier, op) => {
    const r = checkPersonaGate(
      input({
        persona: { name: 'p', tier, open: true },
        caller: { role: 'user' },
        op,
      }),
    );
    expect(r.allow).toBe(true);
  });
});
