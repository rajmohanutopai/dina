/**
 * agent_intent_summary tests.
 */

import type { AgentIntent } from '../src/brain/agent_gateway';
import {
  DEFAULT_MAX_SHORT_CHARS,
  summariseAgentIntent,
} from '../src/brain/agent_intent_summary';

function intent(overrides: Partial<AgentIntent> = {}): AgentIntent {
  return {
    agentDid: 'did:plc:agent-alpha',
    risk: 'send',
    persona: { name: 'general', tier: 'default', open: true },
    op: 'write',
    ...overrides,
  };
}

describe('summariseAgentIntent — input validation', () => {
  it.each([
    ['null intent', null],
    ['non-DID agentDid', { ...intent(), agentDid: 'alpha' }],
    ['empty persona name', { ...intent(), persona: { name: '', tier: 'default', open: true } }],
    ['bogus risk', { ...intent(), risk: 'bogus' as AgentIntent['risk'] }],
    ['bogus op', { ...intent(), op: 'bogus' as AgentIntent['op'] }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      summariseAgentIntent(bad as AgentIntent),
    ).toThrow();
  });
});

describe('summariseAgentIntent — short line', () => {
  it('basic "Agent wants to <verb> <target> "persona"" shape', () => {
    const s = summariseAgentIntent(intent());
    expect(s.short).toContain(' wants to send items into "general"');
  });

  it('pay risk uses "pay via" verb', () => {
    const s = summariseAgentIntent(intent({ risk: 'pay' }));
    expect(s.short).toContain('pay via');
  });

  it('delete + export maps to the right verbs/targets', () => {
    const del = summariseAgentIntent(intent({ risk: 'delete', op: 'write' }));
    expect(del.short).toContain('delete from items into');

    const exp = summariseAgentIntent(intent({ risk: 'read', op: 'export' }));
    expect(exp.short).toContain('a full export of');
  });

  it('agentName override used when supplied', () => {
    const s = summariseAgentIntent(intent(), { agentName: 'Research Bot' });
    expect(s.short.startsWith('Research Bot wants to')).toBe(true);
  });

  it('no agentName → short DID label', () => {
    const s = summariseAgentIntent(intent({ agentDid: 'did:plc:longagentname12345' }));
    expect(s.short.startsWith('Did:plc:longagentn')).toBe(true);
  });

  it('short DID kept verbatim when under 20 chars', () => {
    const s = summariseAgentIntent(intent({ agentDid: 'did:plc:ab' }));
    expect(s.short.startsWith('Did:plc:ab')).toBe(true);
    expect(s.short).not.toContain('…');
  });

  it('short truncated with ellipsis past maxShortChars', () => {
    const s = summariseAgentIntent(
      intent({ persona: { name: 'x'.repeat(200), tier: 'default', open: true } }),
      { maxShortChars: 50 },
    );
    expect(s.short.length).toBe(50);
    expect(s.short.endsWith('…')).toBe(true);
  });

  it('DEFAULT_MAX_SHORT_CHARS is 80', () => {
    expect(DEFAULT_MAX_SHORT_CHARS).toBe(80);
  });
});

describe('summariseAgentIntent — long output', () => {
  it('includes agent line, risk line, persona tier', () => {
    const s = summariseAgentIntent(
      intent({ persona: { name: 'health', tier: 'sensitive', open: false } }),
      { agentName: 'MedBot' },
    );
    expect(s.long).toContain('Agent: MedBot (did:plc:agent-alpha)');
    expect(s.long).toContain('Risk: SEND');
    expect(s.long).toContain('Persona tier: sensitive (closed)');
  });

  it('open persona shows "(open)"', () => {
    const s = summariseAgentIntent(intent());
    expect(s.long).toContain('(open)');
  });

  it('label included on own line when present', () => {
    const s = summariseAgentIntent(
      intent({ label: 'Send monthly summary email' }),
    );
    expect(s.long).toContain('What: Send monthly summary email');
  });

  it('rationale included on own line when present', () => {
    const s = summariseAgentIntent(intent(), { rationale: 'risk_over_grant' });
    expect(s.long).toContain('Why review: risk_over_grant');
  });

  it('empty label / rationale skipped', () => {
    const s = summariseAgentIntent(intent({ label: '   ' }), { rationale: '' });
    expect(s.long).not.toContain('What:');
    expect(s.long).not.toContain('Why review:');
  });
});

describe('summariseAgentIntent — fields echo', () => {
  it('fields object mirrors core intent data', () => {
    const s = summariseAgentIntent(
      intent({
        risk: 'pay',
        op: 'write',
        label: 'invoice X',
        persona: { name: 'finance', tier: 'sensitive', open: false },
      }),
      { agentName: 'Pay Bot' },
    );
    expect(s.fields).toEqual({
      agentDid: 'did:plc:agent-alpha',
      agentName: 'Pay Bot',
      risk: 'pay',
      personaName: 'finance',
      op: 'write',
      label: 'invoice X',
    });
  });

  it('null agentName when not supplied + empty label → null', () => {
    const s = summariseAgentIntent(intent({ label: '  ' }));
    expect(s.fields.agentName).toBeNull();
    expect(s.fields.label).toBeNull();
  });
});

describe('summariseAgentIntent — determinism', () => {
  it('same input → same output', () => {
    const a = summariseAgentIntent(intent({ label: 'x' }), { agentName: 'A' });
    const b = summariseAgentIntent(intent({ label: 'x' }), { agentName: 'A' });
    expect(a).toEqual(b);
  });
});

describe('summariseAgentIntent — risk coverage', () => {
  it.each(['read', 'send', 'pay', 'share', 'delete', 'execute'] as const)(
    '%s risk produces a non-empty short + long',
    (risk) => {
      const s = summariseAgentIntent(
        intent({ risk, op: risk === 'read' ? 'read' : 'write' }),
      );
      expect(s.short.length).toBeGreaterThan(0);
      expect(s.long.includes('Risk:')).toBe(true);
    },
  );
});

describe('summariseAgentIntent — op coverage', () => {
  it.each(['read', 'write', 'share', 'export'] as const)(
    '%s op produces distinct wording',
    (op) => {
      const s = summariseAgentIntent(intent({ op }));
      expect(s.fields.op).toBe(op);
    },
  );
});
