/** REAL_LIFE_FIXES_2 §10 — the time block gives local dates and the weeks, in the owner's zone. */

import { formatCurrentTimeBlock } from '../../src/reasoning/ask_handler';

// Friday 9 Oct 2026, 20:30 UTC = Saturday 10 Oct 02:00 in Kolkata.
const AT = Date.UTC(2026, 9, 9, 20, 30);

it("uses the owner's zone, not the host's", () => {
  const block = formatCurrentTimeBlock(() => AT, 'Asia/Kolkata');
  expect(block).toContain('timezone: Asia/Kolkata');
  expect(block).toContain('today: Sat, 10 Oct 2026 (Saturday)');
  expect(block).toContain('this week (Mon–Sun): Mon, 5 Oct 2026 to Sun, 11 Oct 2026');
  expect(block).toContain('next week (Mon–Sun): Mon, 12 Oct 2026 to Sun, 18 Oct 2026');
});

it('the same instant in UTC is still Friday', () => {
  expect(formatCurrentTimeBlock(() => AT, 'UTC')).toContain('today: Fri, 9 Oct 2026 (Friday)');
});

it('an unknown zone falls back to UTC', () => {
  expect(formatCurrentTimeBlock(() => AT, 'Mars/Base')).toContain('timezone: UTC');
});
