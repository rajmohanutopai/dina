/**
 * Render tests for the shared `FacetBarView` component
 * (TN-MOB-016 + TN-MOB-011 / Plan §8.3.1).
 *
 * The component renders a horizontal chip row from a `FacetBar`
 * (`primary` + `overflow`) with an "All" reset chip prepended and
 * an optional "More" chevron when overflow is present.
 *
 * Coverage:
 *   - Empty bar (`primary === [] && overflow === []`) renders null.
 *   - "All" chip is always present + reflects activeValue===null.
 *   - One chip per primary entry, label format `"<value> · <count>"`.
 *   - "More" chip appears only when `overflow.length > 0` AND
 *     `onShowMore` is provided.
 *   - Active state (selected) matches `activeValue` exactly.
 *   - Tap fires the right callback with the right value.
 *   - a11y: each chip has accessibilityRole="button" + selected state.
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import { FacetBarView } from '../../src/trust/components/facet_bar_view';

import type { FacetBar } from '../../src/trust/facets';

const SAMPLE_FACETS: FacetBar = {
  primary: [
    { value: 'Furniture', count: 12 },
    { value: 'Phones', count: 8 },
    { value: 'Books', count: 4 },
  ],
  overflow: [
    { value: 'Software', count: 2 },
    { value: 'Plants', count: 1 },
  ],
};

describe('FacetBarView — render', () => {
  it('renders null when both primary and overflow are empty', () => {
    const { queryByTestId } = render(
      <FacetBarView facets={{ primary: [], overflow: [] }} />,
    );
    expect(queryByTestId('facet-bar')).toBeNull();
  });

  it('always renders the "All" reset chip when there are facets', () => {
    const { getByTestId } = render(<FacetBarView facets={SAMPLE_FACETS} />);
    expect(getByTestId('facet-chip-all')).toBeTruthy();
  });

  it('renders one chip per primary entry with "<value> · <count>" label', () => {
    const { getByText } = render(<FacetBarView facets={SAMPLE_FACETS} />);
    expect(getByText('Furniture · 12')).toBeTruthy();
    expect(getByText('Phones · 8')).toBeTruthy();
    expect(getByText('Books · 4')).toBeTruthy();
  });

  it('renders "More" chip when overflow exists AND onShowMore provided', () => {
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={() => undefined} />,
    );
    expect(getByTestId('facet-chip-more')).toBeTruthy();
  });

  it('does NOT render "More" chip when onShowMore is omitted', () => {
    const { queryByTestId } = render(<FacetBarView facets={SAMPLE_FACETS} />);
    expect(queryByTestId('facet-chip-more')).toBeNull();
  });

  it('does NOT render "More" chip when overflow is empty', () => {
    const { queryByTestId } = render(
      <FacetBarView
        facets={{ primary: SAMPLE_FACETS.primary, overflow: [] }}
        onShowMore={() => undefined}
      />,
    );
    expect(queryByTestId('facet-chip-more')).toBeNull();
  });
});

describe('FacetBarView — active state', () => {
  it('"All" chip has selected=true when activeValue is null', () => {
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} activeValue={null} />,
    );
    const chip = getByTestId('facet-chip-all');
    expect(chip.props.accessibilityState).toMatchObject({ selected: true });
  });

  it('chip with matching value has selected=true', () => {
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} activeValue="Phones" />,
    );
    const phonesChip = getByTestId('facet-chip-Phones');
    expect(phonesChip.props.accessibilityState).toMatchObject({ selected: true });
    // "All" chip is no longer selected.
    const allChip = getByTestId('facet-chip-all');
    expect(allChip.props.accessibilityState).toMatchObject({ selected: false });
  });

  it('non-active chips have selected=false', () => {
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} activeValue="Furniture" />,
    );
    expect(getByTestId('facet-chip-Books').props.accessibilityState).toMatchObject({
      selected: false,
    });
  });
});

describe('FacetBarView — tap behaviour', () => {
  it('tap on "All" fires onTap with null', () => {
    const onTap = jest.fn();
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onTap={onTap} />,
    );
    fireEvent.press(getByTestId('facet-chip-all'));
    expect(onTap).toHaveBeenCalledWith(null);
  });

  it('tap on a primary chip fires onTap with that value', () => {
    const onTap = jest.fn();
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onTap={onTap} />,
    );
    fireEvent.press(getByTestId('facet-chip-Furniture'));
    expect(onTap).toHaveBeenCalledWith('Furniture');
  });

  it('tap on "More" fires onShowMore', () => {
    const onShowMore = jest.fn();
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={onShowMore} />,
    );
    fireEvent.press(getByTestId('facet-chip-more'));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });
});

describe('FacetBarView — accessibility (TN-TEST-061 surface)', () => {
  it('every chip has accessibilityRole="button"', () => {
    const { getByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={() => undefined} />,
    );
    expect(getByTestId('facet-chip-all').props.accessibilityRole).toBe('button');
    expect(getByTestId('facet-chip-Furniture').props.accessibilityRole).toBe('button');
    expect(getByTestId('facet-chip-more').props.accessibilityRole).toBe('button');
  });

  it('"More" chip carries an explicit count in accessibilityLabel', () => {
    // Sighted users see "More"; screen-reader users get "More — N more"
    // so they know how many additional facets exist behind the CTA.
    const { getByLabelText } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={() => undefined} />,
    );
    expect(getByLabelText(/More — 2 more/)).toBeTruthy();
  });
});

describe('FacetBarView — render order', () => {
  // The component's docstring says "An 'All' chip is always rendered as
  // the leftmost item" and "Plan §8.3.1: Long-tail facets collapse under
  // 'More' once 5+ are visible" (i.e. the More chip belongs at the
  // RIGHT edge after primary chips). The existing tests check chip
  // EXISTENCE but not their POSITIONS — a refactor that re-ordered
  // children (e.g., All chip rendered between primary[0] and primary[1])
  // would pass all current tests. These tests pin the order contract.
  //
  // We use `getAllByTestId(/^facet-chip-/)` to collect chip nodes in
  // their natural render order (RTL preserves DOM-traversal order).
  // The host-node uniqueness rule means each rendered Pressable
  // surfaces once (testIDs propagate to the outermost host node only
  // when queried via getAllByTestId).

  function orderedChipIds(getAllByTestId: (m: RegExp) => readonly { props: { testID?: string } }[]): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const node of getAllByTestId(/^facet-chip-/)) {
      const id = node.props.testID;
      if (typeof id !== 'string') continue;
      // Multiple host nodes can carry the same testID due to RN's
      // touchable wrapper composition; first occurrence wins
      // (corresponds to render order of the chip itself).
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
    return ordered;
  }

  it('"All" chip is the FIRST chip rendered (leftmost)', () => {
    const { getAllByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={() => undefined} />,
    );
    const ids = orderedChipIds(getAllByTestId);
    expect(ids[0]).toBe('facet-chip-all');
  });

  it('primary chips appear in input order (preserves data-layer sort)', () => {
    // The data layer (`deriveFacets`) sorts by count desc. The view
    // MUST NOT re-order. Pinning that the input order is preserved.
    const { getAllByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={() => undefined} />,
    );
    const ids = orderedChipIds(getAllByTestId);
    const primaryIds = ids.filter(
      (id) => id !== 'facet-chip-all' && id !== 'facet-chip-more',
    );
    expect(primaryIds).toEqual([
      'facet-chip-Furniture',
      'facet-chip-Phones',
      'facet-chip-Books',
    ]);
  });

  it('"More" chip is the LAST chip rendered (rightmost)', () => {
    const { getAllByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={() => undefined} />,
    );
    const ids = orderedChipIds(getAllByTestId);
    expect(ids[ids.length - 1]).toBe('facet-chip-more');
  });

  it('full order: All → primary[0..n] → More', () => {
    // Single comprehensive pin — the complete order contract in one
    // assertion. If a refactor re-arranged ANY chip, this test
    // identifies the divergence with a clear diff.
    const { getAllByTestId } = render(
      <FacetBarView facets={SAMPLE_FACETS} onShowMore={() => undefined} />,
    );
    const ids = orderedChipIds(getAllByTestId);
    expect(ids).toEqual([
      'facet-chip-all',
      'facet-chip-Furniture',
      'facet-chip-Phones',
      'facet-chip-Books',
      'facet-chip-more',
    ]);
  });

  it('without overflow, "All" is first and last primary is last (no More chip)', () => {
    // Order contract still holds when overflow is empty — All leads,
    // primary fills the rest, no More appended.
    const { getAllByTestId } = render(
      <FacetBarView
        facets={{ primary: SAMPLE_FACETS.primary, overflow: [] }}
        onShowMore={() => undefined}
      />,
    );
    const ids = orderedChipIds(getAllByTestId);
    expect(ids).toEqual([
      'facet-chip-all',
      'facet-chip-Furniture',
      'facet-chip-Phones',
      'facet-chip-Books',
    ]);
  });
});
