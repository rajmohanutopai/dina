/**
 * `updateContactBody` — the ONE wire body both transports send for
 * `PUT /v1/contacts/:did` (§5.D). One builder, because the in-process and HTTP
 * transports must not drift on a tri-state field: an omitted key means "leave
 * it alone", and the difference between omitted and `null` is what clears a
 * stored billing address.
 */

import { updateContactBody } from '../../src/client/core-client';

const GSTIN = '27AAPFU0939F1ZV';

describe('the contact-update wire body', () => {
  it('sends nothing for an empty update — every field is don’t-touch', () => {
    expect(updateContactBody({})).toEqual({});
  });

  it('maps camelCase to the snake_case wire, including the address', () => {
    expect(
      updateContactBody({
        preferredFor: ['Chairs'],
        legalName: 'ChairMaker Industries LLP',
        registrations: [{ scheme: 'gstin', value: GSTIN }],
        billingAddress: {
          line1: '4 Kalasipalya Road',
          line2: 'Unit 3',
          city: 'Bengaluru',
          region: 'Karnataka',
          postalCode: '560002',
          country: 'IN',
        },
      }),
    ).toEqual({
      preferred_for: ['Chairs'],
      legal_name: 'ChairMaker Industries LLP',
      registrations: [{ scheme: 'gstin', value: GSTIN }],
      billing_address: {
        line1: '4 Kalasipalya Road',
        line2: 'Unit 3',
        city: 'Bengaluru',
        region: 'Karnataka',
        postal_code: '560002',
        country: 'IN',
      },
    });
  });

  it('keeps the three clearing forms apart: [] clears a list, null clears the address, absent touches neither', () => {
    expect(updateContactBody({ registrations: [] })).toEqual({ registrations: [] });
    expect(updateContactBody({ billingAddress: null })).toEqual({ billing_address: null });
    expect(updateContactBody({ legalName: '' })).toEqual({ legal_name: '' });
    expect(updateContactBody({ preferredFor: ['x'] })).not.toHaveProperty('billing_address');
  });

  it('omits absent optional address parts rather than sending empty strings', () => {
    expect(
      updateContactBody({ billingAddress: { line1: '4 Kalasipalya Road', city: 'Bengaluru', country: 'IN' } })
        .billing_address,
    ).toEqual({ line1: '4 Kalasipalya Road', city: 'Bengaluru', country: 'IN' });
  });

  it('carries the channels through, keeping null (clear) apart from absent (leave alone)', () => {
    expect(updateContactBody({ phone: '+919845012345', email: null })).toEqual({
      phone: '+919845012345',
      email: null,
    });
    expect(updateContactBody({ phone: '' })).toEqual({ phone: '' });
    expect(updateContactBody({ legalName: 'x' })).not.toHaveProperty('phone');
  });

  it('copies the arrays it is given — a later mutation by the caller cannot change what was sent', () => {
    const preferredFor = ['chairs'];
    const body = updateContactBody({ preferredFor });
    preferredFor.push('tables');
    expect(body.preferred_for).toEqual(['chairs']);
  });
});
