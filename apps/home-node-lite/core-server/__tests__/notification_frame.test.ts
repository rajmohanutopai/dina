/**
 * Task 4.40 — CLI-parity notification frame tests.
 *
 * Pins the wire shape the `/v1/ws/notify` hub emits so the CLI
 * (future consumer in `packages/cli-node` / the Dina CLI) can
 * rely on it byte-for-byte. The round-trip test (build → parse)
 * proves the consumer's parser accepts everything the producer
 * emits.
 */

import {
  NOTIFICATION_FRAME_TYPE,
  NOTIFICATION_FRAME_VERSION,
  VALID_NOTIFICATION_PRIORITIES,
  buildNotificationFrame,
  isNotificationFrame,
  parseNotificationFrame,
} from '../src/ws/notification_frame';

const validInput = {
  priority: 'fiduciary' as const,
  message: 'Bus 42 arriving in 5 minutes',
  id: 'nudge-1',
  ts: 1_700_000_000_000,
};

describe('notification_frame (task 4.40)', () => {
  describe('constants', () => {
    it('NOTIFICATION_FRAME_TYPE is the literal "notification"', () => {
      expect(NOTIFICATION_FRAME_TYPE).toBe('notification');
    });
    it('NOTIFICATION_FRAME_VERSION is 1', () => {
      expect(NOTIFICATION_FRAME_VERSION).toBe(1);
    });
    it('VALID_NOTIFICATION_PRIORITIES is exactly the 3 Silence-First tiers', () => {
      expect([...VALID_NOTIFICATION_PRIORITIES].sort()).toEqual([
        'engagement',
        'fiduciary',
        'solicited',
      ]);
    });
  });

  describe('buildNotificationFrame', () => {
    it('produces the canonical shape verbatim', () => {
      expect(buildNotificationFrame(validInput)).toEqual({
        type: 'notification',
        v: 1,
        priority: 'fiduciary',
        message: 'Bus 42 arriving in 5 minutes',
        ts: 1_700_000_000_000,
        id: 'nudge-1',
      });
    });

    it('accepts all 3 priorities', () => {
      for (const priority of [
        'fiduciary',
        'solicited',
        'engagement',
      ] as const) {
        expect(buildNotificationFrame({ ...validInput, priority }).priority).toBe(
          priority,
        );
      }
    });

    it('rejects unknown priority', () => {
      expect(() =>
        buildNotificationFrame({
          ...validInput,
          priority: 'admin' as unknown as typeof validInput.priority,
        }),
      ).toThrow(/invalid priority/);
    });

    it('rejects non-string message', () => {
      expect(() =>
        buildNotificationFrame({
          ...validInput,
          message: 42 as unknown as string,
        }),
      ).toThrow(/message must be a string/);
    });

    it.each([
      ['empty id', ''],
      ['non-string id', 42 as unknown as string],
    ])('rejects %s', (_label, id) => {
      expect(() => buildNotificationFrame({ ...validInput, id })).toThrow(
        /id must be a non-empty string/,
      );
    });

    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['negative', -1],
      ['string', 'abc' as unknown as number],
    ])('rejects ts %s', (_label, ts) => {
      expect(() => buildNotificationFrame({ ...validInput, ts })).toThrow(
        /ts must be/,
      );
    });

    it('accepts ts = 0 (epoch)', () => {
      expect(buildNotificationFrame({ ...validInput, ts: 0 }).ts).toBe(0);
    });

    it('accepts empty message (valid "silence" event)', () => {
      expect(buildNotificationFrame({ ...validInput, message: '' }).message).toBe(
        '',
      );
    });
  });

  describe('isNotificationFrame type guard', () => {
    it('accepts a well-formed frame', () => {
      expect(isNotificationFrame(buildNotificationFrame(validInput))).toBe(true);
    });

    it.each([
      ['null', null],
      ['string', 'not an object'],
      ['number', 42],
      ['missing type', { v: 1, priority: 'fiduciary', message: '', ts: 0, id: 'x' }],
      ['wrong type', { type: 'other', v: 1, priority: 'fiduciary', message: '', ts: 0, id: 'x' }],
      ['wrong v', { type: 'notification', v: 2, priority: 'fiduciary', message: '', ts: 0, id: 'x' }],
      ['bad priority', { type: 'notification', v: 1, priority: 'admin', message: '', ts: 0, id: 'x' }],
      ['missing id', { type: 'notification', v: 1, priority: 'fiduciary', message: '', ts: 0 }],
    ])('rejects %s', (_label, candidate) => {
      expect(isNotificationFrame(candidate)).toBe(false);
    });
  });

  describe('parseNotificationFrame', () => {
    it('round-trips: build → JSON.stringify → parseNotificationFrame', () => {
      const frame = buildNotificationFrame(validInput);
      const raw = JSON.stringify(frame);
      const parsed = parseNotificationFrame(raw);
      expect(parsed).toEqual({ ok: true, frame });
    });

    it('rejects malformed JSON', () => {
      expect(parseNotificationFrame('{not json')).toEqual({
        ok: false,
        reason: 'not_json',
      });
    });

    it('rejects non-object JSON', () => {
      expect(parseNotificationFrame('42')).toEqual({
        ok: false,
        reason: 'not_object',
      });
      expect(parseNotificationFrame('"string"')).toEqual({
        ok: false,
        reason: 'not_object',
      });
      expect(parseNotificationFrame('null')).toEqual({
        ok: false,
        reason: 'not_object',
      });
    });

    it('rejects wrong type', () => {
      expect(
        parseNotificationFrame(
          JSON.stringify({ ...buildNotificationFrame(validInput), type: 'heartbeat' }),
        ),
      ).toEqual({ ok: false, reason: 'wrong_type' });
    });

    it('rejects wrong version (forward-compat guard)', () => {
      expect(
        parseNotificationFrame(
          JSON.stringify({ ...buildNotificationFrame(validInput), v: 2 }),
        ),
      ).toEqual({ ok: false, reason: 'wrong_version' });
    });

    it('rejects invalid priority', () => {
      expect(
        parseNotificationFrame(
          JSON.stringify({ ...buildNotificationFrame(validInput), priority: 'admin' }),
        ),
      ).toEqual({ ok: false, reason: 'invalid_priority' });
    });

    it('rejects malformed field types', () => {
      expect(
        parseNotificationFrame(
          JSON.stringify({ ...buildNotificationFrame(validInput), ts: 'not-a-number' }),
        ),
      ).toEqual({ ok: false, reason: 'invalid_field' });
      expect(
        parseNotificationFrame(
          JSON.stringify({ ...buildNotificationFrame(validInput), id: '' }),
        ),
      ).toEqual({ ok: false, reason: 'invalid_field' });
    });
  });

  describe('CLI parity — full round-trip across all priorities', () => {
    it('build → stringify → parse preserves every field for each priority', () => {
      for (const priority of [
        'fiduciary',
        'solicited',
        'engagement',
      ] as const) {
        const frame = buildNotificationFrame({
          priority,
          message: `msg-${priority}`,
          id: `id-${priority}`,
          ts: 1_700_000_000_000,
        });
        const parsed = parseNotificationFrame(JSON.stringify(frame));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.frame).toEqual(frame);
      }
    });
  });
});
