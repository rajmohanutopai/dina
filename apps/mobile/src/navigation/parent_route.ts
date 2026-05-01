/**
 * Logical-parent route resolution for the header back chevron.
 *
 * Most tabs that have drill-downs (Trust, Vault) now wrap their
 * folder in a `<Stack>` (`app/trust/_layout.tsx`,
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
 *   - Settings family (`/admin`, `/paired-devices`,
 *     `/service-settings` → `/settings`; `/settings` → `/`)
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
  'paired-devices': '/settings',
  'service-settings': '/settings',
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
 *   `/trust/search`         → `/trust`
 *   `/trust/<subjectId>`    → `/trust`
 *   `/trust/reviewer/<did>` → `/trust`
 *   `/admin`                → `/settings`
 *   `/chat/<did>`           → `/people`
 *   `/vault/<name>`         → `/vault`
 *   anything unknown        → `/`
 *
 * Special case: when the user is already AT a section's root path
 * (e.g. `/trust` itself), the back chevron should land on the Chat
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

  // At a section root (e.g. `/trust`, `/settings`) — bounce up one
  // more level. Drill-downs under the section (`/trust/search`,
  // `/settings/...`) stay anchored to the section.
  if (segs.length === 1 && `/${first}` === sectionParent) {
    return '/';
  }

  return sectionParent;
}
