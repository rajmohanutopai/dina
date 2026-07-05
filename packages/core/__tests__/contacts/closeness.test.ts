/**
 * closeness() — relationship-tier classification for Contact Services
 * default-grant policy (docs/CONTACT_SERVICES_ARCHITECTURE.md §5.1/§5.2).
 *
 * Pins the two design invariants: relationship-primary, and trust is
 * demote-only (blocked → unknown; trust never elevates).
 */

import { closeness } from '../../src/contacts/closeness';

import type { Relationship, TrustLevel } from '../../src/contacts/directory';

const c = (relationship: Relationship, trustLevel: TrustLevel = 'unknown') => ({
  relationship,
  trustLevel,
});

describe('closeness — relationship-primary mapping (§5.1)', () => {
  it('close = spouse/child/parent/sibling', () => {
    expect(closeness(c('spouse'))).toBe('close');
    expect(closeness(c('child'))).toBe('close');
    expect(closeness(c('parent'))).toBe('close');
    expect(closeness(c('sibling'))).toBe('close');
  });

  it('medium = friend', () => {
    expect(closeness(c('friend'))).toBe('medium');
  });

  it('distant = colleague/acquaintance', () => {
    expect(closeness(c('colleague'))).toBe('distant');
    expect(closeness(c('acquaintance'))).toBe('distant');
  });

  it('unknown relationship = unknown', () => {
    expect(closeness(c('unknown'))).toBe('unknown');
  });
});

describe('closeness — trust is demote-only (design decision)', () => {
  it('blocked is the safety floor: forced to unknown whatever the relationship', () => {
    expect(closeness(c('spouse', 'blocked'))).toBe('unknown');
    expect(closeness(c('friend', 'blocked'))).toBe('unknown');
    expect(closeness(c('colleague', 'blocked'))).toBe('unknown');
    expect(closeness(c('unknown', 'blocked'))).toBe('unknown');
  });

  it('trust NEVER elevates: verified/trusted do not make a non-close relationship close', () => {
    // A verified/trusted acquaintance stays distant — identity verification
    // alone never opens the auto-grant door.
    expect(closeness(c('acquaintance', 'verified'))).toBe('distant');
    expect(closeness(c('acquaintance', 'trusted'))).toBe('distant');
    // A trusted contact with no tagged relationship is still unknown.
    expect(closeness(c('unknown', 'trusted'))).toBe('unknown');
    expect(closeness(c('unknown', 'verified'))).toBe('unknown');
  });

  it('a close relationship stays close across non-blocked trust levels', () => {
    expect(closeness(c('spouse', 'trusted'))).toBe('close');
    expect(closeness(c('spouse', 'verified'))).toBe('close');
    expect(closeness(c('spouse', 'unknown'))).toBe('close');
  });
});
