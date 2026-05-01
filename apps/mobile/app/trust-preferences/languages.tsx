/**
 * Languages settings screen (TN-V2-CTX-004).
 *
 * Multi-select BCP-47 language tags. Drives V2 actionability filtering:
 * a user who reads only English shouldn't see a Portuguese-only review
 * promoted as "great trust score" without a clear language signal.
 *
 * The list is curated to ~80 widely-spoken languages with substantial
 * digital content (see `language_list.ts`). With ~80 entries, search
 * is essential — the screen reuses `MultiSelectScreen`'s `searchable`
 * prop.
 *
 * Defaults: on first read, `defaultPreferences()` returns
 * `[device-locale]`. Once the user touches this screen and toggles
 * anything, their explicit list takes over.
 */

import React, { useCallback, useMemo } from 'react';

import { useViewerPreferences } from '../../src/hooks/useViewerPreferences';
import {
  MultiSelectScreen,
  toggleArrayValue,
  type MultiSelectOption,
} from '../../src/trust/preferences/multi_select_screen';
import { buildLanguageList } from '../../src/trust/preferences/language_list';

export default function LanguagesScreen(): React.ReactElement {
  const { profile, mutate } = useViewerPreferences();

  // Build the localised + sorted list once per mount. The locale comes
  // from the device, NOT from `profile.languages` — display-name
  // localisation is a UI concern; a Spanish-locale device should see
  // Spanish-named entries even if the user hasn't set Spanish as one
  // of their preferences.
  const options = useMemo<ReadonlyArray<MultiSelectOption<string>>>(() => {
    const list = buildLanguageList();
    return list.map((entry) => ({
      value: entry.tag,
      label: entry.displayName,
      description: entry.tag,
    }));
  }, []);

  const onToggle = useCallback(
    (value: string) => {
      void mutate((p) => ({
        ...p,
        languages: toggleArrayValue(p.languages, value),
      }));
    },
    [mutate],
  );

  return (
    <MultiSelectScreen<string>
      title="Languages"
      description="Pick the languages you read. We'll boost reviews in those and demote ones you don't read. Empty selection means we won't filter."
      options={options}
      selected={profile.languages}
      onToggle={onToggle}
      testIdPrefix="languages"
      searchable
      searchPlaceholder="Search languages"
    />
  );
}
