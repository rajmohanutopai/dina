/**
 * Accessibility settings screen (TN-V2-CTX-007).
 *
 * Multi-select accessibility requirements. Drives V2 filtering /
 * boosting on subjects that carry accessibility metadata — a
 * wheelchair user shouldn't see a no-elevator-no-ramp restaurant
 * promoted as "great trust score" without an explicit "this isn't
 * compatible" signal; a hearing-impaired user wants captioned
 * content boosted on video subjects.
 *
 * Empty selection = no filtering. Loyalty Law: never sent to
 * AppView. The lens applies locally after the un-personalised fetch.
 */

import React, { useCallback } from 'react';

import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import {
  MultiSelectScreen,
  toggleArrayValue,
  type MultiSelectOption,
} from '../../src/trust/preferences/multi_select_screen';
import type { AccessibilityTag } from '../../src/services/user_preferences';

// Order: physical access first (wheelchair), then sensory (captions
// for hearing, screen-reader for vision, color-blind-safe for vision).
// Each description anchors what the tag means in plain language —
// "wheelchair" alone could mean either "I use one" or "places suitable
// for one"; the description disambiguates.
const OPTIONS: ReadonlyArray<MultiSelectOption<AccessibilityTag>> = [
  {
    value: 'wheelchair',
    label: 'Wheelchair',
    description: 'Step-free access, accessible bathrooms',
  },
  {
    value: 'captions',
    label: 'Captions',
    description: 'Subtitles for video and audio content',
  },
  {
    value: 'screen-reader',
    label: 'Screen reader',
    description: 'Compatible with VoiceOver, TalkBack, and similar',
  },
  {
    value: 'color-blind-safe',
    label: 'Color-blind-safe',
    description: 'Avoids red/green-only or unlabeled colour cues',
  },
];

export default function AccessibilityScreen(): React.ReactElement {
  const { profile, mutate } = useViewerPreferences();

  const onToggle = useCallback(
    (value: AccessibilityTag) => {
      void mutate((p) => ({
        ...p,
        accessibility: toggleArrayValue(p.accessibility, value),
      }));
    },
    [mutate],
  );

  return (
    <MultiSelectScreen<AccessibilityTag>
      title="Accessibility"
      description="Pick the requirements that apply to you. We'll boost subjects that meet them and warn on ones that don't. Empty selection means we won't filter."
      options={OPTIONS}
      selected={profile.accessibility}
      onToggle={onToggle}
      testIdPrefix="accessibility"
    />
  );
}
