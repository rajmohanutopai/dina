/**
 * Task 4.79 — rehydration session registry tests.
 */

import {
  DEFAULT_REHYDRATION_TTL_MS,
  RehydrationSessionRegistry,
  type RehydrationEntity,
  type RehydrationSessionEvent,
} from '../src/pii/rehydration_sessions';

function fixedClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

function seqIds(): () => string {
  let n = 0;
  return () => `s-${++n}`;
}

const sampleEntities: RehydrationEntity[] = [
  { token: '[EMAIL_1]', value: 'alice@example.com' },
  { token: '[PHONE_1]', value: '555-0100' },
];

describe('RehydrationSessionRegistry (task 4.79)', () => {
  describe('create + get', () => {
    it('stores entities and returns a session id + expiry', () => {
      const clock = fixedClock();
      const reg = new RehydrationSessionRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
      });
      const { sessionId, expiresAtMs } = reg.create(sampleEntities);
      expect(sessionId).toBe('s-1');
      expect(expiresAtMs).toBe(clock.nowMsFn() + DEFAULT_REHYDRATION_TTL_MS);
      expect(reg.get(sessionId)).toEqual(sampleEntities);
    });

    it('honours a per-session ttlMs override', () => {
      const clock = fixedClock();
      const reg = new RehydrationSessionRegistry({ nowMsFn: clock.nowMsFn });
      const { sessionId, expiresAtMs } = reg.create(sampleEntities, { ttlMs: 1000 });
      expect(expiresAtMs).toBe(clock.nowMsFn() + 1000);
      expect(reg.isLive(sessionId)).toBe(true);
    });

    it('defensive-copies the entity array (caller mutation is safe)', () => {
      const reg = new RehydrationSessionRegistry();
      const entities: RehydrationEntity[] = [{ token: '[EMAIL_1]', value: 'a@b.com' }];
      const { sessionId } = reg.create(entities);
      entities[0]!.value = 'MUTATED';
      const fetched = reg.get(sessionId)!;
      expect(fetched[0]!.value).toBe('a@b.com');
    });

    it('get returns undefined on unknown id', () => {
      const reg = new RehydrationSessionRegistry();
      expect(reg.get('ghost')).toBeUndefined();
    });

    it('get auto-removes + returns undefined past TTL', () => {
      const clock = fixedClock();
      const events: RehydrationSessionEvent[] = [];
      const reg = new RehydrationSessionRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
        onEvent: (e) => events.push(e),
      });
      const { sessionId } = reg.create(sampleEntities, { ttlMs: 1000 });
      clock.advance(1001);
      expect(reg.get(sessionId)).toBeUndefined();
      // subsequent get is also undefined (entry already removed)
      expect(reg.get(sessionId)).toBeUndefined();
      expect(reg.size()).toBe(0);
      expect(events.some((e) => e.kind === 'expired' && e.id === sessionId)).toBe(true);
    });
  });

  describe('consume', () => {
    it('returns entities AND destroys the session', () => {
      const events: RehydrationSessionEvent[] = [];
      const reg = new RehydrationSessionRegistry({
        idFn: seqIds(),
        onEvent: (e) => events.push(e),
      });
      const { sessionId } = reg.create(sampleEntities);
      const fetched = reg.consume(sessionId);
      expect(fetched).toEqual(sampleEntities);
      expect(reg.get(sessionId)).toBeUndefined();
      expect(events.some((e) => e.kind === 'consumed' && e.id === sessionId)).toBe(true);
    });

    it('returns undefined on unknown id', () => {
      const reg = new RehydrationSessionRegistry();
      expect(reg.consume('ghost')).toBeUndefined();
    });

    it('returns undefined on expired id + destroys the stale record', () => {
      const clock = fixedClock();
      const reg = new RehydrationSessionRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
      });
      const { sessionId } = reg.create(sampleEntities, { ttlMs: 1000 });
      clock.advance(1001);
      expect(reg.consume(sessionId)).toBeUndefined();
      expect(reg.size()).toBe(0);
    });
  });

  describe('destroy + sweepExpired', () => {
    it('destroy removes a live session', () => {
      const reg = new RehydrationSessionRegistry({ idFn: seqIds() });
      const { sessionId } = reg.create(sampleEntities);
      expect(reg.destroy(sessionId)).toBe(true);
      expect(reg.destroy(sessionId)).toBe(false); // already gone
    });

    it('sweepExpired removes only expired sessions + returns count', () => {
      const clock = fixedClock();
      const reg = new RehydrationSessionRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
      });
      reg.create(sampleEntities, { ttlMs: 500 });
      reg.create(sampleEntities, { ttlMs: 500 });
      reg.create(sampleEntities, { ttlMs: 10_000 });
      clock.advance(501);
      expect(reg.sweepExpired()).toBe(2);
      expect(reg.size()).toBe(1);
    });
  });

  describe('validation', () => {
    it('rejects non-array entities', () => {
      const reg = new RehydrationSessionRegistry();
      expect(() =>
        reg.create('not-an-array' as unknown as RehydrationEntity[]),
      ).toThrow(/entities must be an array/);
    });

    it('rejects malformed entity items', () => {
      const reg = new RehydrationSessionRegistry();
      expect(() =>
        reg.create([{ token: '', value: 'x' }]),
      ).toThrow(/must have \{token, value\} strings/);
      expect(() =>
        reg.create([{ token: 'x' } as unknown as RehydrationEntity]),
      ).toThrow(/must have \{token, value\} strings/);
    });

    it('rejects non-positive ttl', () => {
      const reg = new RehydrationSessionRegistry();
      expect(() => reg.create(sampleEntities, { ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
      expect(() => reg.create(sampleEntities, { ttlMs: NaN })).toThrow(
        /ttlMs must be > 0/,
      );
    });

    it('constructor rejects non-positive defaultTtlMs', () => {
      expect(() => new RehydrationSessionRegistry({ defaultTtlMs: 0 })).toThrow(
        /defaultTtlMs must be > 0/,
      );
    });
  });

  describe('constants', () => {
    it('DEFAULT_REHYDRATION_TTL_MS = 10 minutes', () => {
      expect(DEFAULT_REHYDRATION_TTL_MS).toBe(10 * 60 * 1000);
    });
  });

  describe('events', () => {
    it('fires created → consumed or destroyed in order', () => {
      const events: RehydrationSessionEvent[] = [];
      const reg = new RehydrationSessionRegistry({
        idFn: seqIds(),
        onEvent: (e) => events.push(e),
      });
      const { sessionId } = reg.create(sampleEntities);
      reg.destroy(sessionId);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['created', 'destroyed']);
      const created = events[0] as Extract<
        RehydrationSessionEvent,
        { kind: 'created' }
      >;
      expect(created.entityCount).toBe(sampleEntities.length);
    });
  });
});
