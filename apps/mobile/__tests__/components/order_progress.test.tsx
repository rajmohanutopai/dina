/**
 * Where a placed order is and what happens next. Every step is a fact Core
 * reported for the order; an order the supplier refused has no track.
 */

import { render } from '@testing-library/react-native';
import React from 'react';

import {
  OrderProgress,
  orderNextStep,
  orderStepsReached,
} from '../../src/components/OrderProgress';

import type { PlacedOrderDto } from '@dina/core';

const none = { checkoutLink: null, payment: null, paymentRecorded: false, fulfilment: null };

function order(over: Partial<PlacedOrderDto> = {}): PlacedOrderDto {
  return {
    purchaseOrderId: 'po-1',
    supplierDid: 'did:plc:valuecrumb',
    serviceRkey: 'shop',
    supplierName: null,
    total: null,
    submittedAt: null,
    state: 'accepted',
    headline: 'Accepted by the supplier.',
    detail: null,
    actions: [],
    nextPollAtMs: null,
    pollCount: 0,
    progress: none,
    quoteId: 'q-1',
    lines: [],
    tenderId: null,
    ...over,
  };
}

const link = (expired: boolean) =>
  ({
    url: 'https://pay.example.test/c/1',
    expired,
    expiresAt: null,
  }) as unknown as NonNullable<PlacedOrderDto['progress']>['checkoutLink'];

describe('orderStepsReached and orderNextStep', () => {
  it.each([
    [
      'sent, not yet confirmed',
      order({ state: 'submitted_unconfirmed' }),
      1,
      'Waiting for ValueCrumb to confirm the order.',
    ],
    ['accepted, no link yet', order(), 2, 'Next: ValueCrumb sends a payment link.'],
    [
      'a live payment link',
      order({ progress: { ...none, checkoutLink: link(false) } }),
      2,
      'Next: pay with the payment link.',
    ],
    [
      'an expired payment link',
      order({ progress: { ...none, checkoutLink: link(true) } }),
      2,
      'The payment link expired. ValueCrumb can send a new one.',
    ],
    [
      'paid',
      order({ progress: { ...none, paymentRecorded: true } }),
      3,
      'Paid. Next: ValueCrumb starts making it.',
    ],
    [
      'being made',
      order({
        progress: {
          ...none,
          paymentRecorded: true,
          fulfilment: { state: 'production_started' } as never,
        },
      }),
      4,
      'ValueCrumb is making it.',
    ],
    [
      'on the way',
      order({
        progress: {
          ...none,
          paymentRecorded: true,
          fulfilment: { state: 'handed_to_carrier' } as never,
        },
      }),
      5,
      'On the way to you.',
    ],
  ])('%s', (_label, o, steps, next) => {
    expect(orderStepsReached(o)).toBe(steps);
    expect(orderNextStep(o, 'ValueCrumb')).toBe(next);
  });

  it('a refused order has no track and no next step: Core’s headline says what happened', () => {
    const refused = order({ state: 'rejected', headline: 'The supplier rejected the order.' });
    expect(orderStepsReached(refused)).toBeNull();
    expect(orderNextStep(refused, 'ValueCrumb')).toBeNull();
    const view = render(<OrderProgress order={refused} supplier="ValueCrumb" testID="p" />);
    expect(view.queryByTestId('p')).toBeNull();
  });

  it('draws the track: steps reached are done, the rest to do', () => {
    const view = render(
      <OrderProgress
        order={order({ progress: { ...none, paymentRecorded: true } })}
        supplier="V"
        testID="p"
      />,
    );
    expect(view.getByTestId('p-step-2-done')).toBeTruthy();
    expect(view.getByTestId('p-step-3-todo')).toBeTruthy();
  });
});
