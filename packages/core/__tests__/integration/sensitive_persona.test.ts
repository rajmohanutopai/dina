/**
 * T1.54 — Sensitive persona manual unlock: end-to-end integration test.
 *
 * Full lifecycle: create → reject without approval → approve → unlock →
 * verify open → store item → search → lock → verify closed → DEK gone.
 *
 * Source: ARCHITECTURE.md Task 1.54
 */

import {
  createPersona,
  resetPersonaState,
  isPersonaOpen,
  listPersonas,
} from '../../src/persona/service';
import {
  unlockPersona,
  lockPersona,
  hasDEK,
  getDEKHash,
  setVaultOpener,
  setVaultCloser,
  setEmbeddingLoader,
  resetOrchestratorState,
} from '../../src/persona/orchestrator';
import { storeItem, queryVault, clearVaults } from '../../src/vault/crud';
import { destroyAllIndexes, hasIndex } from '../../src/embedding/persona_index';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const userSalt = new Uint8Array(16).fill(0xcd);

describe('Sensitive Persona Manual Unlock (1.54)', () => {
  beforeEach(() => {
    resetPersonaState();
    resetOrchestratorState();
    destroyAllIndexes();
    clearVaults();
  });

  it('full lifecycle: create → reject → approve → use → lock', async () => {
    // 1. Create personas: general (default) + health (sensitive)
    createPersona('general', 'default');
    createPersona('health', 'sensitive');

    expect(listPersonas()).toHaveLength(2);

    // 2. Unlock general — auto (no approval needed)
    const generalResult = await unlockPersona('general', TEST_ED25519_SEED, userSalt);
    expect(generalResult.success).toBe(true);
    expect(isPersonaOpen('general')).toBe(true);

    // 3. Try to unlock health WITHOUT approval → rejected
    const rejectResult = await unlockPersona('health', TEST_ED25519_SEED, userSalt);
    expect(rejectResult.success).toBe(false);
    expect(rejectResult.reason).toContain('Approval required');
    expect(isPersonaOpen('health')).toBe(false);
    expect(hasDEK('health')).toBe(false);

    // 4. Unlock health WITH approval → success
    const approveResult = await unlockPersona('health', TEST_ED25519_SEED, userSalt, true);
    expect(approveResult.success).toBe(true);
    expect(isPersonaOpen('health')).toBe(true);
    expect(hasDEK('health')).toBe(true);

    // 5. Store items in the health vault
    const itemId = storeItem('health', {
      summary: 'Blood pressure 120/80',
      type: 'medical_record',
      body: 'Measured at Dr. Smith office',
    });
    expect(itemId).toBeTruthy();

    // 6. Search the health vault
    const results = queryVault('health', { mode: 'fts5', text: 'blood pressure', limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain('Blood pressure');

    // 7. General vault is isolated from health
    const crossResults = queryVault('general', { mode: 'fts5', text: 'blood pressure', limit: 10 });
    expect(crossResults).toHaveLength(0);

    // 8. Lock health → DEK zeroed, persona closed
    const lockResult = await lockPersona('health');
    expect(lockResult.success).toBe(true);
    expect(lockResult.dekZeroed).toBe(true);
    expect(isPersonaOpen('health')).toBe(false);
    expect(hasDEK('health')).toBe(false);
    expect(getDEKHash('health')).toBeNull();

    // 9. General stays open
    expect(isPersonaOpen('general')).toBe(true);
    expect(hasDEK('general')).toBe(true);
  });

  it('locked tier requires passphrase confirmation', async () => {
    createPersona('secret', 'locked');

    // Without approval (simulates missing passphrase re-entry)
    const noPassResult = await unlockPersona('secret', TEST_ED25519_SEED, userSalt);
    expect(noPassResult.success).toBe(false);
    expect(noPassResult.reason).toContain('Passphrase required');

    // With approval (simulates passphrase confirmed)
    const withPassResult = await unlockPersona('secret', TEST_ED25519_SEED, userSalt, true);
    expect(withPassResult.success).toBe(true);
    expect(isPersonaOpen('secret')).toBe(true);
  });

  it('DEK is unique per persona (isolation)', async () => {
    createPersona('general', 'default');
    createPersona('health', 'sensitive');

    await unlockPersona('general', TEST_ED25519_SEED, userSalt);
    await unlockPersona('health', TEST_ED25519_SEED, userSalt, true);

    const generalDEK = getDEKHash('general');
    const healthDEK = getDEKHash('health');

    expect(generalDEK).toBeTruthy();
    expect(healthDEK).toBeTruthy();
    expect(generalDEK).not.toBe(healthDEK);
  });

  it('unlock → lock → re-unlock produces same DEK', async () => {
    createPersona('health', 'sensitive');

    await unlockPersona('health', TEST_ED25519_SEED, userSalt, true);
    const hash1 = getDEKHash('health');

    await lockPersona('health');

    await unlockPersona('health', TEST_ED25519_SEED, userSalt, true);
    const hash2 = getDEKHash('health');

    expect(hash1).toBe(hash2);
  });

  it('HNSW index lifecycle follows persona unlock/lock', async () => {
    setEmbeddingLoader(async () => [{ id: 'v1', embedding: new Float32Array([0.9, 0.1, 0, 0]) }]);

    createPersona('health', 'sensitive');

    // Before unlock — no index
    expect(hasIndex('health')).toBe(false);

    // Unlock — index built
    await unlockPersona('health', TEST_ED25519_SEED, userSalt, true, 4);
    expect(hasIndex('health')).toBe(true);

    // Lock — index destroyed
    await lockPersona('health');
    expect(hasIndex('health')).toBe(false);
  });

  it('standard tier auto-unlocks without approval', async () => {
    createPersona('work', 'standard');

    const result = await unlockPersona('work', TEST_ED25519_SEED, userSalt);
    expect(result.success).toBe(true);
    expect(isPersonaOpen('work')).toBe(true);
  });

  it('default tier auto-unlocks without approval', async () => {
    createPersona('general', 'default');

    const result = await unlockPersona('general', TEST_ED25519_SEED, userSalt);
    expect(result.success).toBe(true);
  });
});
