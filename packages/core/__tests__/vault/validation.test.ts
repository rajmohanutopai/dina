/**
 * Vault domain validation tests — data integrity at ingest.
 *
 * Validates: item type enum, sender_trust enum, confidence enum,
 * retrieval_policy enum, enrichment_status enum, body size limit.
 */

import {
  VALID_VAULT_ITEM_TYPES,
  VALID_SENDER_TRUST,
  VALID_CONFIDENCE,
  VALID_RETRIEVAL_POLICY,
  VALID_ENRICHMENT_STATUS,
  MAX_VAULT_ITEM_SIZE,
  validateVaultItem,
} from '../../src/vault/validation';
import { storeItem, clearVaults } from '../../src/vault/crud';

describe('Vault Domain Validation', () => {
  describe('validation sets', () => {
    it('has 23 valid item types', () => {
      expect(VALID_VAULT_ITEM_TYPES.size).toBe(23);
      expect(VALID_VAULT_ITEM_TYPES.has('note')).toBe(true);
      expect(VALID_VAULT_ITEM_TYPES.has('email')).toBe(true);
      expect(VALID_VAULT_ITEM_TYPES.has('medical_record')).toBe(true);
      expect(VALID_VAULT_ITEM_TYPES.has('trust_attestation')).toBe(true);
    });

    it('has valid sender_trust values including empty string', () => {
      expect(VALID_SENDER_TRUST.has('self')).toBe(true);
      expect(VALID_SENDER_TRUST.has('contact_ring1')).toBe(true);
      expect(VALID_SENDER_TRUST.has('unknown')).toBe(true);
      expect(VALID_SENDER_TRUST.has('')).toBe(true);
      expect(VALID_SENDER_TRUST.has('invalid')).toBe(false);
    });

    it('has valid confidence levels', () => {
      expect(VALID_CONFIDENCE.has('high')).toBe(true);
      expect(VALID_CONFIDENCE.has('medium')).toBe(true);
      expect(VALID_CONFIDENCE.has('low')).toBe(true);
      expect(VALID_CONFIDENCE.has('unverified')).toBe(true);
    });

    it('max item size is 10 MiB', () => {
      expect(MAX_VAULT_ITEM_SIZE).toBe(10 * 1024 * 1024);
    });
  });

  describe('validateVaultItem', () => {
    it('accepts valid items', () => {
      expect(
        validateVaultItem({
          type: 'note',
          sender_trust: 'self',
          confidence: 'high',
          retrieval_policy: 'normal',
          enrichment_status: 'pending',
        }),
      ).toBeNull();
    });

    it('accepts items with empty/default fields', () => {
      expect(validateVaultItem({})).toBeNull();
      expect(validateVaultItem({ type: 'email' })).toBeNull();
    });

    it('rejects invalid item type', () => {
      const err = validateVaultItem({ type: 'invalid_type' });
      expect(err).toContain('invalid item type');
      expect(err).toContain('invalid_type');
    });

    it('rejects invalid sender_trust', () => {
      expect(validateVaultItem({ sender_trust: 'supertrustworthy' })).toContain(
        'invalid sender_trust',
      );
    });

    it('rejects invalid confidence', () => {
      expect(validateVaultItem({ confidence: 'very_high' })).toContain('invalid confidence');
    });

    it('rejects invalid retrieval_policy', () => {
      expect(validateVaultItem({ retrieval_policy: 'allow_everything' })).toContain(
        'invalid retrieval_policy',
      );
    });

    it('rejects invalid enrichment_status', () => {
      expect(validateVaultItem({ enrichment_status: 'enriching' })).toContain(
        'invalid enrichment_status',
      );
    });

    it('rejects oversized body', () => {
      const bigBody = 'x'.repeat(MAX_VAULT_ITEM_SIZE + 1);
      expect(validateVaultItem({ body: bigBody })).toContain('exceeds maximum size');
    });

    it('accepts body at exactly max size', () => {
      const maxBody = 'x'.repeat(MAX_VAULT_ITEM_SIZE);
      expect(validateVaultItem({ body: maxBody })).toBeNull();
    });
  });

  describe('storeItem integration', () => {
    beforeEach(() => clearVaults());

    it('stores items with valid types', () => {
      const id = storeItem('general', { type: 'note', summary: 'test' });
      expect(id).toBeTruthy();
    });

    it('throws on invalid type', () => {
      expect(() => storeItem('general', { type: 'bogus' })).toThrow('invalid item type');
    });

    it('throws on invalid sender_trust', () => {
      expect(() => storeItem('general', { sender_trust: 'bogus' })).toThrow('invalid sender_trust');
    });

    it('throws on invalid confidence', () => {
      expect(() => storeItem('general', { confidence: 'bogus' })).toThrow('invalid confidence');
    });

    it('accepts all 23 valid item types', () => {
      for (const type of VALID_VAULT_ITEM_TYPES) {
        expect(() => storeItem('general', { type, summary: type })).not.toThrow();
      }
    });
  });
});
