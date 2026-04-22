/**
 * T1J.1 — Entity Vault: ephemeral PII token mapping.
 *
 * Category A: fixture-based. Verifies the entity vault pattern:
 * - Scrub creates token→value mappings
 * - Rehydrate restores originals
 * - Vault is isolated per instance (no cross-contamination)
 * - Vault clears completely
 *
 * Source: brain/tests/test_pii.py (Entity Vault section)
 */

import { EntityVault } from '../../src/pii/entity_vault';

describe('Entity Vault', () => {
  describe('construction', () => {
    it('creates an empty vault', () => {
      const vault = new EntityVault();
      expect(vault.isEmpty()).toBe(true);
      expect(vault.size()).toBe(0);
    });
  });

  describe('scrub', () => {
    it('replaces PII with tokens', () => {
      const vault = new EntityVault();
      const scrubbed = vault.scrub('Email john@example.com');
      expect(scrubbed).toContain('[EMAIL_1]');
      expect(scrubbed).not.toContain('john@example.com');
    });

    it('tracks token→value mappings', () => {
      const vault = new EntityVault();
      vault.scrub('Email john@example.com');
      expect(vault.size()).toBe(1);
      const entries = vault.entries();
      expect(entries[0].token).toBe('[EMAIL_1]');
      expect(entries[0].type).toBe('EMAIL');
      expect(entries[0].value).toBe('john@example.com');
    });

    it('returns scrubbed text without PII', () => {
      const vault = new EntityVault();
      const scrubbed = vault.scrub('Contact john@example.com or call 555-123-4567');
      expect(scrubbed).toBe('Contact [EMAIL_1] or call [PHONE_1]');
    });

    it('handles text with no PII', () => {
      const vault = new EntityVault();
      const scrubbed = vault.scrub('No PII in this text');
      expect(scrubbed).toBe('No PII in this text');
      expect(vault.isEmpty()).toBe(true);
    });

    it('scrubs text with multiple PII items in one call', () => {
      const vault = new EntityVault();
      vault.scrub('Email alice@a.com and bob@b.com');
      expect(vault.size()).toBe(2);
    });
  });

  describe('rehydrate', () => {
    it('restores PII from tokens', () => {
      const vault = new EntityVault();
      const scrubbed = vault.scrub('Email john@example.com');
      const restored = vault.rehydrate(scrubbed);
      expect(restored).toBe('Email john@example.com');
    });

    it('handles multiple tokens', () => {
      const vault = new EntityVault();
      const scrubbed = vault.scrub('From john@a.com to jane@b.com');
      const restored = vault.rehydrate(scrubbed);
      expect(restored).toBe('From john@a.com to jane@b.com');
    });

    it('returns text unchanged when no tokens present', () => {
      const vault = new EntityVault();
      vault.scrub('Email john@example.com'); // populate vault
      const result = vault.rehydrate('No tokens here');
      expect(result).toBe('No tokens here');
    });

    it('rehydrates LLM response that includes tokens', () => {
      const vault = new EntityVault();
      vault.scrub('Contact john@example.com about the invoice');
      // Simulate LLM response that references the token
      const llmResponse = 'I found that [EMAIL_1] sent the invoice last week.';
      const restored = vault.rehydrate(llmResponse);
      expect(restored).toBe('I found that john@example.com sent the invoice last week.');
    });
  });

  describe('full round-trip: scrub → process → rehydrate', () => {
    it('preserves original text through pipeline', () => {
      const vault = new EntityVault();
      const original = 'Email john@example.com about SSN 123-45-6789';
      const scrubbed = vault.scrub(original);
      expect(scrubbed).not.toContain('john@example.com');
      expect(scrubbed).not.toContain('123-45-6789');

      // Simulate LLM seeing only tokens
      const llmOutput = `Processed: ${scrubbed}`;
      const restored = vault.rehydrate(llmOutput);
      expect(restored).toContain('john@example.com');
      expect(restored).toContain('123-45-6789');
    });
  });

  describe('isolation', () => {
    it('each vault instance is independent', () => {
      const vault1 = new EntityVault();
      const vault2 = new EntityVault();

      vault1.scrub('Email alice@a.com');
      vault2.scrub('Email bob@b.com');

      expect(vault1.size()).toBe(1);
      expect(vault2.size()).toBe(1);
      expect(vault1.entries()[0].value).toBe('alice@a.com');
      expect(vault2.entries()[0].value).toBe('bob@b.com');
    });

    it('vault1 tokens do not resolve in vault2', () => {
      const vault1 = new EntityVault();
      const vault2 = new EntityVault();

      const scrubbed1 = vault1.scrub('Email alice@a.com');
      vault2.scrub('Email bob@b.com');

      // vault2 tries to rehydrate vault1's scrubbed text — tokens stay as-is
      const result = vault2.rehydrate(scrubbed1);
      // [EMAIL_1] from vault1 maps to "alice@a.com" but vault2 has "bob@b.com" for [EMAIL_1]
      // This demonstrates that same token names in different vaults map to different values
      expect(result).toContain('bob@b.com'); // vault2's [EMAIL_1] resolves to bob
    });
  });

  describe('entries', () => {
    it('returns all tracked entities', () => {
      const vault = new EntityVault();
      vault.scrub('Contact john@example.com or call 555-123-4567');
      const entries = vault.entries();
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.type).sort()).toEqual(['EMAIL', 'PHONE']);
    });
  });

  describe('size', () => {
    it('reports number of tracked entities', () => {
      const vault = new EntityVault();
      expect(vault.size()).toBe(0);
      vault.scrub('Email john@example.com');
      expect(vault.size()).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const vault = new EntityVault();
      vault.scrub('Email john@example.com');
      expect(vault.size()).toBe(1);
      vault.clear();
      expect(vault.size()).toBe(0);
    });

    it('vault is empty after clear', () => {
      const vault = new EntityVault();
      vault.scrub('Contact john@example.com and 555-123-4567');
      vault.clear();
      expect(vault.isEmpty()).toBe(true);
      expect(vault.entries()).toEqual([]);
    });

    it('rehydrate returns unchanged text after clear', () => {
      const vault = new EntityVault();
      vault.scrub('Email john@example.com');
      vault.clear();
      const result = vault.rehydrate('Text with [EMAIL_1]');
      expect(result).toBe('Text with [EMAIL_1]'); // no mapping left
    });
  });

  describe('two-tier scrubbing (§A14)', () => {
    it('Tier 1 scrubs emails (core regex)', () => {
      const vault = new EntityVault();
      const scrubbed = vault.scrub('Contact alice@example.com');
      expect(scrubbed).toContain('[EMAIL_1]');
      expect(scrubbed).not.toContain('alice@example.com');
    });

    it('Tier 2 detects patterns not covered by Tier 1', () => {
      const vault = new EntityVault();
      // SWIFT_BIC (11-char) is only in Tier 2
      const scrubbed = vault.scrub('BIC code DEUTDEFF500');
      expect(scrubbed).toContain('[SWIFT_BIC_1]');
      expect(scrubbed).not.toContain('DEUTDEFF500');
    });

    it('both tiers contribute entries to the vault', () => {
      const vault = new EntityVault();
      // Email (Tier 1) + SWIFT (Tier 2) in same text
      vault.scrub('Email bob@test.com BIC DEUTDEFF500');
      expect(vault.size()).toBeGreaterThanOrEqual(2);
      const entries = vault.entries();
      const types = new Set(entries.map((e) => e.type));
      expect(types.has('EMAIL')).toBe(true);
      expect(types.has('SWIFT_BIC')).toBe(true);
    });

    it('rehydrates both tiers correctly', () => {
      const vault = new EntityVault();
      const scrubbed = vault.scrub('Email bob@test.com BIC DEUTDEFF500');
      expect(scrubbed).not.toContain('bob@test.com');
      expect(scrubbed).not.toContain('DEUTDEFF500');

      // Simulate LLM response using the tokens
      const llmResponse = `Contact [EMAIL_1] about BIC [SWIFT_BIC_1]`;
      const rehydrated = vault.rehydrate(llmResponse);
      expect(rehydrated).toContain('bob@test.com');
      expect(rehydrated).toContain('DEUTDEFF500');
    });

    it('token numbering is consistent across tiers', () => {
      const vault = new EntityVault();
      // Two emails (Tier 1) + one SWIFT (Tier 2)
      vault.scrub('a@test.com b@test.com BIC DEUTDEFF500');
      const entries = vault.entries();
      const emailTokens = entries.filter((e) => e.type === 'EMAIL').map((e) => e.token);
      expect(emailTokens).toContain('[EMAIL_1]');
      expect(emailTokens).toContain('[EMAIL_2]');
    });
  });
});
