/**
 * Jest mock for `expo-router` — the real package ships JSX-bearing TS
 * source that Jest's CommonJS pipeline can't consume without a Metro-
 * style transform, and the unit-test surface only touches the routing
 * hooks (not the navigator components). Tests that consume URL params
 * via `useLocalSearchParams` get an empty object by default; tests that
 * need specific param values can `jest.mock('expo-router', () => …)`
 * locally to override.
 */

/** Empty params — tests that pass route data via props don't need URL state. */
export function useLocalSearchParams<
  T extends Record<string, string | string[] | undefined> = Record<string, string | string[] | undefined>,
>(): T {
  return {} as T;
}

/** No-op router stub — extend per-test if a screen ever imports `useRouter`. */
export function useRouter(): {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  canGoBack: () => boolean;
} {
  return {
    push: () => undefined,
    replace: () => undefined,
    back: () => undefined,
    // No history in the mock, but returning true keeps callers that
    // branch on `canGoBack()` from crashing — the `back()` no-op
    // means they "successfully" return without navigating.
    canGoBack: () => true,
  };
}

/**
 * `useFocusEffect` runs on screen focus / blur in Expo Router. In the
 * Jest environment there's no navigator, so we run the effect once on
 * mount — sufficient for the unit tests that just need the callback
 * not to be a missing-import error.
 */
export function useFocusEffect(
  effect: () => void | (() => void),
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const React = require('react');
  React.useEffect(() => {
    const cleanup = effect();
    return typeof cleanup === 'function' ? cleanup : undefined;
    // The real expo-router runs `effect` every time focus changes; the
    // unit tests don't drive focus, so once-on-mount is the right
    // approximation (matches `useEffect(..., [])`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * `useNavigation` stub — returns a navigation object with no-op
 * `setOptions`. Some screens call `navigation.setOptions({...})` to
 * customize the header at render time.
 */
export function useNavigation(): {
  setOptions: (options: Record<string, unknown>) => void;
} {
  return { setOptions: () => undefined };
}

/** Tabs.Screen stub for layout tests — renders nothing. */
export const Tabs = {
  Screen: () => null,
};

/**
 * Stack.Screen stub for unit tests. Real Stack.Screen registers
 * navigator-level options (header title, etc.) but those have no
 * effect inside a Jest render — so we mirror the Tabs.Screen shape
 * and return null. Importantly, the import itself must succeed:
 * screens commonly do `<Stack.Screen options={{ title: '...' }} />`
 * for header configuration.
 */
export const Stack = {
  Screen: () => null,
};
