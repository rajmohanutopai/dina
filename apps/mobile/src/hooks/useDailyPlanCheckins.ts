/**
 * Keep the daily plan's check-ins current (docs/DAILY_PLAN.md §8): once the
 * vault opens, and on every return to the foreground, reschedule them with
 * the text that's true now. The phone runs nothing in the background, so
 * this is the only time their counts can change.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';

import { rescheduleCheckins } from '../services/daily_plan';

export function useDailyPlanCheckins(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    void rescheduleCheckins().catch(() => undefined);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void rescheduleCheckins().catch(() => undefined);
    });
    return () => sub.remove();
  }, [enabled]);
}
