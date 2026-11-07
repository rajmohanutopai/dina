/**
 * Keep the daily plan's check-ins current (docs/DAILY_PLAN.md §8, §25): once
 * the vault opens, on every return to the foreground, and when chat or an
 * agent changes the plan, reschedule them with the text that's true now. The
 * phone runs nothing in the background, so these are the only times their
 * counts can change.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';

import { setDayPlanRunner } from '@dina/brain';
import { setPlanChangedListener } from '@dina/core';

import {
  applySavedQuietHours,
  planTodayForChat,
  rescheduleCheckins,
} from '../services/daily_plan';

/** Chat can change several things in one turn; reschedule once after them. */
const CHANGE_SETTLE_MS = 1000;

export function useDailyPlanCheckins(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    void applySavedQuietHours()
      .then(() => rescheduleCheckins())
      .catch(() => undefined);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void rescheduleCheckins().catch(() => undefined);
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    setPlanChangedListener(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void rescheduleCheckins().catch(() => undefined);
      }, CHANGE_SETTLE_MS);
    });
    setDayPlanRunner(planTodayForChat);
    return () => {
      sub.remove();
      setPlanChangedListener(null);
      setDayPlanRunner(null);
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled]);
}
