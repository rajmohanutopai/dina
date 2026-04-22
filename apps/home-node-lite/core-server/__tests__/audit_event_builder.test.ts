/**
 * audit_event_builder tests.
 */

import {
  AuditEventError,
  REDACTED_VALUE,
  SECRET_KEY_PATTERNS,
  buildAuditEvent,
  redactSecrets,
  type AuditActor,
  type AuditEventInput,
} from '../src/brain/audit_event_builder';

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor: { role: 'user', did: 'did:plc:alice' },
    action: 'vault_write',
    target: { type: 'vault_item', id: 'v-1' },
    result: 'success',
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe('buildAuditEvent — input validation', () => {
  it.each([
    ['null actor', { ...input(), actor: null as unknown as AuditActor }],
    ['unknown role', { ...input(), actor: { role: 'god' } as unknown as AuditActor }],
    ['agent without did', { ...input(), actor: { role: 'agent' } as unknown as AuditActor }],
    ['agent with empty did', { ...input(), actor: { role: 'agent', did: '' } as AuditActor }],
  ] as const)('actor — %s', (_l, bad) => {
    expect(() => buildAuditEvent(bad)).toThrow(/invalid_actor/);
  });

  it('unknown action → invalid_action', () => {
    expect(() =>
      buildAuditEvent({ ...input(), action: 'bogus_action' as unknown as 'vault_write' }),
    ).toThrow(/invalid_action/);
  });

  it.each([
    ['missing target', { ...input(), target: null as unknown as AuditEventInput['target'] }],
    ['empty target.type', { ...input(), target: { type: '', id: 'x' } }],
    ['empty target.id', { ...input(), target: { type: 'x', id: '' } }],
  ] as const)('target — %s', (_l, bad) => {
    expect(() => buildAuditEvent(bad)).toThrow(/invalid_target/);
  });

  it('invalid result → invalid_result', () => {
    expect(() =>
      buildAuditEvent({ ...input(), result: 'bogus' as unknown as 'success' }),
    ).toThrow(/invalid_result/);
  });

  it('non-finite timestamp → invalid_timestamp', () => {
    expect(() =>
      buildAuditEvent({ ...input(), timestampMs: Number.NaN }),
    ).toThrow(/invalid_timestamp/);
  });
});

describe('buildAuditEvent — happy path', () => {
  it('produces every documented field', () => {
    const e = buildAuditEvent(input());
    expect(Object.keys(e).sort()).toEqual([
      'action', 'actor', 'id', 'metadata', 'persona',
      'requestId', 'result', 'severity', 'target', 'timestampMs',
    ]);
  });

  it('id is deterministic for (timestamp, action, target.id)', () => {
    const a = buildAuditEvent(input());
    const b = buildAuditEvent(input());
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different inputs → different ids', () => {
    const a = buildAuditEvent(input());
    const b = buildAuditEvent(input({ target: { type: 'vault_item', id: 'v-2' } }));
    expect(a.id).not.toBe(b.id);
  });

  it('custom makeIdFn override works', () => {
    const e = buildAuditEvent(input(), { makeIdFn: () => 'custom-id' });
    expect(e.id).toBe('custom-id');
  });

  it('target is defensively copied', () => {
    const target = { type: 'vault_item', id: 'v-1', label: 'email' };
    const e = buildAuditEvent(input({ target }));
    e.target.id = 'mutated';
    expect(target.id).toBe('v-1');
  });

  it('persona + requestId default to null', () => {
    const e = buildAuditEvent(input());
    expect(e.persona).toBeNull();
    expect(e.requestId).toBeNull();
  });

  it('persona + requestId echo when supplied', () => {
    const e = buildAuditEvent(
      input({ persona: 'health', requestId: 'req-abc' }),
    );
    expect(e.persona).toBe('health');
    expect(e.requestId).toBe('req-abc');
  });

  it('injected clock wins when timestampMs not supplied', () => {
    const e = buildAuditEvent(
      { ...input(), timestampMs: undefined },
      { nowMsFn: () => 12345 },
    );
    expect(e.timestampMs).toBe(12345);
  });
});

describe('buildAuditEvent — severity inference', () => {
  it.each([
    ['vault_write', 'success', 'info'],
    ['vault_delete', 'success', 'warn'],
    ['export_created', 'success', 'warn'],
    ['key_rotated', 'success', 'warn'],
    ['agent_review', 'success', 'warn'],
    ['agent_allow', 'success', 'info'],
    ['login_failed', 'failed', 'warn'],
    ['agent_block', 'failed', 'warn'],
    ['vault_write', 'failed', 'error'],
    ['vault_write', 'pending', 'info'],
  ] as const)('%s + %s → %s', (action, result, expected) => {
    const e = buildAuditEvent(input({ action, result }));
    expect(e.severity).toBe(expected);
  });

  it('explicit severity overrides inference', () => {
    const e = buildAuditEvent(input({ severity: 'debug' }));
    expect(e.severity).toBe('debug');
  });
});

describe('buildAuditEvent — metadata redaction', () => {
  it('redacts `password`, `apiKey`, `passphrase`, etc.', () => {
    const e = buildAuditEvent(
      input({
        metadata: {
          ok: 'fine',
          password: 'hunter2',
          apiKey: 'sk-ant',
          passphrase: 'correct horse',
        },
      }),
    );
    expect(e.metadata!.ok).toBe('fine');
    expect(e.metadata!.password).toBe(REDACTED_VALUE);
    expect(e.metadata!.apiKey).toBe(REDACTED_VALUE);
    expect(e.metadata!.passphrase).toBe(REDACTED_VALUE);
  });

  it('case-insensitive + underscore/hyphen-insensitive', () => {
    const e = buildAuditEvent(
      input({
        metadata: {
          API_KEY: 'xxx',
          'Private-Key': 'yyy',
          API__TOKEN: 'zzz',
        },
      }),
    );
    expect(e.metadata!.API_KEY).toBe(REDACTED_VALUE);
    expect(e.metadata!['Private-Key']).toBe(REDACTED_VALUE);
    expect(e.metadata!.API__TOKEN).toBe(REDACTED_VALUE);
  });

  it('nested objects: secret-named container redacted wholesale', () => {
    // `credentials` itself matches the secret pattern — the whole
    // sub-object redacts to the marker string rather than leaking any
    // of its children. Safer default than selective leaf redaction.
    const e = buildAuditEvent(
      input({
        metadata: {
          user: {
            id: 'u1',
            credentials: { token: 'secret-token', device: 'laptop' },
          },
        },
      }),
    );
    expect(e.metadata).toBeDefined();
    const user = e.metadata!.user as { id: string; credentials: unknown };
    expect(user.id).toBe('u1');
    expect(user.credentials).toBe(REDACTED_VALUE);
  });

  it('nested non-secret containers recurse into leaf secrets', () => {
    const e = buildAuditEvent(
      input({
        metadata: {
          request: {
            id: 'r1',
            body: { password: 'x', keep: 'y' },
          },
        },
      }),
    );
    const body = (e.metadata!.request as { body: Record<string, unknown> }).body;
    expect(body.password).toBe(REDACTED_VALUE);
    expect(body.keep).toBe('y');
  });

  it('arrays preserved but their contents recursed', () => {
    const e = buildAuditEvent(
      input({
        metadata: {
          entries: [
            { ok: 1 },
            { password: 'x' },
          ],
        },
      }),
    );
    const arr = e.metadata!.entries as Array<Record<string, unknown>>;
    expect(arr[0]!.ok).toBe(1);
    expect(arr[1]!.password).toBe(REDACTED_VALUE);
  });

  it('extraSecretKeys adds to the redaction set', () => {
    const e = buildAuditEvent(
      input({ metadata: { myCustomSecret: 'x', ok: 1 } }),
      { extraSecretKeys: ['mycustomsecret'] },
    );
    expect(e.metadata!.myCustomSecret).toBe(REDACTED_VALUE);
    expect(e.metadata!.ok).toBe(1);
  });

  it('no metadata → null', () => {
    const e = buildAuditEvent(input());
    expect(e.metadata).toBeNull();
  });

  it('SECRET_KEY_PATTERNS contains expected entries', () => {
    expect(SECRET_KEY_PATTERNS).toContain('password');
    expect(SECRET_KEY_PATTERNS).toContain('token');
    expect(SECRET_KEY_PATTERNS).toContain('apikey');
  });
});

describe('redactSecrets — directly usable', () => {
  it('redacts top-level secret keys', () => {
    const out = redactSecrets({ password: 'x', ok: 'y' });
    expect(out.password).toBe(REDACTED_VALUE);
    expect(out.ok).toBe('y');
  });

  it('handles circular references gracefully', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj.self = obj;
    const out = redactSecrets(obj);
    expect(out.name).toBe('x');
    expect(out.self).toBe('<circular>');
  });
});

describe('buildAuditEvent — actor role variations', () => {
  it.each([
    ['user without did', { role: 'user' as const }],
    ['user with did', { role: 'user' as const, did: 'did:plc:a' }],
    ['brain', { role: 'brain' as const }],
    ['agent with did', { role: 'agent' as const, did: 'did:plc:ag' }],
    ['admin without did', { role: 'admin' as const }],
  ] as const)('accepts %s', (_l, actor) => {
    const e = buildAuditEvent(input({ actor }));
    expect(e.actor).toEqual(actor);
  });
});
