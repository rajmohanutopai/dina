/**
 * T2.54 — Gatekeeper egress filtering: sharing policy + PII scrub.
 *
 * Source: ARCHITECTURE.md Task 2.54
 */

import { checkEgress, isEgressAllowed } from '../../src/gatekeeper/egress';
import { setSharingPolicy, clearSharingPolicies } from '../../src/gatekeeper/sharing';

describe('Gatekeeper Egress Filtering', () => {
  beforeEach(() => clearSharingPolicies());

  describe('checkEgress', () => {
    it('allows egress with full sharing tier', () => {
      setSharingPolicy('did:plc:friend', 'social', 'full');
      const result = checkEgress(
        { text: 'Hello friend', categories: ['social'], body: 'Full message body' },
        'did:plc:friend',
      );
      expect(result.allowed).toBe(true);
      expect(result.filteredText).toBeTruthy();
      expect(result.filteredBody).toBeTruthy();
      expect(result.appliedTier).toBe('full');
    });

    it('summary tier strips body', () => {
      setSharingPolicy('did:plc:acquaintance', 'social', 'summary');
      const result = checkEgress(
        { text: 'Short summary', categories: ['social'], body: 'Detailed body content' },
        'did:plc:acquaintance',
      );
      expect(result.allowed).toBe(true);
      expect(result.filteredText).toBeTruthy();
      expect(result.filteredBody).toBeUndefined(); // body stripped
      expect(result.appliedTier).toBe('summary');
    });

    it('none tier blocks all data', () => {
      setSharingPolicy('did:plc:stranger', 'health', 'none');
      const result = checkEgress(
        { text: 'Health data', categories: ['health'] },
        'did:plc:stranger',
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedCategories).toContain('health');
    });

    it('scrubs PII from outbound text', () => {
      setSharingPolicy('did:plc:friend', 'social', 'full');
      const result = checkEgress(
        { text: 'Email john@example.com about the meeting', categories: ['social'] },
        'did:plc:friend',
      );
      expect(result.allowed).toBe(true);
      expect(result.filteredText).not.toContain('john@example.com');
      expect(result.filteredText).toContain('[EMAIL_1]');
      expect(result.scrubbed).toBe(true);
    });

    it('scrubs PII from body too', () => {
      setSharingPolicy('did:plc:friend', 'social', 'full');
      const result = checkEgress(
        { text: 'Note', categories: ['social'], body: 'Call 555-123-4567' },
        'did:plc:friend',
      );
      expect(result.filteredBody).not.toContain('555-123-4567');
    });

    it('no PII → scrubbed is false', () => {
      setSharingPolicy('did:plc:friend', 'social', 'full');
      const result = checkEgress(
        { text: 'No personal data here', categories: ['social'] },
        'did:plc:friend',
      );
      expect(result.scrubbed).toBe(false);
    });

    it('unknown contact → denied (default-deny)', () => {
      const result = checkEgress(
        { text: 'Secret data', categories: ['social'] },
        'did:plc:unknown',
      );
      expect(result.allowed).toBe(false);
    });

    it('multiple categories: all must be allowed', () => {
      setSharingPolicy('did:plc:friend', 'social', 'full');
      // 'health' has no policy → 'none' by default
      const result = checkEgress(
        { text: 'Mixed data', categories: ['social', 'health'] },
        'did:plc:friend',
      );
      expect(result.allowed).toBe(false);
      expect(result.blockedCategories).toContain('health');
    });
  });

  describe('isEgressAllowed', () => {
    it('returns true when policy allows', () => {
      setSharingPolicy('did:plc:friend', 'social', 'full');
      expect(isEgressAllowed('did:plc:friend', ['social'])).toBe(true);
    });

    it('returns false when policy denies', () => {
      expect(isEgressAllowed('did:plc:unknown', ['social'])).toBe(false);
    });
  });
});
