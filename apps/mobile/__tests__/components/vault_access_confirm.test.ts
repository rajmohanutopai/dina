/**
 * The confirm dialog for an agent's vault access names the agent and the vault.
 * It used to read "someone not in your contacts (no params)" for the owner's own
 * paired device.
 */

import { vaultAccessConfirmLine } from '../../src/components/approval_inbox';

describe('vaultAccessConfirmLine', () => {
  it('says who wants which vault', () => {
    const line = vaultAccessConfirmLine({
      kind: 'vault_read',
      accessMode: 'read',
      capability: 'health',
    });
    expect(line).toBe('A paired agent wants to read your health vault for the next hour.');
  });

  it('a write is called a write, and the agent named when known', () => {
    expect(
      vaultAccessConfirmLine({
        kind: 'vault_read',
        accessMode: 'write',
        capability: 'work',
        requesterName: 'Office Claude',
        paramsPreview: 'Save the notes',
      }),
    ).toBe('Office Claude wants to write to your work vault for the next hour.\nSave the notes');
  });

  it('leaves other cards to the general wording', () => {
    expect(vaultAccessConfirmLine({ kind: 'vault_read', capability: 'health' })).toBeNull();
    expect(
      vaultAccessConfirmLine({ kind: 'service_query', accessMode: 'read', capability: 'x' }),
    ).toBeNull();
  });
});
