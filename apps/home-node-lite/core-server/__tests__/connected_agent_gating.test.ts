import { createCodingGate } from '../src/gate/coding_gate_impl';

import type { AuthorityOrigin, CodingGateInput } from '@dina/core';

const ownerOrigin: AuthorityOrigin = {
  kind: 'owner_interactive',
  ownerDid: 'did:plc:owner',
  requesterDid: 'did:plc:owner',
  ingress: 'coding_host',
  correlationId: 'sess-1',
  authenticatedAtMs: 1,
};

function input(over: Partial<CodingGateInput> = {}): CodingGateInput {
  return {
    toolName: 'Read',
    toolInput: { file_path: '/workspace/src/a.ts' },
    agentDid: 'did:key:agent',
    sessionId: 'sess-1',
    cwd: '/workspace',
    mode: 'enforce',
    profile: 'full_supervision',
    authorityOrigin: ownerOrigin,
    policyVersion: 3,
    ...over,
  };
}

describe('connected-agent three-profile gate', () => {
  const gate = createCodingGate({ vaultDir: '/private/dina-vault' });

  it('delegates ordinary owner work to the host in Network Protection', () => {
    const result = gate.gate(input({ profile: 'network_protection' }));
    expect(result).toMatchObject({
      action: 'host_managed',
      outcome: 'allow',
      enforced: false,
      auditLevel: 'none',
      profile: 'network_protection',
    });
    expect(result.permitId).toBeUndefined();
  });

  it('hard-denies protected paths in Network Protection', () => {
    const result = gate.gate(
      input({
        profile: 'network_protection',
        toolInput: { file_path: '/private/dina-vault/identity.sqlite' },
      }),
    );
    expect(result).toMatchObject({
      outcome: 'deny',
      risk: 'BLOCKED',
      auditLevel: 'kernel',
    });
  });

  it('keeps ordinary edits host-managed in Sensitive Boundaries', () => {
    const result = gate.gate(
      input({
        profile: 'sensitive_boundaries',
        toolName: 'Write',
        toolInput: { file_path: '/workspace/src/a.ts', content: 'x' },
      }),
    );
    expect(result).toMatchObject({
      action: 'host_managed',
      outcome: 'allow',
      enforced: false,
      auditLevel: 'none',
    });
  });

  it('gates external effects in Sensitive Boundaries', () => {
    const result = gate.gate(
      input({
        profile: 'sensitive_boundaries',
        toolName: 'Bash',
        toolInput: { command: 'git push origin main' },
      }),
    );
    expect(result).toMatchObject({
      action: 'vcs_push',
      outcome: 'approval_required',
      enforced: true,
      auditLevel: 'boundary',
    });
  });

  it('escalates unknown tools in Sensitive Boundaries', () => {
    const result = gate.gate(
      input({
        profile: 'sensitive_boundaries',
        toolName: 'third_party.send',
        toolInput: { value: 'x' },
      }),
    );
    expect(result).toMatchObject({
      action: 'code_edit_external',
      outcome: 'approval_required',
      auditLevel: 'boundary',
    });
  });

  it('retains existing permit-backed classification in Full Supervision', () => {
    const result = gate.gate(input());
    expect(result).toMatchObject({
      action: 'code_read',
      outcome: 'allow',
      enforced: true,
      auditLevel: 'full',
    });
    expect(result.permitId).toMatch(/^permit_/);
  });
});
