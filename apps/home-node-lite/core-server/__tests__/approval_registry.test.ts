/**
 * Task 4.72 — Brain + agent approval flow tests.
 *
 * Injected clock + id generator keep assertions exact.
 */

import {
  ApprovalRegistry,
  DEFAULT_APPROVAL_TTL_MS,
  type ApprovalEvent,
} from '../src/persona/approval_registry';

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
  return () => `req-${++n}`;
}

const baseInput = {
  action: 'vault_query',
  requesterDid: 'did:key:brain',
  persona: '/health',
  reason: 'summarize recent lab results',
  preview: 'latest blood panel',
};

describe('ApprovalRegistry (task 4.72)', () => {
  describe('request', () => {
    it('enqueues a pending request with id, createdAt, expiresAt', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({ nowMsFn: clock.nowMsFn, idFn: seqIds() });
      const req = reg.request(baseInput);
      expect(req).toMatchObject({
        id: 'req-1',
        status: 'pending',
        scope: 'single',
        createdAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_000_000_000 + DEFAULT_APPROVAL_TTL_MS,
      });
      expect(reg.size()).toBe(1);
    });

    it('honours per-request ttlMs override', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({ nowMsFn: clock.nowMsFn, idFn: seqIds() });
      const req = reg.request({ ...baseInput, ttlMs: 10_000 });
      expect(req.expiresAtMs - req.createdAtMs).toBe(10_000);
    });

    it('honours scope override', () => {
      const reg = new ApprovalRegistry({ idFn: seqIds() });
      expect(reg.request({ ...baseInput, scope: 'session' }).scope).toBe('session');
    });

    it.each([
      ['action', { ...baseInput, action: '' }],
      ['requesterDid', { ...baseInput, requesterDid: '' }],
      ['persona', { ...baseInput, persona: '' }],
    ])('rejects missing %s', (field, input) => {
      const reg = new ApprovalRegistry();
      expect(() => reg.request(input)).toThrow(new RegExp(`${field} is required`));
    });

    it('rejects non-positive ttlMs', () => {
      const reg = new ApprovalRegistry();
      expect(() => reg.request({ ...baseInput, ttlMs: 0 })).toThrow(/ttlMs must be > 0/);
      expect(() => reg.request({ ...baseInput, ttlMs: -1 })).toThrow(/ttlMs must be > 0/);
    });

    it('emits `requested` event', () => {
      const events: ApprovalEvent[] = [];
      const reg = new ApprovalRegistry({ idFn: seqIds(), onEvent: (e) => events.push(e) });
      reg.request(baseInput);
      expect(events.map((e) => e.kind)).toEqual(['requested']);
    });
  });

  describe('approve + deny', () => {
    it('approve transitions pending → approved with resolvedAtMs', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({ nowMsFn: clock.nowMsFn, idFn: seqIds() });
      const req = reg.request(baseInput);
      clock.advance(5_000);
      const out = reg.approve(req.id)!;
      expect(out.status).toBe('approved');
      expect(out.resolvedAtMs).toBe(1_700_000_000_000 + 5_000);
    });

    it('deny transitions pending → denied', () => {
      const reg = new ApprovalRegistry({ idFn: seqIds() });
      const req = reg.request(baseInput);
      expect(reg.deny(req.id)!.status).toBe('denied');
    });

    it('approve on unknown id returns undefined', () => {
      const reg = new ApprovalRegistry();
      expect(reg.approve('ghost')).toBeUndefined();
    });

    it('approve after deny throws (race surfaced, not silenced)', () => {
      const reg = new ApprovalRegistry({ idFn: seqIds() });
      const req = reg.request(baseInput);
      reg.deny(req.id);
      expect(() => reg.approve(req.id)).toThrow(/already terminal \(denied\)/);
    });

    it('deny after approve throws', () => {
      const reg = new ApprovalRegistry({ idFn: seqIds() });
      const req = reg.request(baseInput);
      reg.approve(req.id);
      expect(() => reg.deny(req.id)).toThrow(/already terminal \(approved\)/);
    });

    it('approve after expiry auto-expires instead of approving', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
        defaultTtlMs: 10_000,
      });
      const req = reg.request(baseInput);
      clock.advance(11_000);
      const out = reg.approve(req.id)!;
      expect(out.status).toBe('expired');
    });

    it('emits `approved` / `denied` events', () => {
      const events: ApprovalEvent[] = [];
      const reg = new ApprovalRegistry({ idFn: seqIds(), onEvent: (e) => events.push(e) });
      const a = reg.request(baseInput);
      const b = reg.request({ ...baseInput, persona: '/financial' });
      reg.approve(a.id);
      reg.deny(b.id);
      expect(events.map((e) => e.kind)).toEqual([
        'requested',
        'requested',
        'approved',
        'denied',
      ]);
    });
  });

  describe('sweep + expiry', () => {
    it('sweep moves expired pending → expired and returns count', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
        defaultTtlMs: 10_000,
      });
      reg.request(baseInput);
      reg.request({ ...baseInput, persona: '/financial' });
      clock.advance(10_001);
      expect(reg.sweep()).toBe(2);
      expect(reg.listPending()).toEqual([]);
    });

    it('sweep leaves not-yet-expired pending untouched', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
        defaultTtlMs: 10_000,
      });
      const req = reg.request(baseInput);
      clock.advance(5_000);
      expect(reg.sweep()).toBe(0);
      expect(reg.get(req.id)!.status).toBe('pending');
    });

    it('emits `expired` events per sweep', () => {
      const events: ApprovalEvent[] = [];
      const clock = fixedClock();
      const reg = new ApprovalRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
        defaultTtlMs: 1_000,
        onEvent: (e) => events.push(e),
      });
      reg.request(baseInput);
      clock.advance(2_000);
      events.length = 0;
      reg.sweep();
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('expired');
    });

    it('sweep is idempotent (calling twice does not re-expire)', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({
        nowMsFn: clock.nowMsFn,
        idFn: seqIds(),
        defaultTtlMs: 10_000,
      });
      reg.request(baseInput);
      clock.advance(11_000);
      expect(reg.sweep()).toBe(1);
      expect(reg.sweep()).toBe(0);
    });
  });

  describe('listPending + all', () => {
    it('listPending returns only pending, sorted by createdAtMs asc', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({ nowMsFn: clock.nowMsFn, idFn: seqIds() });
      const first = reg.request(baseInput);
      clock.advance(100);
      const second = reg.request({ ...baseInput, persona: '/financial' });
      clock.advance(100);
      reg.request({ ...baseInput, persona: '/work' });
      reg.deny(second.id); // drop one from pending

      const pending = reg.listPending();
      expect(pending.map((r) => r.id)).toEqual([first.id, 'req-3']);
    });

    it('all includes terminal states ordered by createdAtMs', () => {
      const clock = fixedClock();
      const reg = new ApprovalRegistry({ nowMsFn: clock.nowMsFn, idFn: seqIds() });
      reg.request(baseInput);
      clock.advance(100);
      const b = reg.request({ ...baseInput, persona: '/financial' });
      reg.deny(b.id);
      expect(reg.all().map((r) => r.status)).toEqual(['pending', 'denied']);
    });
  });

  describe('forget', () => {
    it('removes terminal records', () => {
      const reg = new ApprovalRegistry({ idFn: seqIds() });
      const req = reg.request(baseInput);
      reg.approve(req.id);
      expect(reg.forget(req.id)).toBe(true);
      expect(reg.get(req.id)).toBeUndefined();
    });

    it('refuses to forget pending records', () => {
      const reg = new ApprovalRegistry({ idFn: seqIds() });
      const req = reg.request(baseInput);
      expect(reg.forget(req.id)).toBe(false);
      expect(reg.get(req.id)!.status).toBe('pending');
    });

    it('is a safe no-op on unknown id', () => {
      const reg = new ApprovalRegistry();
      expect(reg.forget('ghost')).toBe(false);
    });
  });

  describe('constructor validation', () => {
    it('rejects non-positive defaultTtlMs', () => {
      expect(() => new ApprovalRegistry({ defaultTtlMs: 0 })).toThrow(
        /defaultTtlMs must be > 0/,
      );
      expect(() => new ApprovalRegistry({ defaultTtlMs: NaN })).toThrow(
        /defaultTtlMs must be > 0/,
      );
    });
  });

  describe('constants', () => {
    it('DEFAULT_APPROVAL_TTL_MS = 5 minutes', () => {
      expect(DEFAULT_APPROVAL_TTL_MS).toBe(5 * 60 * 1000);
    });
  });
});
