/**
 * T1D.3 — D2D egress 4-gate enforcement.
 *
 * Category A: fixture-based. Verifies the 4 gates execute in order and
 * deny correctly: contact → scenario → sharing → audit.
 *
 * Source: core/test/d2d_v1_protocol_test.go
 */

import {
  checkEgressGates,
  checkContactGate,
  checkScenarioGate,
  checkSharingGate,
  addContact,
  setScenarioDeny,
  setSharingRestrictions,
  clearGatesState,
  blockDestination,
  unblockDestination,
  trustDestination,
  untrustDestination,
  isDestinationBlocked,
  isDestinationTrusted,
} from '../../src/d2d/gates';

describe('D2D Egress 4-Gate Enforcement', () => {
  const knownContact = 'did:plc:knownFriend';
  const unknownDID = 'did:plc:strangePerson';

  beforeEach(() => {
    clearGatesState();
    addContact(knownContact);
    setScenarioDeny(knownContact, ['presence.signal']);
    setSharingRestrictions(knownContact, ['health', 'financial']);
  });

  describe('checkEgressGates (full pipeline)', () => {
    it('allows message to known contact with valid policies', () => {
      const result = checkEgressGates(knownContact, 'social.update', []);
      expect(result.allowed).toBe(true);
    });

    it('denies message to unknown contact at gate 1', () => {
      const result = checkEgressGates(unknownDID, 'social.update', []);
      expect(result.allowed).toBe(false);
      expect(result.deniedAt).toBe('contact');
    });

    it('denies blocked message type at gate 2', () => {
      const result = checkEgressGates(knownContact, 'presence.signal', []);
      expect(result.allowed).toBe(false);
      expect(result.deniedAt).toBe('scenario');
    });

    it('denies restricted data category at gate 3', () => {
      const result = checkEgressGates(knownContact, 'social.update', ['health']);
      expect(result.allowed).toBe(false);
      expect(result.deniedAt).toBe('sharing');
    });

    it('safety.alert bypasses scenario gate', () => {
      const result = checkEgressGates(knownContact, 'safety.alert', []);
      expect(result.allowed).toBe(true);
    });

    it('gate order: contact checked before scenario', () => {
      const result = checkEgressGates(unknownDID, 'presence.signal', []);
      expect(result.deniedAt).toBe('contact');
    });
  });

  describe('Gate 1: Contact Check', () => {
    it('passes for known contact', () => {
      expect(checkContactGate(knownContact)).toBe(true);
    });

    it('fails for unknown DID', () => {
      expect(checkContactGate(unknownDID)).toBe(false);
    });

    it('fails for empty DID', () => {
      expect(checkContactGate('')).toBe(false);
    });
  });

  describe('Gate 2: Scenario Policy', () => {
    it('allows message type when not in deny list', () => {
      expect(checkScenarioGate(knownContact, 'social.update')).toBe(true);
    });

    it('denies message type when in deny list', () => {
      expect(checkScenarioGate(knownContact, 'presence.signal')).toBe(false);
    });

    it('safety.alert always passes regardless of policy', () => {
      setScenarioDeny(knownContact, ['safety.alert']);
      expect(checkScenarioGate(knownContact, 'safety.alert')).toBe(true);
    });

    it('contact without deny list → all allowed', () => {
      const otherContact = 'did:plc:noPolicies';
      addContact(otherContact);
      expect(checkScenarioGate(otherContact, 'social.update')).toBe(true);
    });
  });

  describe('Gate 3: Sharing Policy', () => {
    it('allows when no vault data categories', () => {
      expect(checkSharingGate(knownContact, [])).toBe(true);
    });

    it('allows permitted categories', () => {
      expect(checkSharingGate(knownContact, ['general'])).toBe(true);
    });

    it('denies restricted categories', () => {
      expect(checkSharingGate(knownContact, ['health'])).toBe(false);
    });

    it('denies if ANY category is restricted (partial deny)', () => {
      expect(checkSharingGate(knownContact, ['general', 'health'])).toBe(false);
    });
  });

  describe('blocked/trusted destination lists', () => {
    const blockedDID = 'did:plc:spammer';
    const trustedDID = 'did:plc:bestfriend';

    it('blocked destination → denied regardless of contact status', () => {
      addContact(blockedDID); // even known contacts can be blocked
      blockDestination(blockedDID);
      const result = checkEgressGates(blockedDID, 'social.update', []);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('trusted destination → allowed without contact/policy checks', () => {
      // NOT a known contact, but trusted
      trustDestination(trustedDID);
      const result = checkEgressGates(trustedDID, 'social.update', ['health']);
      expect(result.allowed).toBe(true);
    });

    it('blocking removes from trusted list', () => {
      trustDestination('did:plc:flip');
      blockDestination('did:plc:flip');
      expect(isDestinationBlocked('did:plc:flip')).toBe(true);
      expect(isDestinationTrusted('did:plc:flip')).toBe(false);
    });

    it('trusting removes from blocked list', () => {
      blockDestination('did:plc:flip2');
      trustDestination('did:plc:flip2');
      expect(isDestinationTrusted('did:plc:flip2')).toBe(true);
      expect(isDestinationBlocked('did:plc:flip2')).toBe(false);
    });

    it('unblock removes from blocked list', () => {
      blockDestination('did:plc:temp');
      unblockDestination('did:plc:temp');
      expect(isDestinationBlocked('did:plc:temp')).toBe(false);
    });

    it('untrust removes from trusted list', () => {
      trustDestination('did:plc:temp2');
      untrustDestination('did:plc:temp2');
      expect(isDestinationTrusted('did:plc:temp2')).toBe(false);
    });

    it('clearGatesState clears destination lists', () => {
      blockDestination('did:plc:a');
      trustDestination('did:plc:b');
      clearGatesState();
      expect(isDestinationBlocked('did:plc:a')).toBe(false);
      expect(isDestinationTrusted('did:plc:b')).toBe(false);
    });
  });
});
