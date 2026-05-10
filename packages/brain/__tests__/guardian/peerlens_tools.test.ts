/**
 * Trust-tool registry — single source of truth shared by both guard
 * scanners. Pinning the contract here so a rename or removal is
 * caught immediately rather than silently breaking one of the two
 * downstream callers.
 */

import {
  TRUST_TOOL_NAMES,
  isTrustTool,
  trustToolUsed,
} from '../../src/guardian/peerlens_tools';

describe('peerlens_tools', () => {
  describe('isTrustTool', () => {
    it('matches every canonical name verbatim', () => {
      for (const name of TRUST_TOOL_NAMES) {
        expect(isTrustTool(name)).toBe(true);
      }
    });

    it('matches the peerlens_ prefix family', () => {
      expect(isTrustTool('peerlens_lookup')).toBe(true);
      expect(isTrustTool('peerlens_aggregate')).toBe(true);
      expect(isTrustTool('peerlens_subject_detail')).toBe(true);
    });

    it('matches the peer_lens_ prefix family', () => {
      expect(isTrustTool('peer_lens_lookup')).toBe(true);
      expect(isTrustTool('peer_lens_subject_detail')).toBe(true);
    });

    it('does not match unrelated tools', () => {
      expect(isTrustTool('vault_search')).toBe(false);
      expect(isTrustTool('geocode')).toBe(false);
      expect(isTrustTool('schedule_reminder')).toBe(false);
      expect(isTrustTool('')).toBe(false);
    });

    it('does not match by substring (only prefix or exact)', () => {
      // A future tool called e.g. `analyse_peerlens_history` is NOT
      // automatically a trust-providing tool just because it mentions
      // peerlens. Prefix-only keeps the audit precise.
      expect(isTrustTool('analyse_peerlens_history')).toBe(false);
      expect(isTrustTool('not_peer_lens_lookup')).toBe(false);
    });
  });

  describe('trustToolUsed', () => {
    it('returns false for an empty or undefined list', () => {
      expect(trustToolUsed(undefined)).toBe(false);
      expect(trustToolUsed([])).toBe(false);
    });

    it('returns true if any tool in the list is a trust tool', () => {
      expect(trustToolUsed(['vault_search', 'search_trust_network'])).toBe(true);
      expect(trustToolUsed(['geocode', 'peerlens_aggregate', 'vault_search'])).toBe(true);
    });

    it('returns false when no entry is a trust tool', () => {
      expect(trustToolUsed(['vault_search', 'geocode', 'schedule_reminder'])).toBe(false);
    });
  });
});
