/**
 * Approvals route — now a redirect into Activity.
 *
 * The standalone Approvals screen was merged INTO the Activity tab
 * (`app/notifications.tsx`): approval cards are actionable inline on the
 * "Needs action" filter. The `/approvals` route stays REGISTERED (a
 * `Tabs.Screen` with `href: null` in `app/_layout.tsx`) so
 * `dina://approvals` / `dina://approvals/<id>` deep links and notification
 * taps still resolve — it now renders a `<Redirect href="/notifications" />`.
 *
 * The old standalone-screen behaviours this file used to pin (pending-card
 * render, approve / deny / approve-once actions, the R-M6-I2 live-refresh on
 * `appended` approval events, resolved-card render) moved to
 * `__tests__/components/approval_inbox.test.tsx`, which drives the same hook +
 * cards as they render inline inside Activity.
 */

import { render } from '@testing-library/react-native';
import React from 'react';

import ApprovalsRedirect from '../../app/approvals';

const redirects: string[] = [];

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }): null => {
    redirects.push(href);
    return null;
  },
}));

beforeEach(() => {
  redirects.length = 0;
});

describe('Approvals route — redirects to Activity', () => {
  it('redirects /approvals → /notifications', () => {
    render(<ApprovalsRedirect />);
    expect(redirects).toEqual(['/notifications']);
  });
});
