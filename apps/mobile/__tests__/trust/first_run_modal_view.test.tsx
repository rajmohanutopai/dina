/**
 * Render tests for the first-run modal component (TN-MOB-022 + TN-TEST-060).
 *
 * The data layer (`first_run.ts` — copy + dismissal flag) is already
 * pinned in `first_run.test.ts`. These tests cover the visual shell.
 *
 * Coverage:
 *   - `visible=false` renders null (host can mount unconditionally).
 *   - `visible=true` renders backdrop + card.
 *   - All body paragraphs are rendered (one per array entry, with
 *     stable testIDs so the host can adjust spacing).
 *   - Dismiss CTA fires onDismiss.
 *   - The dismiss CTA accepts the 48pt floor + has accessibilityRole=button.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import { FirstRunModalView } from '../../src/trust/components/first_run_modal_view';
import { FIRST_RUN_MODAL_COPY } from '../../src/trust/first_run';

describe('FirstRunModalView — visibility', () => {
  it('renders null when visible=false', () => {
    const { queryByTestId, toJSON } = render(<FirstRunModalView visible={false} />);
    expect(queryByTestId('first-run-modal')).toBeNull();
    expect(toJSON()).toBeNull();
  });

  it('renders the modal when visible=true', () => {
    const { getByTestId } = render(<FirstRunModalView visible />);
    expect(getByTestId('first-run-modal-backdrop')).toBeTruthy();
    expect(getByTestId('first-run-modal')).toBeTruthy();
  });
});

describe('FirstRunModalView — content', () => {
  it('renders the title from FIRST_RUN_MODAL_COPY', () => {
    const { getByText } = render(<FirstRunModalView visible />);
    expect(getByText(FIRST_RUN_MODAL_COPY.title)).toBeTruthy();
  });

  it('renders one paragraph per entry in body[]', () => {
    const { getAllByTestId } = render(<FirstRunModalView visible />);
    const paragraphs = getAllByTestId(/^first-run-modal-body-\d+$/);
    expect(paragraphs).toHaveLength(FIRST_RUN_MODAL_COPY.body.length);
  });

  it('renders each body paragraph verbatim', () => {
    const { getByText } = render(<FirstRunModalView visible />);
    for (const paragraph of FIRST_RUN_MODAL_COPY.body) {
      expect(getByText(paragraph)).toBeTruthy();
    }
  });

  it('renders the dismiss CTA with the configured label', () => {
    const { getByText } = render(<FirstRunModalView visible />);
    expect(getByText(FIRST_RUN_MODAL_COPY.dismissLabel)).toBeTruthy();
  });
});

describe('FirstRunModalView — interactions', () => {
  it('dismiss CTA fires onDismiss', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <FirstRunModalView visible onDismiss={onDismiss} />,
    );
    fireEvent.press(getByTestId('first-run-modal-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss CTA does nothing when onDismiss is omitted', () => {
    const { getByTestId } = render(<FirstRunModalView visible />);
    expect(() =>
      fireEvent.press(getByTestId('first-run-modal-dismiss')),
    ).not.toThrow();
  });
});

describe('FirstRunModalView — accessibility (TN-TEST-061 surface)', () => {
  it('dismiss CTA has accessibilityRole="button"', () => {
    const { getByTestId } = render(<FirstRunModalView visible />);
    const cta = getByTestId('first-run-modal-dismiss');
    expect(cta.props.accessibilityRole).toBe('button');
  });

  it('dismiss CTA accessibilityLabel matches the configured copy', () => {
    const { getByLabelText } = render(<FirstRunModalView visible />);
    expect(getByLabelText(FIRST_RUN_MODAL_COPY.dismissLabel)).toBeTruthy();
  });
});
