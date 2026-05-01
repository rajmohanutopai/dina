/**
 * Render tests for the ViewerFilterChipsView component
 * (TN-V2-RANK-005 / RANK-016).
 *
 * Pins:
 *   - Hides entirely when filters list is empty.
 *   - Renders one chip per filter.
 *   - Chip carries accessibilityRole=checkbox + checked state.
 *   - Tap fires onToggle with the filter id.
 *   - Active chips render with the active style state (pinned via the
 *     accessibilityState, not the visual style).
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { ViewerFilterChipsView } from '../../src/trust/components/viewer_filter_chips_view';
import {
  ALL_VIEWER_FILTERS,
  type ViewerFilter,
  type ViewerFilterId,
} from '../../src/trust/preferences/viewer_filters';

// Pull the language filter (the only "real" one today) for the
// most-thorough rendering tests.
const LANG = ALL_VIEWER_FILTERS.find((f) => f.id === 'languages')!;

// Build a synthetic always-applicable filter so tests can exercise
// multi-chip rendering without relying on more META-* scaffolding.
const SYNTHETIC: ViewerFilter = {
  id: 'region',
  label: 'In my region',
  isApplicable: () => true,
  predicate: () => true,
};

describe('ViewerFilterChipsView — render', () => {
  it('returns null (renders nothing) when filters list is empty', () => {
    const { queryByTestId } = render(
      <ViewerFilterChipsView filters={[]} active={new Set()} onToggle={() => {}} />,
    );
    expect(queryByTestId('viewer-filter-chips')).toBeNull();
  });

  it('renders the container + one chip per filter when filters are present', () => {
    const { getByTestId } = render(
      <ViewerFilterChipsView
        filters={[LANG, SYNTHETIC]}
        active={new Set()}
        onToggle={() => {}}
      />,
    );
    expect(getByTestId('viewer-filter-chips')).toBeTruthy();
    expect(getByTestId('viewer-filter-chip-languages')).toBeTruthy();
    expect(getByTestId('viewer-filter-chip-region')).toBeTruthy();
  });

  it('chip label is the filter.label', () => {
    const { getByText } = render(
      <ViewerFilterChipsView filters={[LANG]} active={new Set()} onToggle={() => {}} />,
    );
    expect(getByText('In my languages')).toBeTruthy();
  });
});

describe('ViewerFilterChipsView — accessibility', () => {
  it('chips have accessibilityRole=checkbox', () => {
    const { getByTestId } = render(
      <ViewerFilterChipsView filters={[LANG]} active={new Set()} onToggle={() => {}} />,
    );
    expect(getByTestId('viewer-filter-chip-languages').props.accessibilityRole).toBe(
      'checkbox',
    );
  });

  it('inactive chip has accessibilityState.checked=false', () => {
    const { getByTestId } = render(
      <ViewerFilterChipsView filters={[LANG]} active={new Set()} onToggle={() => {}} />,
    );
    const chip = getByTestId('viewer-filter-chip-languages');
    expect(chip.props.accessibilityState.checked).toBe(false);
  });

  it('active chip has accessibilityState.checked=true', () => {
    const { getByTestId } = render(
      <ViewerFilterChipsView
        filters={[LANG]}
        active={new Set<ViewerFilterId>(['languages'])}
        onToggle={() => {}}
      />,
    );
    const chip = getByTestId('viewer-filter-chip-languages');
    expect(chip.props.accessibilityState.checked).toBe(true);
  });

  it('a11y label uses the filter.label (no decoration)', () => {
    const { getByTestId } = render(
      <ViewerFilterChipsView filters={[LANG]} active={new Set()} onToggle={() => {}} />,
    );
    expect(getByTestId('viewer-filter-chip-languages').props.accessibilityLabel).toBe(
      'In my languages',
    );
  });
});

describe('ViewerFilterChipsView — toggle', () => {
  it('tap fires onToggle with the filter id', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <ViewerFilterChipsView
        filters={[LANG, SYNTHETIC]}
        active={new Set()}
        onToggle={onToggle}
      />,
    );
    fireEvent.press(getByTestId('viewer-filter-chip-languages'));
    expect(onToggle).toHaveBeenCalledWith('languages');

    fireEvent.press(getByTestId('viewer-filter-chip-region'));
    expect(onToggle).toHaveBeenCalledWith('region');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('tapping an active chip still fires onToggle (caller decides to-OFF)', () => {
    // Component is dumb — it doesn't know whether a tap means "turn
    // ON" or "turn OFF". The caller flips the chip state in `active`.
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <ViewerFilterChipsView
        filters={[LANG]}
        active={new Set<ViewerFilterId>(['languages'])}
        onToggle={onToggle}
      />,
    );
    fireEvent.press(getByTestId('viewer-filter-chip-languages'));
    expect(onToggle).toHaveBeenCalledWith('languages');
  });
});
