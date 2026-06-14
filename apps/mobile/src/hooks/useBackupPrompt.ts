/**
 * useBackupPrompt — pops the backup-reminder page at a quiet moment once the
 * user has accumulated enough that a backup is worth doing (see
 * `services/backup_prompt`). Mounted once at the root layout, gated on the
 * unlocked state.
 *
 * Quiet-point policy: only fire when the user is on the chat home (`/`) — never
 * mid-drilldown (Settings, a vault, a chat thread) or on top of the reminder
 * itself. Evaluated on mount-after-unlock and on each foreground transition,
 * so it behaves as the user asked: a periodic page, not a passive banner.
 *
 * `shownRef` makes it at-most-once per app session; cross-session cadence is
 * the snooze window. There is intentionally no React state here — the side
 * effect (a navigation) IS the value.
 */

import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { shouldPromptBackup } from '../services/backup_prompt';

export function useBackupPrompt(unlocked: boolean): void {
  const router = useRouter();
  const pathname = usePathname();
  // Live mirror so the (once-installed) AppState listener reads the current
  // route without re-subscribing on every navigation.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const shownRef = useRef(false);

  useEffect(() => {
    if (!unlocked) return undefined;
    let cancelled = false;

    const maybePrompt = async (): Promise<void> => {
      if (cancelled || shownRef.current) return;
      // Quiet point only — fire on the chat home, never mid-drilldown or on top
      // of the prompt itself. (The chat tab's route is '/'.)
      if (pathRef.current !== '/') return;
      if (!(await shouldPromptBackup())) return;
      if (cancelled || shownRef.current || pathRef.current !== '/') return;
      shownRef.current = true;
      try {
        router.push('/backup-reminder');
      } catch {
        // Navigation tree not ready yet — allow a retry on the next foreground.
        shownRef.current = false;
      }
    };

    // Delay the initial eval so it fires AFTER boot-time navigation settles the
    // route to the chat home — otherwise a boot `router.replace('/')` can land
    // on top of (and discard) our push. Foreground transitions are already
    // post-boot, so those eval immediately.
    const initial = setTimeout(() => void maybePrompt(), 1500);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void maybePrompt();
    });
    return () => {
      cancelled = true;
      clearTimeout(initial);
      sub.remove();
    };
  }, [unlocked, router]);
}
