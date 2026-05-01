/**
 * Tests for `menu_state` — the hamburger-menu open/close singleton
 * shared between the root layout's NavMenuSheet and per-tab Stack
 * headers (`app/trust/_layout.tsx`, `app/vault/_layout.tsx`).
 */

import {
  openMenu,
  closeMenu,
  getMenuOpen,
  subscribeMenuOpen,
  resetMenuStateForTest,
} from '../../src/navigation/menu_state';

beforeEach(() => {
  resetMenuStateForTest();
});

describe('menu_state singleton', () => {
  it('starts closed', () => {
    expect(getMenuOpen()).toBe(false);
  });

  it('openMenu flips to true', () => {
    openMenu();
    expect(getMenuOpen()).toBe(true);
  });

  it('closeMenu flips back to false', () => {
    openMenu();
    closeMenu();
    expect(getMenuOpen()).toBe(false);
  });

  it('openMenu is idempotent — calling twice does not double-fire listeners', () => {
    // Pinning the no-op contract: a listener watching `getMenuOpen`
    // via `useSyncExternalStore` would otherwise re-render every
    // open call even when the snapshot hasn't changed, which on
    // React 18+ with strict mode produces noisy duplicate renders.
    const calls: number[] = [];
    const unsub = subscribeMenuOpen(() => calls.push(1));
    openMenu();
    openMenu();
    expect(calls.length).toBe(1);
    unsub();
  });

  it('closeMenu is idempotent — calling twice does not double-fire listeners', () => {
    openMenu();
    const calls: number[] = [];
    const unsub = subscribeMenuOpen(() => calls.push(1));
    closeMenu();
    closeMenu();
    expect(calls.length).toBe(1);
    unsub();
  });

  it('subscribe is fired on transition only', () => {
    const calls: boolean[] = [];
    const unsub = subscribeMenuOpen(() => calls.push(getMenuOpen()));
    openMenu();
    closeMenu();
    openMenu();
    expect(calls).toEqual([true, false, true]);
    unsub();
  });

  it('unsubscribe stops further notifications', () => {
    const calls: number[] = [];
    const unsub = subscribeMenuOpen(() => calls.push(1));
    unsub();
    openMenu();
    closeMenu();
    expect(calls.length).toBe(0);
  });

  it('a throwing listener does not break emit for other listeners', () => {
    // Defence in depth: the menu state is wired to multiple
    // hooks, and one buggy consumer must not stop the others
    // from receiving updates.
    const calls: number[] = [];
    subscribeMenuOpen(() => {
      throw new Error('subscriber blew up');
    });
    subscribeMenuOpen(() => calls.push(1));
    expect(() => openMenu()).not.toThrow();
    expect(calls).toEqual([1]);
  });
});
