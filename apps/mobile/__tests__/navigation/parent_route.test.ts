/**
 * Tests for `parentRouteFor` — the source of truth for where the
 * header back chevron lands.
 *
 * Pinning the user-facing contract:
 *   - Search/back returns to Trust (the bug that prompted this code)
 *   - Drill-downs under a section all return to that section's root
 *   - Section roots themselves bounce up to Chat
 *   - Unknown / malformed paths default to Chat (defensive)
 */

import { parentRouteFor } from '../../src/navigation/parent_route';

describe('parentRouteFor', () => {
  describe('Trust + Vault drill-downs (Stack-managed → fall through to /)', () => {
    // After the per-tab Stack refactor, trust + vault drill-downs are
    // handled by their own `<Stack>` (`app/trust/_layout.tsx`,
    // `app/vault/_layout.tsx`) which provides automatic back-chevron
    // navigation. parent_route.ts only handles drill-downs OUTSIDE
    // those Stacks, so trust/vault paths fall through to the Chat
    // default. This pin documents that contract.
    it('trust drill-downs are no longer mapped here (Stack-managed)', () => {
      expect(parentRouteFor('/trust/search')).toBe('/');
      expect(parentRouteFor('/trust/sub_83b9d57f0b25a6bbe78e0e87f61995fc')).toBe('/');
      expect(parentRouteFor('/trust/reviewer/did:plc:zaxxz2vts2umzfk2r5fpzes4')).toBe('/');
    });

    it('vault drill-down is no longer mapped here (Stack-managed)', () => {
      expect(parentRouteFor('/vault/personal')).toBe('/');
      expect(parentRouteFor('/vault')).toBe('/');
    });
  });

  describe('Settings family', () => {
    it('admin → /settings', () => {
      expect(parentRouteFor('/admin')).toBe('/settings');
    });

    it('paired-devices (Agents) → /settings', () => {
      expect(parentRouteFor('/paired-devices')).toBe('/settings');
    });

    it('service-settings → /settings', () => {
      expect(parentRouteFor('/service-settings')).toBe('/settings');
    });

    it('settings root → /', () => {
      expect(parentRouteFor('/settings')).toBe('/');
    });
  });

  describe('People family', () => {
    it('chat thread → /people', () => {
      // Chat threads are reached by tapping a peer in the People tab,
      // so back should return there — not the Chat *tab* (`/`), which
      // is the user's conversation with their own Dina.
      expect(parentRouteFor('/chat/did:plc:zaxxz2vts2umzfk2r5fpzes4')).toBe('/people');
    });

    it('add-contact → /people', () => {
      expect(parentRouteFor('/add-contact')).toBe('/people');
    });
  });

  // Vault family is now Stack-managed (`app/vault/_layout.tsx`).
  // Both the hub and per-vault detail fall through to `/` here so
  // the Stack-native back chevron is the one driving navigation.
  // See the "Stack-managed → fall through to /" describe above.

  describe('Hamburger-menu items', () => {
    it('reminders → /', () => {
      expect(parentRouteFor('/reminders')).toBe('/');
    });

    it('help → /', () => {
      expect(parentRouteFor('/help')).toBe('/');
    });
  });

  describe('Defensive handling', () => {
    it('empty string → /', () => {
      expect(parentRouteFor('')).toBe('/');
    });

    it('root path → /', () => {
      expect(parentRouteFor('/')).toBe('/');
    });

    it('unknown top-level path → /', () => {
      // A future route nobody updated this map for shouldn't strand
      // the user — Chat is the safe fallback.
      expect(parentRouteFor('/some/new/route')).toBe('/');
    });

    it('non-string input → /', () => {
      // Defensive against `usePathname()` somehow returning an
      // unexpected type during navigation transitions.
      expect(parentRouteFor(undefined as unknown as string)).toBe('/');
      expect(parentRouteFor(null as unknown as string)).toBe('/');
    });

    it('multi-slash garbage path → /', () => {
      expect(parentRouteFor('///')).toBe('/');
    });
  });
});
