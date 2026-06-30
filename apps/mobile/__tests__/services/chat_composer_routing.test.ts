/**
 * Talk composer routing — the §7 suggest-not-auto-fire control point (P2.2).
 *
 * The chip SEEDS `/schedule ` and NEVER dispatches; the dispatch only happens
 * when the user submits and `routeComposerText` classifies the text. These
 * tests pin that control point + the three-way route (schedule / slash / send)
 * so a regression that auto-fires or misroutes ships RED, not green.
 */

import {
  routeComposerText,
  isScheduleCommand,
  SCHEDULE_SEED,
} from '../../src/services/chat_composer_routing';

describe('chat composer routing — control point', () => {
  it('the chip seed is exactly "/schedule " (seeds, does not submit)', () => {
    expect(SCHEDULE_SEED).toBe('/schedule ');
    // The seed itself is a bare `/schedule ` — classifying it routes to
    // `schedule`, but routing only RUNS on submit, never on seed. The screen
    // wires `onSeedSchedule` to setDraft(SCHEDULE_SEED) with no dispatch; the
    // separation is the whole control point.
  });

  it('routes a /schedule command (contact-scoped) — bare and with an argument', () => {
    expect(routeComposerText('/schedule')).toBe('schedule');
    expect(routeComposerText('/schedule find a time next week')).toBe('schedule');
    expect(routeComposerText('  /schedule coffee?  ')).toBe('schedule');
    expect(routeComposerText('/SCHEDULE lunch')).toBe('schedule'); // case-insensitive
  });

  it('routes any OTHER slash command to the redirect lane (talks to Dina, not the peer)', () => {
    expect(routeComposerText('/ask what is the weather')).toBe('slash');
    expect(routeComposerText('/remember dentist Thursday')).toBe('slash');
    expect(routeComposerText('/search kebab')).toBe('slash');
    expect(routeComposerText('/help')).toBe('slash');
    // A word that merely starts with "schedule" but isn't the command stays slash.
    expect(routeComposerText('/scheduler')).toBe('slash');
  });

  it('routes plain text to a normal peer send', () => {
    expect(routeComposerText('hey, want to grab coffee?')).toBe('send');
    expect(routeComposerText("let's hang out sometime")).toBe('send'); // NOT misread as schedule
    expect(routeComposerText('schedule but no slash')).toBe('send');
  });

  it('stays total on empty/whitespace input (caller guards, helper never throws)', () => {
    expect(routeComposerText('')).toBe('send');
    expect(routeComposerText('   ')).toBe('send');
  });

  it('isScheduleCommand is the single shared predicate (chip-show ↔ submit route agree)', () => {
    // The chip is HIDDEN exactly when the draft already is a /schedule command;
    // the submit router treats the same text as `schedule`. One predicate.
    for (const t of ['/schedule', '/schedule x', '  /schedule  ', '/SCHEDULE y']) {
      expect(isScheduleCommand(t)).toBe(true);
      expect(routeComposerText(t)).toBe('schedule');
    }
    for (const t of ['/scheduler', '/ask', 'hi', 'schedule x', '']) {
      expect(isScheduleCommand(t)).toBe(false);
      expect(routeComposerText(t)).not.toBe('schedule');
    }
  });
});
