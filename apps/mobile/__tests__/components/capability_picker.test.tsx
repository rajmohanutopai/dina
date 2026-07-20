/**
 * CapabilityPicker — Category → Capability provider picker
 * (SERVICE_CAPABILITY_CATALOG_DESIGN.md §1 / §8 / §9.1 / §37).
 */

import { render, fireEvent } from '@testing-library/react-native';
import React from 'react';

import { CapabilityPicker } from '../../src/components/capability_picker';
import { BUNDLED_CATALOG } from '../../src/services/catalog_source';

import type { CapabilityDefinition } from '@dina/protocol';

function renderPicker(over: Partial<React.ComponentProps<typeof CapabilityPicker>> = {}) {
  const onSelectCategory = jest.fn();
  const onSelectCapability = jest.fn();
  const utils = render(
    <CapabilityPicker
      catalog={BUNDLED_CATALOG}
      selectedCategoryId={null}
      onSelectCategory={onSelectCategory}
      selectedCapabilityId={null}
      onSelectCapability={onSelectCapability}
      {...over}
    />,
  );
  return { ...utils, onSelectCategory, onSelectCapability };
}

describe('CapabilityPicker', () => {
  it('renders the category step and NO capabilities until a category is picked', () => {
    const { getByTestId, queryByTestId, getByText } = renderPicker();
    expect(getByTestId('capability-picker')).toBeTruthy();
    expect(getByText('What kind of service is this?')).toBeTruthy();
    expect(getByTestId('picker-category-transit')).toBeTruthy();
    expect(getByTestId('picker-category-developer_ops')).toBeTruthy();
    // No capability rows + no capability heading before a category is selected.
    expect(queryByTestId('picker-capability-eta_query')).toBeNull();
  });

  it('tapping a category fires onSelectCategory', () => {
    const { getByTestId, onSelectCategory } = renderPicker();
    fireEvent.press(getByTestId('picker-category-transit'));
    expect(onSelectCategory).toHaveBeenCalledWith('transit');
  });

  it('shows the capabilities of the selected category (+ the capability heading)', () => {
    const { getByTestId, getByText, queryByTestId } = renderPicker({
      selectedCategoryId: 'transit',
    });
    expect(getByText('What does this service do?')).toBeTruthy();
    expect(getByTestId('picker-capability-eta_query')).toBeTruthy();
    // price_check is commerce, not transit → absent.
    expect(queryByTestId('picker-capability-price_check')).toBeNull();
  });

  it('is cross-category aware — appointment_availability appears under healthcare AND appointments (§9.1)', () => {
    const inHealth = renderPicker({ selectedCategoryId: 'healthcare' });
    expect(inHealth.getByTestId('picker-capability-appointment_availability')).toBeTruthy();
    const inAppt = renderPicker({ selectedCategoryId: 'appointments' });
    expect(inAppt.getByTestId('picker-capability-appointment_availability')).toBeTruthy();
  });

  it('tapping a capability fires onSelectCapability with the capability AND the chosen category', () => {
    const { getByTestId, onSelectCapability } = renderPicker({ selectedCategoryId: 'healthcare' });
    fireEvent.press(getByTestId('picker-capability-appointment_availability'));
    expect(onSelectCapability).toHaveBeenCalledTimes(1);
    const [cap, categoryId] = onSelectCapability.mock.calls[0] as [CapabilityDefinition, string];
    expect(cap.id).toBe('appointment_availability');
    expect(categoryId).toBe('healthcare'); // the CHOSEN category travels onto the listing
  });

  it('labels official capabilities + shows a lifecycle badge for non-stable ones', () => {
    const { getAllByText } = renderPicker({ selectedCategoryId: 'appointments' });
    expect(getAllByText('Official Dina capability').length).toBeGreaterThan(0);
    // appointment_book + availability_coordination are `beta` → Beta badges.
    expect(getAllByText('Beta').length).toBeGreaterThan(0);
  });
});
