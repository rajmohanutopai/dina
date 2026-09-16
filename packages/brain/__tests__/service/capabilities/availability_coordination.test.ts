/**
 * availability_coordination capability schemas (Contact Services §6.1/§6.2) —
 * the symmetric mutual meeting-coordination capability. Pins the params/result
 * validators: all params optional (a bare "when are you free?" is valid), and
 * the result is the accept/counter/needs_more_info shape where an honest
 * needs_more_info must validate without slots.
 */

import {
  validateAvailabilityCoordinationParams,
  validateAvailabilityCoordinationResult,
} from '../../../src/service/capabilities/availability_coordination';

describe('availability_coordination — params', () => {
  it('accepts a full proposal (intent + candidate_slots + constraints)', () => {
    expect(
      validateAvailabilityCoordinationParams({
        intent: 'find a time next week',
        candidate_slots: [{ start: 'Tue 3pm' }, { start: 'Wed 10am', end: 'Wed 11am', note: 'after standup' }],
        constraints: 'mornings preferred',
      }),
    ).toBeNull();
  });

  it('accepts a bare request (all params optional — "when are you free?")', () => {
    expect(validateAvailabilityCoordinationParams({})).toBeNull();
    expect(validateAvailabilityCoordinationParams({ intent: 'coffee sometime' })).toBeNull();
  });

  it('rejects a candidate_slot missing the required start', () => {
    const err = validateAvailabilityCoordinationParams({
      candidate_slots: [{ note: 'whenever' }],
    });
    expect(err).not.toBeNull();
  });
});

describe('availability_coordination — result', () => {
  it('accepts accepted + accepted_slots', () => {
    expect(
      validateAvailabilityCoordinationResult({
        status: 'accepted',
        accepted_slots: [{ start: 'Tue 3pm' }],
      }),
    ).toBeNull();
  });

  it('accepts counter + counter_slots', () => {
    expect(
      validateAvailabilityCoordinationResult({
        status: 'counter',
        counter_slots: [{ start: 'Thu 4pm' }],
        message: 'Tue does not work, how about Thu?',
      }),
    ).toBeNull();
  });

  it('accepts needs_more_info WITHOUT slots (honest answer must validate)', () => {
    expect(validateAvailabilityCoordinationResult({ status: 'needs_more_info' })).toBeNull();
  });

  it('rejects an unknown status', () => {
    expect(validateAvailabilityCoordinationResult({ status: 'booked' })).not.toBeNull();
  });

  describe('household disclosures (GROUP_COORDINATION §6, rule 6)', () => {
    it('are optional and additive — a reply without them stays valid', () => {
      expect(validateAvailabilityCoordinationResult({ status: 'accepted', accepted_slots: [{ start: 'Sat 26' }] })).toBeNull();
    });

    it('accept every kind, about the household', () => {
      for (const kind of ['dietary', 'accessibility', 'transport', 'note']) {
        expect(
          validateAvailabilityCoordinationResult({
            status: 'accepted',
            disclosures: [{ kind, text: 'someone in the household is gluten-free', about: 'household' }],
          }),
        ).toBeNull();
      }
    });

    it('`about` admits one value — the wire cannot carry a named person', () => {
      for (const about of ['Lily', 'child', 'me', '', undefined]) {
        expect(
          validateAvailabilityCoordinationResult({
            status: 'accepted',
            disclosures: [{ kind: 'dietary', text: 'gluten-free', about }],
          }),
        ).not.toBeNull();
      }
    });

    it('refuses a kind outside the four, and a disclosure with no text', () => {
      expect(
        validateAvailabilityCoordinationResult({
          status: 'accepted',
          disclosures: [{ kind: 'medical', text: 'x', about: 'household' }],
        }),
      ).not.toBeNull();
      expect(
        validateAvailabilityCoordinationResult({
          status: 'accepted',
          disclosures: [{ kind: 'dietary', about: 'household' }],
        }),
      ).not.toBeNull();
    });
  });

  it('rejects a missing status (the only required field)', () => {
    expect(validateAvailabilityCoordinationResult({ accepted_slots: [{ start: 'x' }] })).not.toBeNull();
  });

  it('rejects an accepted_slot missing the required start (result-side slot validation)', () => {
    expect(
      validateAvailabilityCoordinationResult({
        status: 'accepted',
        accepted_slots: [{ note: 'whenever' }],
      }),
    ).not.toBeNull();
  });

  it('rejects a counter_slot missing the required start', () => {
    expect(
      validateAvailabilityCoordinationResult({
        status: 'counter',
        counter_slots: [{ note: 'maybe' }],
      }),
    ).not.toBeNull();
  });
});
