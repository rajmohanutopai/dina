/**
 * Render tests for the outbox screen (TN-MOB-017).
 *
 * Three states pinned by the screen:
 *   1. **Empty** — no rows in any state. "Nothing in your outbox" copy.
 *   2. **In-flight only** — rows exist but none have failed. Shows the
 *      "<n> reviews queued — will publish when back online" banner +
 *      the "All caught up" empty-failures panel.
 *   3. **Failures present** — `selectInboxFailureRows` returns ≥ 1.
 *      One FailureRow per row, each with status label + reason text +
 *      retry/dismiss CTAs.
 *
 * Plus interaction tests: tapping retry / dismiss fires the right
 * callback with the row's `clientId`.
 *
 * The data-layer state machine + selectors are covered exhaustively
 * in `outbox.test.ts` (52 tests); this file pins only the screen-side
 * wiring.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import OutboxScreen from '../../app/trust/outbox';
import type { OutboxRow } from '../../src/trust/outbox';

interface DraftBody {
  readonly text: string;
}

const NOW_ISO = '2026-04-30T10:00:00Z';

function makeRow(overrides: Partial<OutboxRow<DraftBody>> = {}): OutboxRow<DraftBody> {
  return {
    clientId: 'cid-default',
    draftBody: { text: 'A draft' },
    status: 'queued-offline',
    enqueuedAt: NOW_ISO,
    ...overrides,
  };
}

describe('OutboxScreen — render states', () => {
  it('renders empty state when rows is empty', () => {
    const { getByTestId, queryByTestId } = render(<OutboxScreen rows={[]} />);
    expect(getByTestId('outbox-empty')).toBeTruthy();
    expect(queryByTestId('outbox-inflight-banner')).toBeNull();
    expect(queryByTestId('outbox-no-failures')).toBeNull();
  });

  it('renders in-flight banner + "all caught up" when only non-terminal rows exist', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({ clientId: 'a', status: 'queued-offline' }),
      makeRow({ clientId: 'b', status: 'submitted-pending', submittedAt: NOW_ISO, atUri: 'at://x/y/1' }),
    ];
    const { getByTestId, queryByTestId, getByText } = render(
      <OutboxScreen rows={rows} />,
    );
    expect(getByTestId('outbox-inflight-banner')).toBeTruthy();
    expect(getByText(/2 reviews queued/)).toBeTruthy();
    expect(getByTestId('outbox-no-failures')).toBeTruthy();
    expect(queryByTestId('outbox-empty')).toBeNull();
  });

  it('uses singular "review" when exactly one in-flight row', () => {
    const rows: OutboxRow<DraftBody>[] = [makeRow({ clientId: 'only-one' })];
    const { getByText } = render(<OutboxScreen rows={rows} />);
    expect(getByText(/^1 review queued/)).toBeTruthy();
  });

  it('renders one failure row per terminal-failure row, sorted FIFO', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'older-failure',
        status: 'rejected',
        enqueuedAt: '2026-04-30T09:00:00Z',
        atUri: 'at://x/y/older',
        submittedAt: '2026-04-30T09:00:01Z',
        rejection: { reason: 'rate_limit', rejectedAt: '2026-04-30T09:00:05Z' },
      }),
      makeRow({
        clientId: 'newer-failure',
        status: 'stuck-pending',
        enqueuedAt: '2026-04-30T10:00:00Z',
        atUri: 'at://x/y/newer',
        submittedAt: '2026-04-30T10:00:01Z',
      }),
      // Indexed (terminal-success) row should NOT appear.
      makeRow({
        clientId: 'indexed',
        status: 'indexed',
        atUri: 'at://x/y/idx',
        submittedAt: '2026-04-30T10:00:00Z',
        indexedAt: '2026-04-30T10:00:02Z',
      }),
    ];
    const { getAllByTestId, queryByTestId } = render(<OutboxScreen rows={rows} />);
    const rowEls = getAllByTestId(/^outbox-row-/);
    expect(rowEls).toHaveLength(2);
    // FIFO order — older-failure rendered first.
    expect(rowEls[0]?.props.testID).toBe('outbox-row-older-failure');
    expect(rowEls[1]?.props.testID).toBe('outbox-row-newer-failure');
    // Indexed row absent.
    expect(queryByTestId('outbox-row-indexed')).toBeNull();
  });

  it('shows the rejection reason text for rejected rows', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'r1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
      }),
    ];
    const { getByText } = render(<OutboxScreen rows={rows} />);
    expect(getByText(/Rate limit exceeded/)).toBeTruthy();
  });

  it('falls back to a generic "Rejected: <reason>" when reason is unknown', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'r1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        rejection: {
          // Cast through unknown — the type is a closed union, but the
          // wire data MAY drift; the screen tolerates and surfaces.
          reason: 'unrecognised' as unknown as 'rate_limit',
          rejectedAt: NOW_ISO,
        },
      }),
    ];
    const { getByText } = render(<OutboxScreen rows={rows} />);
    expect(getByText(/Rejected: unrecognised/)).toBeTruthy();
  });

  it('renders draft preview when renderDraftPreview is provided', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'r1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        draftBody: { text: 'My review of the chair' },
        rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
      }),
    ];
    const { getByText } = render(
      <OutboxScreen rows={rows} renderDraftPreview={(d) => d.text} />,
    );
    expect(getByText('My review of the chair')).toBeTruthy();
  });
});

describe('OutboxScreen — interactions', () => {
  it('tapping retry fires onRetry with the row clientId', () => {
    const onRetry = jest.fn();
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'failed-1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
      }),
    ];
    const { getByTestId } = render(<OutboxScreen rows={rows} onRetry={onRetry} />);
    fireEvent.press(getByTestId('outbox-retry-failed-1'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith('failed-1');
  });

  it('tapping dismiss fires onDismiss with the row clientId', () => {
    const onDismiss = jest.fn();
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'failed-1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
      }),
    ];
    const { getByTestId } = render(
      <OutboxScreen rows={rows} onDismiss={onDismiss} />,
    );
    fireEvent.press(getByTestId('outbox-dismiss-failed-1'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('failed-1');
  });

  it('omits retry button when onRetry is not provided', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'failed-1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
      }),
    ];
    const { queryByTestId } = render(<OutboxScreen rows={rows} />);
    expect(queryByTestId('outbox-retry-failed-1')).toBeNull();
  });
});

describe('OutboxScreen — accessibility (TN-TEST-061 surface)', () => {
  it('failure row has descriptive accessibilityLabel including status + reason', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'r1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
      }),
    ];
    const { getByLabelText } = render(<OutboxScreen rows={rows} />);
    // Combined label: "Rejected. Rate limit exceeded — try again later"
    expect(getByLabelText(/Rejected\. Rate limit exceeded/)).toBeTruthy();
  });

  it('retry button has accessibilityLabel="Try again"', () => {
    const rows: OutboxRow<DraftBody>[] = [
      makeRow({
        clientId: 'r1',
        status: 'rejected',
        atUri: 'at://x/y/r1',
        submittedAt: NOW_ISO,
        rejection: { reason: 'rate_limit', rejectedAt: NOW_ISO },
      }),
    ];
    const { getByLabelText } = render(
      <OutboxScreen rows={rows} onRetry={() => undefined} />,
    );
    expect(getByLabelText('Try again')).toBeTruthy();
  });
});
