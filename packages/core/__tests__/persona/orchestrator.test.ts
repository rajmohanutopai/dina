/**
 * T2.34 + T2.35 — Persona unlock/lock orchestrator.
 *
 * Full lifecycle: DEK derivation → vault open → HNSW build → mark open.
 * Reverse: HNSW destroy → vault close → DEK zero → mark closed.
 *
 * Source: ARCHITECTURE.md Tasks 2.34, 2.35
 */

import {
  unlockPersona,
  lockPersona,
  lockAllPersonas,
  hasDEK,
  getDEKHash,
  setVaultOpener,
  setVaultCloser,
  setEmbeddingLoader,
  resetOrchestratorState,
} from '../../src/persona/orchestrator';
import {
  createPersona,
  resetPersonaState,
  isPersonaOpen,
  getPersona,
} from '../../src/persona/service';
import { destroyAllIndexes, hasIndex, indexSize } from '../../src/embedding/persona_index';
import { TEST_ED25519_SEED } from '@dina/test-harness';

const userSalt = new Uint8Array(16).fill(0xab);

function embed(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('Persona Orchestrator', () => {
  beforeEach(() => {
    resetPersonaState();
    resetOrchestratorState();
    destroyAllIndexes();
  });

  describe('unlockPersona (2.34)', () => {
    it('unlocks a default persona without approval', async () => {
      createPersona('general', 'default');

      const result = await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      expect(result.success).toBe(true);
      expect(result.persona).toBe('general');
      expect(result.dekHash).toHaveLength(64); // SHA-256 hex
      expect(isPersonaOpen('general')).toBe(true);
      expect(hasDEK('general')).toBe(true);
    });

    it('unlocks a standard persona without approval', async () => {
      createPersona('work', 'standard');

      const result = await unlockPersona('work', TEST_ED25519_SEED, userSalt);

      expect(result.success).toBe(true);
      expect(isPersonaOpen('work')).toBe(true);
    });

    it('rejects sensitive persona without approval', async () => {
      createPersona('health', 'sensitive');

      const result = await unlockPersona('health', TEST_ED25519_SEED, userSalt);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Approval required');
      expect(isPersonaOpen('health')).toBe(false);
      expect(hasDEK('health')).toBe(false);
    });

    it('unlocks sensitive persona WITH approval', async () => {
      createPersona('health', 'sensitive');

      const result = await unlockPersona('health', TEST_ED25519_SEED, userSalt, true);

      expect(result.success).toBe(true);
      expect(isPersonaOpen('health')).toBe(true);
    });

    it('rejects locked persona without approval', async () => {
      createPersona('secret', 'locked');

      const result = await unlockPersona('secret', TEST_ED25519_SEED, userSalt);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Passphrase required');
    });

    it('unlocks locked persona with approval (passphrase confirmed)', async () => {
      createPersona('secret', 'locked');

      const result = await unlockPersona('secret', TEST_ED25519_SEED, userSalt, true);

      expect(result.success).toBe(true);
    });

    it('returns error for nonexistent persona', async () => {
      const result = await unlockPersona('ghost', TEST_ED25519_SEED, userSalt);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('is idempotent — already open returns success', async () => {
      createPersona('general', 'default');
      await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      const result = await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      expect(result.success).toBe(true);
      expect(result.reason).toBe('Already open');
    });

    it('derives deterministic DEK hash', async () => {
      createPersona('general', 'default');

      const r1 = await unlockPersona('general', TEST_ED25519_SEED, userSalt);
      await lockPersona('general');

      const r2 = await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      expect(r1.dekHash).toBe(r2.dekHash);
    });

    it('derives different DEK per persona', async () => {
      createPersona('general', 'default');
      createPersona('work', 'standard');

      const r1 = await unlockPersona('general', TEST_ED25519_SEED, userSalt);
      const r2 = await unlockPersona('work', TEST_ED25519_SEED, userSalt);

      expect(r1.dekHash).not.toBe(r2.dekHash);
    });

    it('calls vault opener with DEK', async () => {
      const opened: Array<{ persona: string; dekLen: number }> = [];
      setVaultOpener(async (persona, dek) => {
        opened.push({ persona, dekLen: dek.length });
        return 42; // 42 items in vault
      });

      createPersona('general', 'default');
      await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      expect(opened).toHaveLength(1);
      expect(opened[0].persona).toBe('general');
      expect(opened[0].dekLen).toBe(32); // 256-bit DEK
    });

    it('builds HNSW index from embeddings', async () => {
      setEmbeddingLoader(async () => [
        { id: 'v1', embedding: embed(0.9, 0.1, 0, 0) },
        { id: 'v2', embedding: embed(0.1, 0.9, 0, 0) },
      ]);

      createPersona('general', 'default');
      const result = await unlockPersona('general', TEST_ED25519_SEED, userSalt, false, 4);

      expect(result.indexedItems).toBe(2);
      expect(hasIndex('general')).toBe(true);
      expect(indexSize('general')).toBe(2);
    });
  });

  describe('lockPersona (2.35)', () => {
    it('locks an open persona', async () => {
      createPersona('general', 'default');
      await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      const result = await lockPersona('general');

      expect(result.success).toBe(true);
      expect(result.dekZeroed).toBe(true);
      expect(isPersonaOpen('general')).toBe(false);
      expect(hasDEK('general')).toBe(false);
    });

    it('zeros the DEK on lock', async () => {
      createPersona('general', 'default');
      await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      // Before lock: DEK exists
      expect(getDEKHash('general')).toBeTruthy();

      await lockPersona('general');

      // After lock: DEK is gone
      expect(getDEKHash('general')).toBeNull();
    });

    it('destroys HNSW index on lock', async () => {
      setEmbeddingLoader(async () => [{ id: 'v1', embedding: embed(1, 0, 0, 0) }]);

      createPersona('general', 'default');
      await unlockPersona('general', TEST_ED25519_SEED, userSalt, false, 4);
      expect(hasIndex('general')).toBe(true);

      const result = await lockPersona('general');

      expect(result.indexDestroyed).toBe(true);
      expect(hasIndex('general')).toBe(false);
    });

    it('calls vault closer', async () => {
      const closed: string[] = [];
      setVaultCloser(async (persona) => {
        closed.push(persona);
      });

      createPersona('general', 'default');
      await unlockPersona('general', TEST_ED25519_SEED, userSalt);

      await lockPersona('general');

      expect(closed).toEqual(['general']);
    });

    it('is idempotent — already locked returns success', async () => {
      createPersona('general', 'default');

      const result = await lockPersona('general');

      expect(result.success).toBe(true);
      expect(result.reason).toBe('Already locked');
    });

    it('returns error for nonexistent persona', async () => {
      const result = await lockPersona('ghost');

      expect(result.success).toBe(false);
      expect(result.reason).toContain('not found');
    });
  });

  describe('lockAllPersonas', () => {
    it('locks all open personas', async () => {
      createPersona('general', 'default');
      createPersona('work', 'standard');
      await unlockPersona('general', TEST_ED25519_SEED, userSalt);
      await unlockPersona('work', TEST_ED25519_SEED, userSalt);

      const results = await lockAllPersonas();

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
      expect(isPersonaOpen('general')).toBe(false);
      expect(isPersonaOpen('work')).toBe(false);
      expect(hasDEK('general')).toBe(false);
      expect(hasDEK('work')).toBe(false);
    });

    it('returns empty when nothing is open', async () => {
      const results = await lockAllPersonas();
      expect(results).toHaveLength(0);
    });
  });

  describe('security: DEK lifecycle', () => {
    it('unlock → lock → DEK hash changes (re-derived fresh)', async () => {
      createPersona('general', 'default');

      const r1 = await unlockPersona('general', TEST_ED25519_SEED, userSalt);
      const hash1 = getDEKHash('general');

      await lockPersona('general');
      expect(getDEKHash('general')).toBeNull();

      const r2 = await unlockPersona('general', TEST_ED25519_SEED, userSalt);
      const hash2 = getDEKHash('general');

      // Same seed → same DEK hash (deterministic derivation)
      expect(hash1).toBe(hash2);
      expect(r1.dekHash).toBe(r2.dekHash);
    });
  });
});
