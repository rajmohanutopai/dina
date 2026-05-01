/**
 * Tests for the shared `MultiSelectScreen` component
 * (TN-V2-CTX-005..007 / preferences/multi_select_screen.tsx).
 *
 * Pins the per-row visual contract + onToggle semantics so the
 * three consumer screens (devices, dietary, accessibility) only
 * need light render tests — they don't have to re-prove the row
 * behaviour.
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import {
  MultiSelectScreen,
  toggleArrayValue,
  type MultiSelectOption,
} from '../../src/trust/preferences/multi_select_screen';

type Sample = 'a' | 'b' | 'c';

const OPTIONS: ReadonlyArray<MultiSelectOption<Sample>> = [
  { value: 'a', label: 'Apple', description: 'fruit' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry', description: 'red' },
];

describe('toggleArrayValue', () => {
  it('adds the value when absent', () => {
    expect(toggleArrayValue<Sample>(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes the value when present', () => {
    expect(toggleArrayValue<Sample>(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('returns a fresh array — does not mutate input', () => {
    const input: readonly Sample[] = ['a'];
    const out = toggleArrayValue<Sample>(input, 'b');
    expect(out).not.toBe(input);
    expect(input).toEqual(['a']);
  });

  it('toggle round-trip restores the original (modulo order)', () => {
    let arr: Sample[] = ['a'];
    arr = toggleArrayValue(arr, 'b');
    arr = toggleArrayValue(arr, 'b');
    expect(arr).toEqual(['a']);
  });
});

describe('MultiSelectScreen — render', () => {
  function noop() {}

  it('renders one row per option', () => {
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
      />,
    );
    expect(getByTestId('t-row-a')).toBeTruthy();
    expect(getByTestId('t-row-b')).toBeTruthy();
    expect(getByTestId('t-row-c')).toBeTruthy();
  });

  it('renders the label and the description when present', () => {
    const { getByText, queryByText } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
      />,
    );
    expect(getByText('Apple')).toBeTruthy();
    expect(getByText('fruit')).toBeTruthy();
    expect(getByText('Banana')).toBeTruthy();
    // No description on Banana → no "fruit" / "red" string under it.
    // (We can't easily assert "no extra text below" without coupling to
    // layout, but we can confirm both descriptions render only once.)
    expect(getByText('red')).toBeTruthy();
    // Tests would catch a regression that adds default descriptions
    // by checking for a known-absent string.
    expect(queryByText('undefined')).toBeNull();
  });

  it('renders the description text above the list when provided', () => {
    const { getByText } = render(
      <MultiSelectScreen
        title="Test"
        description="Pick anything you like."
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
      />,
    );
    expect(getByText('Pick anything you like.')).toBeTruthy();
  });

  it('shows a checkmark on selected rows only', () => {
    const { getByTestId, queryByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={['a', 'c']}
        onToggle={noop}
        testIdPrefix="t"
      />,
    );
    expect(getByTestId('t-check-a')).toBeTruthy();
    expect(queryByTestId('t-check-b')).toBeNull();
    expect(getByTestId('t-check-c')).toBeTruthy();
  });

  it('row a11y role is checkbox with the checked state', () => {
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={['a']}
        onToggle={noop}
        testIdPrefix="t"
      />,
    );
    const checked = getByTestId('t-row-a');
    expect(checked.props.accessibilityRole).toBe('checkbox');
    expect(checked.props.accessibilityState.checked).toBe(true);

    const unchecked = getByTestId('t-row-b');
    expect(unchecked.props.accessibilityRole).toBe('checkbox');
    expect(unchecked.props.accessibilityState.checked).toBe(false);
  });

  it('a11y label includes the description when present', () => {
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
      />,
    );
    expect(getByTestId('t-row-a').props.accessibilityLabel).toBe('Apple, fruit');
    expect(getByTestId('t-row-b').props.accessibilityLabel).toBe('Banana');
  });
});

describe('MultiSelectScreen — searchable mode', () => {
  function noop() {}

  it('does NOT render a search box by default', () => {
    const { queryByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
      />,
    );
    expect(queryByTestId('t-search')).toBeNull();
  });

  it('renders a search box when searchable=true', () => {
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
        searchable
      />,
    );
    expect(getByTestId('t-search')).toBeTruthy();
  });

  it('typing in the search filters the visible rows', async () => {
    const { getByTestId, queryByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
        searchable
      />,
    );
    fireEvent.changeText(getByTestId('t-search'), 'apple');
    expect(getByTestId('t-row-a')).toBeTruthy();
    expect(queryByTestId('t-row-b')).toBeNull();
    expect(queryByTestId('t-row-c')).toBeNull();
  });

  it('search matches on label, description, and value (case-insensitive)', () => {
    const { getByTestId, queryByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
        searchable
      />,
    );
    // Label match (Cherry contains 'cherry').
    fireEvent.changeText(getByTestId('t-search'), 'CHERRY');
    expect(getByTestId('t-row-c')).toBeTruthy();
    // Description match ('red' is Cherry's description).
    fireEvent.changeText(getByTestId('t-search'), 'red');
    expect(getByTestId('t-row-c')).toBeTruthy();
    expect(queryByTestId('t-row-a')).toBeNull();
    // Value match (raw 'b' matches Banana's value).
    fireEvent.changeText(getByTestId('t-search'), 'b');
    // 'b' matches both Banana (value=b) and "fruit" descriptions don't
    // contain 'b' for Apple — filter is correct only for Banana.
    expect(getByTestId('t-row-b')).toBeTruthy();
  });

  it('renders an empty placeholder when no matches', () => {
    const { getByTestId, queryByText } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
        searchable
      />,
    );
    fireEvent.changeText(getByTestId('t-search'), 'xyzzy');
    expect(getByTestId('t-empty')).toBeTruthy();
    expect(queryByText(/No matches for "xyzzy"/)).toBeTruthy();
  });

  it('uses the custom searchPlaceholder when provided', () => {
    const { getByPlaceholderText } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
        searchable
        searchPlaceholder="Find a fruit"
      />,
    );
    expect(getByPlaceholderText('Find a fruit')).toBeTruthy();
  });

  it('whitespace-only query renders the full list', () => {
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={noop}
        testIdPrefix="t"
        searchable
      />,
    );
    fireEvent.changeText(getByTestId('t-search'), '   ');
    // All rows still visible.
    expect(getByTestId('t-row-a')).toBeTruthy();
    expect(getByTestId('t-row-b')).toBeTruthy();
    expect(getByTestId('t-row-c')).toBeTruthy();
  });
});

describe('MultiSelectScreen — onToggle', () => {
  it('fires onToggle with the row value when tapped', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={onToggle}
        testIdPrefix="t"
      />,
    );
    fireEvent.press(getByTestId('t-row-b'));
    expect(onToggle).toHaveBeenCalledWith('b');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('fires onToggle on a selected row too — caller decides toggle direction', () => {
    // The component is dumb — it doesn't know whether the press
    // means "add" or "remove". The caller composes with toggleArrayValue.
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={['a']}
        onToggle={onToggle}
        testIdPrefix="t"
      />,
    );
    fireEvent.press(getByTestId('t-row-a'));
    expect(onToggle).toHaveBeenCalledWith('a');
  });

  it('does not call onToggle for un-pressed rows', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <MultiSelectScreen
        title="Test"
        options={OPTIONS}
        selected={[]}
        onToggle={onToggle}
        testIdPrefix="t"
      />,
    );
    fireEvent.press(getByTestId('t-row-a'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalledWith('b');
    expect(onToggle).not.toHaveBeenCalledWith('c');
  });
});
