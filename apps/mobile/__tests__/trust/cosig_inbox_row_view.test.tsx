/**
 * Render tests for the cosig inbox row component (TN-MOB-040 + TN-TEST-060).
 *
 * The state-classification data layer (`cosig_inbox.ts:buildCosigInboxRow`)
 * is already pinned in `cosig_inbox.test.ts`. These tests cover the
 * visual shell + interaction wiring.
 *
 * Coverage:
 *   - Per-state rendering: pending / accepted / declined / expired
 *   - Action buttons: visible only on pending; absent on closed states
 *   - Body preview: renders when present, omitted when null
 *   - Expiry badge: visible only on pending with positive ms remaining
 *   - Tap on row body fires onPress with deepLink
 *   - Tap on Endorse / Decline fires onAction with right verb
 *   - a11y: row + buttons have role + label
 *   - formatExpiryDelta bucket boundaries (pure helper)
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import {
  CosigInboxRowView,
  formatExpiryDelta,
} from '../../src/trust/components/cosig_inbox_row_view';
import type { CosigInboxRowDisplay } from '../../src/trust/cosig_inbox';

function makeDisplay(overrides: Partial<CosigInboxRowDisplay> = {}): CosigInboxRowDisplay {
  return {
    state: 'pending',
    title: 'Sancho asked you to co-sign their review',
    bodyPreview: 'I think you can confirm this is a great chair',
    actions: ['endorse', 'decline'],
    deepLink: 'app/trust/sub-1?attestation=at://x/y/z',
    msUntilExpiry: 3 * 60 * 60_000, // 3 hours
    ...overrides,
  };
}

describe('CosigInboxRowView — per-state rendering', () => {
  it('renders pending state with state label + expiry + actions', () => {
    const { getByTestId, getByText } = render(
      <CosigInboxRowView rowId="r1" display={makeDisplay()} />,
    );
    expect(getByTestId('cosig-inbox-row-r1')).toBeTruthy();
    expect(getByText('Awaiting your response')).toBeTruthy();
    expect(getByTestId('cosig-inbox-expiry-r1')).toBeTruthy();
    expect(getByTestId('cosig-inbox-endorse-r1')).toBeTruthy();
    expect(getByTestId('cosig-inbox-decline-r1')).toBeTruthy();
  });

  it('renders accepted state without actions or expiry', () => {
    const { getByText, queryByTestId } = render(
      <CosigInboxRowView
        rowId="r1"
        display={makeDisplay({ state: 'accepted', actions: [] })}
      />,
    );
    expect(getByText('Endorsed')).toBeTruthy();
    expect(queryByTestId('cosig-inbox-endorse-r1')).toBeNull();
    expect(queryByTestId('cosig-inbox-decline-r1')).toBeNull();
    expect(queryByTestId('cosig-inbox-expiry-r1')).toBeNull();
  });

  it('renders declined state without actions or expiry', () => {
    const { getByText, queryByTestId } = render(
      <CosigInboxRowView
        rowId="r1"
        display={makeDisplay({ state: 'declined', actions: [] })}
      />,
    );
    expect(getByText('Declined')).toBeTruthy();
    expect(queryByTestId('cosig-inbox-endorse-r1')).toBeNull();
  });

  it('renders expired state without actions or expiry badge', () => {
    const { getByText, queryByTestId } = render(
      <CosigInboxRowView
        rowId="r1"
        display={makeDisplay({
          state: 'expired',
          actions: [],
          msUntilExpiry: -3600_000, // already past
        })}
      />,
    );
    expect(getByText('Expired')).toBeTruthy();
    expect(queryByTestId('cosig-inbox-endorse-r1')).toBeNull();
    expect(queryByTestId('cosig-inbox-expiry-r1')).toBeNull();
  });

  it('renders body preview when present', () => {
    const { getByText } = render(
      <CosigInboxRowView
        rowId="r1"
        display={makeDisplay({ bodyPreview: 'A quick reason' })}
      />,
    );
    expect(getByText(/A quick reason/)).toBeTruthy();
  });

  it('omits body preview block when bodyPreview is null', () => {
    const { queryByText } = render(
      <CosigInboxRowView rowId="r1" display={makeDisplay({ bodyPreview: null })} />,
    );
    // No quoted body — the surrounding "" smart-quote pair is the
    // body block, hidden in this branch.
    expect(queryByText(/^“.*”$/)).toBeNull();
  });

  it('renders only Endorse when actions = ["endorse"]', () => {
    const { getByTestId, queryByTestId } = render(
      <CosigInboxRowView
        rowId="r1"
        display={makeDisplay({ actions: ['endorse'] })}
      />,
    );
    expect(getByTestId('cosig-inbox-endorse-r1')).toBeTruthy();
    expect(queryByTestId('cosig-inbox-decline-r1')).toBeNull();
  });

  it('renders only Decline when actions = ["decline"]', () => {
    const { queryByTestId, getByTestId } = render(
      <CosigInboxRowView
        rowId="r1"
        display={makeDisplay({ actions: ['decline'] })}
      />,
    );
    expect(queryByTestId('cosig-inbox-endorse-r1')).toBeNull();
    expect(getByTestId('cosig-inbox-decline-r1')).toBeTruthy();
  });
});

describe('CosigInboxRowView — interactions', () => {
  it('row tap fires onPress with rowId + deepLink', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <CosigInboxRowView
        rowId="r1"
        display={makeDisplay({ deepLink: 'app/trust/sub-1?attestation=at://x' })}
        onPress={onPress}
      />,
    );
    fireEvent.press(getByTestId('cosig-inbox-row-r1'));
    expect(onPress).toHaveBeenCalledWith('r1', 'app/trust/sub-1?attestation=at://x');
  });

  it('Endorse tap fires onAction with "endorse"', () => {
    const onAction = jest.fn();
    const { getByTestId } = render(
      <CosigInboxRowView rowId="r1" display={makeDisplay()} onAction={onAction} />,
    );
    fireEvent.press(getByTestId('cosig-inbox-endorse-r1'));
    expect(onAction).toHaveBeenCalledWith('r1', 'endorse');
  });

  it('Decline tap fires onAction with "decline"', () => {
    const onAction = jest.fn();
    const { getByTestId } = render(
      <CosigInboxRowView rowId="r1" display={makeDisplay()} onAction={onAction} />,
    );
    fireEvent.press(getByTestId('cosig-inbox-decline-r1'));
    expect(onAction).toHaveBeenCalledWith('r1', 'decline');
  });
});

describe('CosigInboxRowView — accessibility (TN-TEST-061 surface)', () => {
  it('row has accessibilityRole=button + composed label', () => {
    const { getByTestId } = render(
      <CosigInboxRowView rowId="r1" display={makeDisplay()} onPress={() => undefined} />,
    );
    const row = getByTestId('cosig-inbox-row-r1');
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toMatch(/Sancho asked.*Awaiting your response/);
  });

  it('Endorse button has accessibilityLabel="Endorse"', () => {
    const { getByLabelText } = render(
      <CosigInboxRowView rowId="r1" display={makeDisplay()} />,
    );
    expect(getByLabelText('Endorse')).toBeTruthy();
  });

  it('Decline button has accessibilityLabel="Decline"', () => {
    const { getByLabelText } = render(
      <CosigInboxRowView rowId="r1" display={makeDisplay()} />,
    );
    expect(getByLabelText('Decline')).toBeTruthy();
  });
});

describe('formatExpiryDelta', () => {
  it('< 1 minute → "<1m"', () => {
    expect(formatExpiryDelta(30_000)).toBe('<1m');
    expect(formatExpiryDelta(59_999)).toBe('<1m');
  });

  it('1..59 minutes → "<n>m"', () => {
    expect(formatExpiryDelta(60_000)).toBe('1m');
    expect(formatExpiryDelta(30 * 60_000)).toBe('30m');
    expect(formatExpiryDelta(59 * 60_000)).toBe('59m');
  });

  it('1..23 hours: omits remainder when 0; else "<n>h <m>m"', () => {
    expect(formatExpiryDelta(60 * 60_000)).toBe('1h');
    expect(formatExpiryDelta(60 * 60_000 + 30 * 60_000)).toBe('1h 30m');
    expect(formatExpiryDelta(23 * 60 * 60_000)).toBe('23h');
  });

  it('1+ days: omits remainder when 0; else "<n>d <h>h"', () => {
    expect(formatExpiryDelta(24 * 60 * 60_000)).toBe('1d');
    expect(formatExpiryDelta(24 * 60 * 60_000 + 3 * 60 * 60_000)).toBe('1d 3h');
    expect(formatExpiryDelta(2 * 24 * 60 * 60_000 + 5 * 60 * 60_000)).toBe('2d 5h');
  });

  it('zero or negative → "<1m" (defensive)', () => {
    expect(formatExpiryDelta(0)).toBe('<1m');
    expect(formatExpiryDelta(-3600_000)).toBe('<1m');
  });

  it('NaN / Infinity → "<1m" (defensive)', () => {
    expect(formatExpiryDelta(NaN)).toBe('<1m');
    expect(formatExpiryDelta(Infinity)).toBe('<1m');
  });
});
