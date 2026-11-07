/**
 * Keep a plan screen true while it stays open: on focus, on return from the
 * background, and once a minute, so a screen left open overnight doesn't offer
 * yesterday's routine turn to tick.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { AppState } from 'react-native';

const REFRESH_MS = 60_000;

export function useRefreshWhileOpen(refresh: () => void): void {
  useFocusEffect(
    useCallback(() => {
      refresh();
      const every = setInterval(refresh, REFRESH_MS);
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') refresh();
      });
      return () => {
        clearInterval(every);
        sub.remove();
      };
    }, [refresh]),
  );
}
