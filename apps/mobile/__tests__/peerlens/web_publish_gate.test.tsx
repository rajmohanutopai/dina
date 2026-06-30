/**
 * D6 fallback (web thin client): the PeerLens review-PUBLISH CTA is HIDDEN when
 * `PEERLENS_WRITE_ENABLED` is false (the web case), while READ/SEARCH stay live.
 * The native case (flag true → CTA present) is already covered by
 * `search.render.test.tsx` + the rest of the peerlens suite.
 */

// Force the web (publish-disabled) branch regardless of the test runner's
// Platform.OS. Must be hoisted above the screen import.
jest.mock('../../src/peerlens/web_publish_flag', () => ({ PEERLENS_WRITE_ENABLED: false }));

import { render } from '@testing-library/react-native';
import React from 'react';

import SearchScreen from '../../app/peerlens/search';
import WriteScreen from '../../app/peerlens/write';

import type { FacetBar } from '../../src/peerlens/facets';

const EMPTY_FACETS: FacetBar = { primary: [], overflow: [] };

describe('PeerLens write — D6 web fallback (PEERLENS_WRITE_ENABLED=false)', () => {
  it('hides the search write CTA on web, but the read/search empty state still renders', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <SearchScreen results={[]} facets={EMPTY_FACETS} q="aeron" />,
    );
    // Read path is unaffected — the empty-state + its "nothing found" copy show.
    expect(getByTestId('search-empty')).toBeTruthy();
    expect(getByText(/Nothing found for “aeron”/)).toBeTruthy();
    // ...but the publish CTA is gone (server-side publish worker is a follow-up).
    expect(queryByTestId('search-write-cta')).toBeNull();
  });

  it('CHOKE POINT: the compose screen itself renders the web-unavailable notice', () => {
    // This is the catch-all — every navigation into /peerlens/write (search,
    // subject, reviewer profile, edit, deep-link) hits this gate, not just the
    // visible CTAs. The compose form (its hooks/runners) never renders on web.
    const { getByTestId, queryByTestId } = render(<WriteScreen />);
    expect(getByTestId('peerlens-write-web-unavailable')).toBeTruthy();
    // The form's subject section is NOT rendered (early return before the form).
    expect(queryByTestId('write-subject-section')).toBeNull();
  });
});
