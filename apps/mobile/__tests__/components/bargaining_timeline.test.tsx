/**
 * The Tender screen's bargaining card: the story folded into one line, and
 * opened into one step per round. Built only from signed revisions and the
 * counters this node sent — these pin how each answer reads.
 */

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import {
  BargainingTimeline,
  bargainingSteps,
  bargainingSummary,
} from '../../src/components/BargainingTimeline';

import type { TenderStorySupplierView } from '@dina/core';

const money = (minor: string) => ({ currency: 'USD', minor_units: minor });
const base: TenderStorySupplierView = {
  supplier_did: 'did:plc:oak',
  service_rkey: 'bakery',
  quote_id: 'q',
  revisions: [],
  counters: [],
  lines: [],
};

describe('bargainingSteps', () => {
  it('pairs a revised counter with the next signed revision', () => {
    expect(
      bargainingSteps({
        ...base,
        revisions: [
          { revision: '1', total: money('24500'), issued_at: '' },
          { revision: '2', total: money('19750'), issued_at: '' },
        ],
        counters: [
          { round: 1, target_total: money('15000'), state: 'revised', sent_at: 1, answered_at: 2 },
        ],
      }),
    ).toEqual([
      { kind: 'opened', price: money('24500') },
      {
        kind: 'round',
        round: 1,
        asked: money('15000'),
        answer: 'lowered',
        price: money('19750'),
        asks: 1,
      },
    ]);
  });

  it('a held answer keeps the price, a refusal will not bargain, an open counter waits', () => {
    const steps = bargainingSteps({
      ...base,
      revisions: [{ revision: '1', total: money('19000'), issued_at: '' }],
      counters: [
        { round: 1, target_total: money('15000'), state: 'held', sent_at: 1, answered_at: 2 },
        { round: 2, target_total: null, state: 'refused', sent_at: 3, answered_at: 4 },
        { round: 3, target_total: money('15000'), state: 'sent', sent_at: 5, answered_at: null },
      ],
    });
    expect(steps.map((s) => (s.kind === 'round' ? s.answer : s.kind))).toEqual([
      'opened',
      'kept',
      'refused',
      'waiting',
    ]);
  });

  it("asks answered 'owner is deciding' are one round, as the loop counts them", () => {
    // Seen live: ValueCrumb came down once, then its owner had to decide on
    // USD 150 and Dina asked five more times with a growing wait.
    const pending = (sentAt: number) => ({
      round: 2,
      target_total: money('15000'),
      state: 'pending' as const,
      sent_at: sentAt,
      answered_at: sentAt + 1,
    });
    const story = {
      ...base,
      revisions: [
        { revision: '1', total: money('17500'), issued_at: '' },
        { revision: '2', total: money('17000'), issued_at: '' },
      ],
      counters: [
        {
          round: 1,
          target_total: money('15000'),
          state: 'revised' as const,
          sent_at: 1,
          answered_at: 2,
        },
        ...[3, 5, 7, 9, 11].map(pending),
        {
          round: 3,
          target_total: money('15000'),
          state: 'unsent' as const,
          sent_at: 13,
          answered_at: null,
        },
      ],
    };
    const steps = bargainingSteps(story);
    expect(steps).toHaveLength(3);
    expect(steps[2]).toMatchObject({ kind: 'round', round: 2, answer: 'owner', asks: 5 });
    expect(bargainingSummary(story)).toBe(
      'Bargaining · 2 rounds · USD 175.00 → USD 170.00 · saved USD 5.00',
    );
    const view = render(<BargainingTimeline story={story} supplierLabel="ValueCrumb" testID="v" />);
    fireEvent.press(view.getByTestId('v-toggle'));
    expect(view.getByText('ValueCrumb is asking its owner · Dina asked 5 times')).toBeTruthy();
  });

  it('no quote yet is no steps', () => {
    expect(bargainingSteps(undefined)).toEqual([]);
    expect(bargainingSteps(base)).toEqual([]);
  });
});

describe('bargainingSummary', () => {
  it('names the rounds, the move and the saving', () => {
    expect(
      bargainingSummary({
        ...base,
        revisions: [
          { revision: '1', total: money('24500'), issued_at: '' },
          { revision: '2', total: money('19750'), issued_at: '' },
          { revision: '3', total: money('17500'), issued_at: '' },
        ],
        counters: [
          { round: 1, target_total: money('15000'), state: 'revised', sent_at: 1, answered_at: 2 },
          { round: 2, target_total: money('15000'), state: 'revised', sent_at: 3, answered_at: 4 },
        ],
      }),
    ).toBe('Bargaining · 2 rounds · USD 245.00 → USD 175.00 · saved USD 70.00');
  });

  it('an unbargained quote says where it opened', () => {
    expect(
      bargainingSummary({
        ...base,
        revisions: [{ revision: '1', total: money('24000'), issued_at: '' }],
      }),
    ).toBe('Opened at USD 240.00 · no bargaining yet');
  });

  it('no quote yet has nothing to say', () => {
    expect(bargainingSummary(undefined)).toBeNull();
    expect(bargainingSummary(base)).toBeNull();
  });
});

describe('BargainingTimeline', () => {
  it('renders nothing without a quote', () => {
    const view = render(<BargainingTimeline story={base} supplierLabel="Oak" testID="b" />);
    expect(view.queryByTestId('b-toggle')).toBeNull();
  });

  it('opens and closes on the toggle, naming the supplier in each answer', () => {
    const view = render(
      <BargainingTimeline
        story={{
          ...base,
          revisions: [{ revision: '1', total: money('24000'), issued_at: '' }],
          counters: [
            {
              round: 1,
              target_total: money('15000'),
              state: 'refused',
              sent_at: 1,
              answered_at: 2,
            },
          ],
        }}
        supplierLabel="Sweet Maple"
        testID="b"
      />,
    );
    expect(view.queryByTestId('b-steps')).toBeNull();
    fireEvent.press(view.getByTestId('b-toggle'));
    expect(view.getByText('Round 1 · Dina asked USD 150.00')).toBeTruthy();
    expect(view.getByText('Sweet Maple would not bargain')).toBeTruthy();
    expect(view.getByTestId('b-toggle').props.accessibilityState).toEqual({ expanded: true });
    fireEvent.press(view.getByTestId('b-toggle'));
    expect(view.queryByTestId('b-steps')).toBeNull();
  });
});
