/**
 * Item 5 — typed-origin vault capability tests.
 *
 * The invariant: a read/search origin can NEVER write or delete; writes belong
 * to owner + ingest; deletes belong to owner alone. Unknown origin/operation is
 * fail-closed (denied), prototype-pollution-safe.
 */

import {
  checkVaultCapability,
  isVaultOperationAllowed,
  isVaultOrigin,
  PERSONA_GATED_ORIGINS,
  VAULT_ORIGINS,
  type VaultCapability,
  type VaultOperation,
  type VaultOrigin,
} from '../../src/vault/origin_capability';

describe('origin × operation matrix', () => {
  const expected: Record<VaultOrigin, Record<VaultOperation, boolean>> = {
    owner_request: { read: true, search: true, write: true, delete: true },
    staging_item: { read: true, search: false, write: true, delete: false },
    service_task: { read: true, search: true, write: false, delete: false },
    agent_ask: { read: true, search: true, write: false, delete: false },
  };

  for (const origin of VAULT_ORIGINS) {
    for (const op of ['read', 'search', 'write', 'delete'] as VaultOperation[]) {
      it(`${origin} × ${op} → ${expected[origin][op]}`, () => {
        expect(isVaultOperationAllowed(origin, op)).toBe(expected[origin][op]);
      });
    }
  }

  it('the core invariant: no read-origin may write or delete', () => {
    for (const origin of ['service_task', 'agent_ask'] as VaultOrigin[]) {
      expect(isVaultOperationAllowed(origin, 'write')).toBe(false);
      expect(isVaultOperationAllowed(origin, 'delete')).toBe(false);
    }
  });

  it('only the owner may delete', () => {
    for (const origin of VAULT_ORIGINS) {
      expect(isVaultOperationAllowed(origin, 'delete')).toBe(origin === 'owner_request');
    }
  });
});

describe('fail-closed lookups', () => {
  it('unknown origin → denied', () => {
    expect(isVaultOperationAllowed('brain', 'read')).toBe(false);
    expect(isVaultOrigin('brain')).toBe(false);
  });
  it('unknown operation → denied', () => {
    expect(isVaultOperationAllowed('owner_request', 'exfiltrate')).toBe(false);
  });
  it('prototype keys never resolve (pollution-safe)', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(isVaultOrigin(key)).toBe(false);
      expect(isVaultOperationAllowed(key, 'read')).toBe(false);
      expect(isVaultOperationAllowed('owner_request', key)).toBe(false);
    }
  });
});

describe('PERSONA_GATED_ORIGINS', () => {
  it('marks the read origins that still need the persona gate', () => {
    expect(PERSONA_GATED_ORIGINS.has('agent_ask')).toBe(true);
    expect(PERSONA_GATED_ORIGINS.has('service_task')).toBe(true);
    expect(PERSONA_GATED_ORIGINS.has('owner_request')).toBe(false);
    expect(PERSONA_GATED_ORIGINS.has('staging_item')).toBe(false);
  });
});

describe('checkVaultCapability', () => {
  const agentCap: VaultCapability = { origin: 'agent_ask', principal: 'did:key:z6MkAgent' };

  it('allows an agent read', () => {
    expect(checkVaultCapability(agentCap, 'read')).toEqual({ ok: true });
  });
  it('denies an agent write', () => {
    expect(checkVaultCapability(agentCap, 'write')).toEqual({ ok: false, reason: 'operation_denied' });
  });
  it('denies an agent delete', () => {
    expect(checkVaultCapability(agentCap, 'delete')).toEqual({ ok: false, reason: 'operation_denied' });
  });
  it('allows the owner everything', () => {
    const owner: VaultCapability = { origin: 'owner_request' };
    for (const op of ['read', 'search', 'write', 'delete'] as VaultOperation[]) {
      expect(checkVaultCapability(owner, op)).toEqual({ ok: true });
    }
  });
  it('enforces persona scope when the capability names personas', () => {
    const scoped: VaultCapability = { origin: 'agent_ask', personas: ['general', 'work'] };
    expect(checkVaultCapability(scoped, 'read', 'general')).toEqual({ ok: true });
    expect(checkVaultCapability(scoped, 'read', 'health')).toEqual({
      ok: false,
      reason: 'persona_out_of_scope',
    });
  });
  it('defers persona scope to the persona gate when personas is undefined', () => {
    expect(checkVaultCapability(agentCap, 'read', 'health')).toEqual({ ok: true });
  });
  it('rejects an unknown origin', () => {
    const bad = { origin: 'brain' } as unknown as VaultCapability;
    expect(checkVaultCapability(bad, 'read')).toEqual({ ok: false, reason: 'unknown_origin' });
  });
  it('staging may write but not delete; service may read but not write', () => {
    expect(checkVaultCapability({ origin: 'staging_item' }, 'write')).toEqual({ ok: true });
    expect(checkVaultCapability({ origin: 'staging_item' }, 'delete')).toEqual({
      ok: false,
      reason: 'operation_denied',
    });
    expect(checkVaultCapability({ origin: 'service_task' }, 'read')).toEqual({ ok: true });
    expect(checkVaultCapability({ origin: 'service_task' }, 'write')).toEqual({
      ok: false,
      reason: 'operation_denied',
    });
  });
});
