/**
 * Devices settings screen (TN-V2-CTX-005).
 *
 * Multi-select compatibility profile. Drives the V2 actionability
 * layer's `compat_tags` filtering on product subjects: if you only
 * own iOS devices, an Android-only app shouldn't outrank an iOS-
 * compatible one in your trust feed.
 *
 * Empty selection = no filtering (all results pass). The user's
 * choice is local-only (Loyalty Law) — never sent to AppView.
 */

import React, { useCallback } from 'react';

import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import {
  MultiSelectScreen,
  toggleArrayValue,
  type MultiSelectOption,
} from '../../src/trust/preferences/multi_select_screen';
import type { DeviceCompat } from '../../src/services/user_preferences';

// Order matches platform popularity / device-store ordering. Each
// description anchors what subjects we're filtering against — e.g.
// "iPhone" rather than "iOS" alone, since "iOS" doesn't tell the
// user which physical thing they're declaring compatibility with.
const OPTIONS: ReadonlyArray<MultiSelectOption<DeviceCompat>> = [
  { value: 'ios', label: 'iOS', description: 'iPhone' },
  { value: 'ipad', label: 'iPad', description: 'iPadOS tablet' },
  { value: 'android', label: 'Android', description: 'Phone or tablet' },
  { value: 'macos', label: 'macOS', description: 'Mac laptop or desktop' },
  { value: 'windows', label: 'Windows', description: 'Windows PC' },
  { value: 'linux', label: 'Linux', description: 'Linux desktop' },
  { value: 'web', label: 'Web', description: 'Runs in any browser' },
];

export default function DevicesScreen(): React.ReactElement {
  const { profile, mutate } = useViewerPreferences();

  // `mutate(updater)` is race-safe: rapid taps compose. Without it,
  // toggling iOS then Android quickly would lose the iOS update —
  // see the comment in user_preferences.ts on writeQueue.
  const onToggle = useCallback(
    (value: DeviceCompat) => {
      void mutate((p) => ({ ...p, devices: toggleArrayValue(p.devices, value) }));
    },
    [mutate],
  );

  return (
    <MultiSelectScreen<DeviceCompat>
      title="Devices"
      description="Pick the devices you use. We'll prioritise products that work on yours and demote ones that don't. Empty selection means we won't filter."
      options={OPTIONS}
      selected={profile.devices}
      onToggle={onToggle}
      testIdPrefix="devices"
    />
  );
}
