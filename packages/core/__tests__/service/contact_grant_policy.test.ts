/**
 * decideContactServiceGrant() — the pure grant-policy decision for un-granted
 * requests to a relationship service (docs/CONTACT_SERVICES_ARCHITECTURE.md
 * §5.1/§5.2). Pins the tier matrix + the "default-offerable is the master gate"
 * design decision.
 */

import { decideContactServiceGrant } from '../../src/service/contact_grant_policy';

import type { Closeness } from '../../src/contacts/closeness';

const ALL_TIERS: Closeness[] = ['close', 'medium', 'distant', 'unknown'];

describe('decideContactServiceGrant — default-offerable is the master gate', () => {
  it('not default-offerable → soft_reject for EVERY tier (manual-grant-only)', () => {
    for (const closeness of ALL_TIERS) {
      expect(decideContactServiceGrant({ closeness, defaultOfferable: false })).toBe('soft_reject');
    }
  });
});

describe('decideContactServiceGrant — tier matrix when default-offerable', () => {
  it('close → auto_grant', () => {
    expect(decideContactServiceGrant({ closeness: 'close', defaultOfferable: true })).toBe(
      'auto_grant',
    );
  });
  it('medium → ask_to_enable (one-time prompt)', () => {
    expect(decideContactServiceGrant({ closeness: 'medium', defaultOfferable: true })).toBe(
      'ask_to_enable',
    );
  });
  it('distant → soft_reject (no prompt — cannot manufacture an interruption)', () => {
    expect(decideContactServiceGrant({ closeness: 'distant', defaultOfferable: true })).toBe(
      'soft_reject',
    );
  });
  it('unknown → soft_reject', () => {
    expect(decideContactServiceGrant({ closeness: 'unknown', defaultOfferable: true })).toBe(
      'soft_reject',
    );
  });
});

describe('decideContactServiceGrant — the §5.1 "both conditions" invariant for auto_grant', () => {
  it('auto_grant requires BOTH close AND default-offerable', () => {
    // close alone is not enough
    expect(decideContactServiceGrant({ closeness: 'close', defaultOfferable: false })).toBe(
      'soft_reject',
    );
    // default-offerable alone is not enough (medium does not auto-grant)
    expect(decideContactServiceGrant({ closeness: 'medium', defaultOfferable: true })).not.toBe(
      'auto_grant',
    );
    // both → auto_grant
    expect(decideContactServiceGrant({ closeness: 'close', defaultOfferable: true })).toBe(
      'auto_grant',
    );
  });
});
