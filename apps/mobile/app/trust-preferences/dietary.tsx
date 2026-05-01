/**
 * Dietary settings screen (TN-V2-CTX-006).
 *
 * Multi-select dietary preferences. Drives V2 filtering on
 * food / restaurant / recipe subjects — a vegan user shouldn't see
 * a steakhouse promoted as "great trust score" without a clear
 * "this isn't compatible" signal.
 *
 * Empty selection = no filtering. Loyalty Law: never sent to
 * AppView; the lens is applied locally after the un-personalised
 * fetch.
 */

import React, { useCallback } from 'react';

import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import {
  MultiSelectScreen,
  toggleArrayValue,
  type MultiSelectOption,
} from '../../src/trust/preferences/multi_select_screen';
import type { DietaryTag } from '../../src/services/user_preferences';

// Order: most-restrictive at top (vegan > vegetarian > flexitarian
// allergies). Allergy-only entries grouped together. Each description
// is short — these are well-known terms; long explanations would just
// add noise.
const OPTIONS: ReadonlyArray<MultiSelectOption<DietaryTag>> = [
  { value: 'vegan', label: 'Vegan', description: 'No animal products' },
  { value: 'vegetarian', label: 'Vegetarian', description: 'No meat or fish' },
  { value: 'halal', label: 'Halal' },
  { value: 'kosher', label: 'Kosher' },
  { value: 'gluten-free', label: 'Gluten-free' },
  { value: 'dairy-free', label: 'Dairy-free' },
  { value: 'nut-free', label: 'Nut-free' },
];

export default function DietaryScreen(): React.ReactElement {
  const { profile, mutate } = useViewerPreferences();

  const onToggle = useCallback(
    (value: DietaryTag) => {
      void mutate((p) => ({ ...p, dietary: toggleArrayValue(p.dietary, value) }));
    },
    [mutate],
  );

  return (
    <MultiSelectScreen<DietaryTag>
      title="Dietary"
      description="Pick what applies to you. We'll surface options that match and warn on ones that don't. Empty selection means we won't filter."
      options={OPTIONS}
      selected={profile.dietary}
      onToggle={onToggle}
      testIdPrefix="dietary"
    />
  );
}
