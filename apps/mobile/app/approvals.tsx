/**
 * Approvals route — redirect to the Activity tab.
 *
 * The standalone Approvals screen was merged INTO Activity
 * (`app/notifications.tsx`): approval cards are now actionable inline on
 * the "Needs action" filter. This route stays REGISTERED (a `Tabs.Screen`
 * with `href: null` in `app/_layout.tsx`) so `dina://approvals` /
 * `dina://approvals/<id>` deep links and notification taps still resolve —
 * they now land on `/notifications` (Needs action), where the inline cards
 * cover the action.
 *
 * The data hook + actionable card components moved to
 * `src/components/approval_inbox.tsx`.
 */

import { Redirect } from 'expo-router';
import React from 'react';

export default function ApprovalsRedirect(): React.JSX.Element {
  return <Redirect href="/notifications" />;
}
