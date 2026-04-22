/**
 * Appointment-status formatter tests (WM-TEST-05).
 *
 * Pins the output shape from main-dina
 * `brain/tests/test_service_query_formatters.py`. Ported verbatim
 * (11 cases): confirmed full / empty / date-only; rescheduled with
 * new date; cancelled with note; not_found; the never-raw-JSON
 * invariant; unknown-status graceful degradation; string-result
 * parsing; registry check; and end-to-end dispatch through
 * `formatServiceQueryResult`.
 */

import { formatServiceQueryResult } from '../../src/service/result_formatter';

describe('formatAppointmentStatus', () => {
  const NAME = "Dr Carl's Clinic";

  function run(resultOverrides: Record<string, unknown>): string {
    return formatServiceQueryResult({
      response_status: 'success',
      capability: 'appointment_status',
      service_name: NAME,
      result: resultOverrides,
    });
  }

  it('confirmed_full_date_time', () => {
    const got = run({ status: 'confirmed', date: 'Apr 19', time: '3:00 PM' });
    expect(got).toBe(
      `\u{1F4EC} Reply from ${NAME}\n` + 'Your appointment on Apr 19 at 3:00 PM is confirmed.',
    );
  });

  it('confirmed_empty_date_time', () => {
    // Both fields blank → collapse to the bare "Your appointment is
    // confirmed." sentence. No "on at" artifact.
    const got = run({ status: 'confirmed', date: '', time: '' });
    expect(got).toBe(`\u{1F4EC} Reply from ${NAME}\n` + 'Your appointment is confirmed.');
  });

  it('confirmed_date_only', () => {
    const got = run({ status: 'confirmed', date: 'Apr 19' });
    expect(got).toContain('on Apr 19 is confirmed.');
    expect(got).not.toContain('at ');
  });

  it('confirmed_time_only', () => {
    const got = run({ status: 'confirmed', time: '3:00 PM' });
    expect(got).toContain('at 3:00 PM is confirmed.');
    expect(got).not.toContain('on ');
  });

  it('rescheduled_with_new_date', () => {
    const got = run({
      status: 'rescheduled',
      date: 'Apr 26',
      time: '4:00 PM',
      note: 'Rescheduled due to provider schedule conflict.',
    });
    expect(got).toBe(
      `\u{1F4EC} Reply from ${NAME}\n` +
        'Your appointment has been rescheduled to on Apr 26 at 4:00 PM.\n' +
        'Rescheduled due to provider schedule conflict.',
    );
  });

  it('rescheduled without when has no trailing "to"', () => {
    const got = run({ status: 'rescheduled' });
    // Just "Your appointment has been rescheduled." with no " to"
    // tail when there's nothing to reschedule TO.
    expect(got).toContain('Your appointment has been rescheduled.');
    expect(got).not.toContain(' to.');
  });

  it('cancelled_includes_note', () => {
    const got = run({
      status: 'cancelled',
      date: 'Apr 19',
      note: 'Dr Carl will reach out to reschedule.',
    });
    // Cancelled ignores the when clause (matches the Python port)
    // and appends note on a new line.
    expect(got).toBe(
      `\u{1F4EC} Reply from ${NAME}\n` +
        'Your appointment has been cancelled.\n' +
        'Dr Carl will reach out to reschedule.',
    );
  });

  it('cancelled without a note omits the trailing newline', () => {
    const got = run({ status: 'cancelled' });
    expect(got).toBe(`\u{1F4EC} Reply from ${NAME}\n` + 'Your appointment has been cancelled.');
  });

  it('not_found', () => {
    const got = run({ status: 'not_found' });
    expect(got).toBe(`\u{1F4EC} Reply from ${NAME}\n` + 'No record of your appointment was found.');
  });

  it('never_returns_raw_json (the load-bearing invariant)', () => {
    // Regardless of what junk arrives in `result`, the formatter
    // must NEVER dump its JSON. Tested with a payload that would
    // embarrassingly stringify into the output if there were a
    // catch-all `JSON.stringify` path.
    const payloads = [
      { status: 'confirmed', date: 'Apr 19', time: '3PM', secret: 'DO_NOT_LEAK' },
      { status: 'gibberish', patient_ref: 'leak-me', ssn: '123-45-6789' },
      { reason: 'malformed', stack: ['private', 'info'] },
      undefined,
      null,
      'not-an-object',
    ];
    for (const payload of payloads) {
      const got = run(payload as Record<string, unknown>);
      // No raw JSON braces or array syntax should leak through.
      expect(got).not.toMatch(/\{.*"/);
      expect(got).not.toMatch(/\[.*"/);
      expect(got).not.toContain('DO_NOT_LEAK');
      expect(got).not.toContain('leak-me');
      expect(got).not.toContain('123-45-6789');
    }
  });

  it('unknown_status_degrades_gracefully', () => {
    const got = run({ status: 'werent_expecting_this' });
    expect(got).toBe(`\u{1F4EC} Reply from ${NAME}\n` + 'Unexpected status: werent_expecting_this');
  });

  it('missing status reports "unknown" (not "(empty)")', () => {
    // Empty / missing status is rendered as "unknown" per the
    // Python port's `status or 'unknown'` branch.
    const got = run({ date: 'Apr 19' });
    expect(got).toContain('Unexpected status: unknown');
  });

  it('string_result_parsed_as_json', () => {
    // When the provider sends result as a JSON STRING (not parsed),
    // the formatter must parse it transparently — matches
    // parseResultObject's contract.
    const got = formatServiceQueryResult({
      response_status: 'success',
      capability: 'appointment_status',
      service_name: NAME,
      result: JSON.stringify({ status: 'confirmed', date: 'Apr 19' }),
    });
    expect(got).toContain('on Apr 19 is confirmed.');
  });

  it('malformed string result does NOT throw, degrades to unknown', () => {
    const got = formatServiceQueryResult({
      response_status: 'success',
      capability: 'appointment_status',
      service_name: NAME,
      result: '{not even json',
    });
    // parseResultObject returns {} on a broken string → no status
    // field → "unknown" unknown-status branch.
    expect(got).toContain('Unexpected status: unknown');
  });

  it('format_service_query_result_routes_to_appointment_formatter', () => {
    // Dispatch check: `formatServiceQueryResult` must pick the
    // appointment_status formatter (not the generic fallback) when
    // capability === 'appointment_status'. Regression guard against
    // a broken registry or accidental formatter collision.
    const got = formatServiceQueryResult({
      response_status: 'success',
      capability: 'appointment_status',
      service_name: NAME,
      result: { status: 'confirmed' },
    });
    // Provenance header is specific to the appointment formatter.
    expect(got.startsWith(`\u{1F4EC} Reply from ${NAME}`)).toBe(true);
    // Would the generic formatter have matched? It emits " —
    // response received: …" which appointment_status never does.
    expect(got).not.toContain('response received');
  });

  it('trims leading/trailing whitespace in date/time/note', () => {
    const got = run({
      status: 'confirmed',
      date: '  Apr 19  ',
      time: '  3:00 PM  ',
    });
    expect(got).toContain('on Apr 19 at 3:00 PM is confirmed.');
  });

  it('case-insensitive status (Python calls .lower() first)', () => {
    expect(run({ status: 'CONFIRMED' })).toContain('is confirmed.');
    expect(run({ status: 'Rescheduled' })).toContain('has been rescheduled');
    expect(run({ status: 'CANCELLED' })).toContain('has been cancelled.');
    expect(run({ status: 'Not_Found' })).toContain('No record of your appointment');
  });
});
