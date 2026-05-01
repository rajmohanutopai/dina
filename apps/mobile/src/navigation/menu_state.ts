/**
 * Hamburger-menu open/close state — singleton with a subscribe API.
 *
 * Why this module exists: the menu sheet (`NavMenuSheet`) is mounted
 * once at the root layout. The hamburger button that opens it used
 * to live alongside the sheet in the same file via a local
 * `useState`. After we introduced per-tab `<Stack>` navigators
 * (`app/trust/_layout.tsx`, `app/vault/_layout.tsx`), the Stack
 * headers also need to render the hamburger on the tab's index
 * screen — which means the open/close state has to be reachable
 * from inside the Stack tree, not just the root.
 *
 * A module-level singleton plus `useSyncExternalStore` is the
 * lightest-weight way to share that state without lifting it into a
 * Context (which would force every consumer to wrap in a Provider
 * and would couple the Stack to the layout's render tree).
 *
 * Mirrors the `runtime_warnings.ts` pattern.
 */

let isOpen = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — subscriber bug must not break emit */
    }
  }
}

export function openMenu(): void {
  if (isOpen) return;
  isOpen = true;
  notify();
}

export function closeMenu(): void {
  if (!isOpen) return;
  isOpen = false;
  notify();
}

export function getMenuOpen(): boolean {
  return isOpen;
}

export function subscribeMenuOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset for tests. */
export function resetMenuStateForTest(): void {
  isOpen = false;
  listeners.clear();
}
