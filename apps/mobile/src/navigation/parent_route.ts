/**
 * Logical-parent route resolution for the header back chevron.
 *
 * Most tabs that have drill-downs (Trust, Vault) now wrap their
 * folder in a `<Stack>` (`app/peerlens/_layout.tsx`,
 * `app/vault/_layout.tsx`), and the Stack's auto back-chevron walks
 * the actual navigation history — `search → subject → reviewer →
 * back` correctly pops to subject rather than jumping to /trust.
 *
 * What remains here: drill-downs that are NOT inside a Stack
 * folder. Those are reached from a top-level Tab via `router.push`,
 * which under bare `<Tabs>` records a global tab transition rather
 * than a stack push — so `router.back()` would pop to the
 * previously-focused tab, not the previously-pushed screen. For
 * those routes, this map nominates an explicit logical parent and
 * `HeaderBackButton` uses `router.replace(parent)` to land
 * predictably.
 *
 * Sections covered here:
 *   - Settings family (`/admin`, `/policy`, `/paired-devices`,
 *     `/service-settings`, `/ai-providers`, `/infrastructure`,
 *     `/recovery-phrase`, `/confirm-recovery-phrase`,
 *     `/peerlens-preferences/*` → `/settings`; `/settings` → `/`)
 *   - Chat thread + add-contact (reached from People tab)
 *   - Hamburger items not in a Stack folder (`/help`, `/reminders`)
 */

/**
 * Map each known drill-down's first path segment to its parent
 * route. Routes not listed default to `/` (Chat tab).
 */
const SECTION_PARENTS: Record<string, string> = {
  // /chat/[did] is reached from the People tab (peer row), so back
  // returns there rather than to the Chat tab. Matches the way the
  // user got into the thread.
  chat: '/people',
  // /add-contact is the People tab's "+ Add" destination.
  'add-contact': '/people',
  // Settings family — every subscreen returns to /settings, and
  // settings itself returns to Chat.
  admin: '/settings',
  policy: '/admin',
  'paired-devices': '/settings',
  // /subscriptions (standing poll-mode watches) is reached from Settings →
  // Subscriptions; back returns to Settings (PSVC-4).
  subscriptions: '/settings',
  // /runs (live interactive provider sessions) is reached from Settings →
  // Interactive runs; back returns to Settings (ISVC-9).
  runs: '/settings',
  'ai-providers': '/settings',
  // /infrastructure (advanced endpoint overrides) is reached from
  // Settings → More; back returns to Settings, not the Chat tab.
  infrastructure: '/settings',
  // /my-listings (provider home: node role + listings) is reached from Network
  // → Services and Settings → Service Sharing; default its back to Network.
  'my-listings': '/peerlens',
  // /service-settings is the per-listing editor, reached from /my-listings.
  'service-settings': '/my-listings',
  'recovery-phrase': '/settings',
  'confirm-recovery-phrase': '/settings',
  // /peerlens-preferences index returns to Settings; its sub-screens
  // (region, budget, devices, languages, dietary, accessibility)
  // return to the index page — handled as a special case in
  // `parentRouteFor` below.
  'peerlens-preferences': '/settings',
  // /approvals is a focused Activity sub-screen (no longer a bottom tab —
  // spec 5.3/8.6). It's reached by tapping an approval notification or a
  // `dina://approvals/<id>` deep link, so its back chevron returns to
  // Activity rather than the default Chat.
  approvals: '/notifications',
  // Hamburger-menu items return to the Chat tab as the safe default.
  // We don't track which tab the user was on when they opened the
  // menu — making that reliable would need an explicit "menu source"
  // record on every push.
  settings: '/',
  reminders: '/',
  help: '/',
};

/**
 * Compute the logical parent route for the current pathname.
 *
 *   `/peerlens/search`         → `/peerlens`
 *   `/peerlens/<subjectId>`    → `/peerlens`
 *   `/peerlens/reviewer/<did>` → `/peerlens`
 *   `/admin`                → `/settings`
 *   `/chat/<did>`           → `/people`
 *   `/vault/<name>`         → `/vault`
 *   anything unknown        → `/`
 *
 * Special case: when the user is already AT a section's root path
 * (e.g. `/peerlens` itself), the back chevron should land on the Chat
 * tab — there's nowhere else for it to go. Drill-downs under the
 * section keep returning to that section.
 */
export function parentRouteFor(pathname: string): string {
  if (typeof pathname !== 'string' || pathname === '' || pathname === '/') {
    return '/';
  }
  const segs = pathname.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return '/';

  const first = segs[0];
  const sectionParent = SECTION_PARENTS[first];

  if (sectionParent === undefined) return '/';

  // At a section root (e.g. `/peerlens`, `/settings`) — bounce up one
  // more level. Drill-downs under the section (`/peerlens/search`,
  // `/settings/...`) stay anchored to the section.
  if (segs.length === 1 && `/${first}` === sectionParent) {
    return '/';
  }

  // Special case: `/peerlens-preferences/<leaf>` (region, budget, …)
  // returns to the prefs index, not all the way back to Settings.
  // The index itself (`/peerlens-preferences`) returns to Settings via
  // the SECTION_PARENTS map above.
  if (first === 'peerlens-preferences' && segs.length === 2) {
    return '/peerlens-preferences';
  }

  return sectionParent;
}
