/**
 * ListingsView — multi-listing manager (per-row Active/Paused + edit/delete/new).
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import { ListingsView, listingSubtitle, type ListingRow } from '../../src/components/listings_view';

const SELF_ROW: ListingRow = {
  rkey: 'self',
  name: 'Bus 42 ETA',
  capabilityCount: 1,
  status: 'active',
  discoverability: 'public',
};
const MARKET_ROW: ListingRow = {
  rkey: 'corner-market',
  name: 'Corner Market',
  capabilityCount: 2,
  status: 'paused',
  discoverability: 'unlisted',
};
const ROWS: ListingRow[] = [SELF_ROW, MARKET_ROW];

function renderView(over: Partial<React.ComponentProps<typeof ListingsView>> = {}) {
  const onToggleStatus = jest.fn();
  const onEdit = jest.fn();
  const onDelete = jest.fn();
  const onNew = jest.fn();
  const utils = render(
    <ListingsView
      listings={ROWS}
      onToggleStatus={onToggleStatus}
      onEdit={onEdit}
      onDelete={onDelete}
      onNew={onNew}
      {...over}
    />,
  );
  return { ...utils, onToggleStatus, onEdit, onDelete, onNew };
}

describe('listingSubtitle', () => {
  it('renders capability count + visibility', () => {
    expect(listingSubtitle(SELF_ROW)).toBe('1 capability · Public');
    expect(listingSubtitle(MARKET_ROW)).toBe('2 capabilities · Unlisted');
  });
});

describe('ListingsView', () => {
  it('renders a row per listing + the new-listing button', () => {
    const { getByTestId } = renderView();
    expect(getByTestId('listing-edit-self')).toBeTruthy();
    expect(getByTestId('listing-edit-corner-market')).toBeTruthy();
    expect(getByTestId('listing-new')).toBeTruthy();
  });

  it('shows an empty state (still with the new button) when there are no listings', () => {
    const { getByTestId, getByText } = renderView({ listings: [] });
    expect(getByText(/No services yet/)).toBeTruthy();
    expect(getByTestId('listing-new')).toBeTruthy();
  });

  it('tapping a row opens the editor for that rkey', () => {
    const { getByTestId, onEdit } = renderView();
    fireEvent.press(getByTestId('listing-edit-corner-market'));
    expect(onEdit).toHaveBeenCalledWith('corner-market');
  });

  it('toggling an ACTIVE listing requests paused; a PAUSED one requests active', () => {
    const { getByTestId, onToggleStatus } = renderView();
    fireEvent.press(getByTestId('listing-toggle-self')); // active → paused
    expect(onToggleStatus).toHaveBeenCalledWith('self', 'paused');
    fireEvent.press(getByTestId('listing-toggle-corner-market')); // paused → active
    expect(onToggleStatus).toHaveBeenCalledWith('corner-market', 'active');
  });

  it('delete fires onDelete with the rkey', () => {
    const { getByTestId, onDelete } = renderView();
    fireEvent.press(getByTestId('listing-delete-corner-market'));
    expect(onDelete).toHaveBeenCalledWith('corner-market');
  });

  it('new fires onNew', () => {
    const { getByTestId, onNew } = renderView();
    fireEvent.press(getByTestId('listing-new'));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('renders a draft listing as "Draft" (not "Paused") and toggles it to active (P3#5)', () => {
    const draftRow: ListingRow = {
      rkey: 'wip',
      name: 'Work In Progress',
      capabilityCount: 0,
      status: 'draft',
      discoverability: 'public',
    };
    const { getByTestId, getByText, queryByText, onToggleStatus } = renderView({
      listings: [draftRow],
    });
    expect(getByText('Draft')).toBeTruthy();
    expect(queryByText('Paused')).toBeNull();
    fireEvent.press(getByTestId('listing-toggle-wip'));
    expect(onToggleStatus).toHaveBeenCalledWith('wip', 'active');
  });
});
