/**
 * Tests for the appointment capability family (Tier 1 flagship —
 * docs/SERVICE_PROVIDER_TIERS.md): schemas + runtime validators for
 * `appointment_availability` and `appointment_book`.
 */

import { getCatalogCapability } from '@dina/protocol';

import {
  AppointmentAvailabilityParamsSchema,
  AppointmentAvailabilityResultSchema,
  AppointmentBookParamsSchema,
  AppointmentBookResultSchema,
  validateAppointmentAvailabilityParams,
  validateAppointmentAvailabilityResult,
  validateAppointmentBookParams,
  validateAppointmentBookResult,
} from '../../../src/service/capabilities/appointment';
import { getCapability, getTTL } from '../../../src/service/capabilities/registry';

describe('appointment_availability', () => {
  it('params: empty object is valid (all fields optional)', () => {
    expect(validateAppointmentAvailabilityParams({})).toBeNull();
  });

  it('params: human-cadence strings are valid', () => {
    expect(
      validateAppointmentAvailabilityParams({
        service: 'haircut',
        date: 'today',
        time_after: '4pm',
      }),
    ).toBeNull();
  });

  it('params: non-object rejected', () => {
    expect(validateAppointmentAvailabilityParams(null)).not.toBeNull();
    expect(validateAppointmentAvailabilityParams('today')).not.toBeNull();
  });

  it('params: wrong field type rejected', () => {
    expect(validateAppointmentAvailabilityParams({ date: 42 })).toContain('date');
  });

  it('result: status is required', () => {
    expect(validateAppointmentAvailabilityResult({})).toContain('status');
  });

  it('result: ok with slots is valid', () => {
    expect(
      validateAppointmentAvailabilityResult({
        status: 'ok',
        slots: [{ time: '4:30 PM' }, { time: '5:15 PM', note: 'with Maya' }],
        date: 'today',
        as_of: 'this morning',
      }),
    ).toBeNull();
  });

  it('result: no_slots / unknown without slots are valid (honest answers)', () => {
    expect(validateAppointmentAvailabilityResult({ status: 'no_slots' })).toBeNull();
    expect(
      validateAppointmentAvailabilityResult({
        status: 'unknown',
        message: 'Notes are from last week — please call to confirm.',
      }),
    ).toBeNull();
  });

  it('result: out-of-enum status rejected', () => {
    expect(validateAppointmentAvailabilityResult({ status: 'maybe' })).toContain('status');
  });

  it('result: slot entries require time', () => {
    expect(
      validateAppointmentAvailabilityResult({ status: 'ok', slots: [{ note: 'x' }] }),
    ).toContain('time');
  });
});

describe('appointment_book', () => {
  it('params: time is the required discriminator', () => {
    expect(validateAppointmentBookParams({ time: '4:30 PM' })).toBeNull();
    expect(validateAppointmentBookParams({ service: 'haircut' })).toContain('time');
  });

  it('params: carries NO requester-identity slot (from_did is the identity)', () => {
    const props = Object.keys(
      (AppointmentBookParamsSchema as { properties: Record<string, unknown> }).properties,
    );
    for (const p of props) {
      expect(p).not.toMatch(/^(customer|patient|account|member)_/);
      expect(p).not.toBe('name');
    }
  });

  it('result: confirmed booking is valid', () => {
    expect(
      validateAppointmentBookResult({
        status: 'confirmed',
        time: '4:30 PM',
        date: 'today',
        service: 'haircut',
        message: 'Booked for 4:30.',
      }),
    ).toBeNull();
  });

  it('result: declined / unavailable / unknown are valid terminal statuses', () => {
    expect(validateAppointmentBookResult({ status: 'declined' })).toBeNull();
    expect(validateAppointmentBookResult({ status: 'unavailable' })).toBeNull();
    expect(validateAppointmentBookResult({ status: 'unknown' })).toBeNull();
  });

  it('result: status required + enum-bound', () => {
    expect(validateAppointmentBookResult({})).toContain('status');
    expect(validateAppointmentBookResult({ status: 'booked' })).toContain('status');
  });
});

describe('registry + catalog integration', () => {
  it('both capabilities are registered with schemas and sane TTLs', () => {
    const avail = getCapability('appointment_availability');
    expect(avail?.paramsSchema).toEqual(AppointmentAvailabilityParamsSchema);
    expect(avail?.resultSchema).toEqual(AppointmentAvailabilityResultSchema);
    expect(getTTL('appointment_availability')).toBe(120);

    const book = getCapability('appointment_book');
    expect(book?.paramsSchema).toEqual(AppointmentBookParamsSchema);
    expect(book?.resultSchema).toEqual(AppointmentBookResultSchema);
    // Review-gated: needs the full wire maximum for the human round trip.
    expect(getTTL('appointment_book')).toBe(300);
  });

  it('aliases resolve to the canonical defs', () => {
    expect(getCapability('book_appointment')?.name).toBe('appointment_book');
    expect(getCapability('appointment_slots')?.name).toBe('appointment_availability');
  });

  it('catalog defaults match the authoritative registry schemas byte-for-byte', () => {
    const availCat = getCatalogCapability('appointment_availability');
    expect(availCat?.params_schema).toEqual(AppointmentAvailabilityParamsSchema);
    expect(availCat?.result_schema).toEqual(AppointmentAvailabilityResultSchema);
    const bookCat = getCatalogCapability('appointment_book');
    expect(bookCat?.params_schema).toEqual(AppointmentBookParamsSchema);
    expect(bookCat?.result_schema).toEqual(AppointmentBookResultSchema);
  });
});
