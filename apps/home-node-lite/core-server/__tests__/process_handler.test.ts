/**
 * Task 5.16 — process handler tests.
 */

import {
  createProcessHandler,
  type NotifyFn,
  type PrioritiseFn,
  type ProcessHandlerEvent,
  type ProcessRequest,
  type ProcessResult,
} from '../src/brain/process_handler';
import type { Classification, DomainClassifier } from '../src/brain/domain_classifier';

function stubClassifier(
  partial: Partial<Classification> = {},
): Pick<DomainClassifier, 'classify'> {
  return {
    classify: async () => ({
      sensitivity: partial.sensitivity ?? 'general',
      domain: partial.domain ?? 'general',
      reason: partial.reason ?? 'keyword',
      confidence: partial.confidence ?? 0.6,
      layer: partial.layer ?? 'keyword',
    }),
  };
}

const baseReq: ProcessRequest = {
  eventId: 'evt-1',
  content: 'Payment due for the electric bill next Tuesday',
  persona: 'financial',
  kind: 'gmail',
};

describe('createProcessHandler (task 5.16)', () => {
  describe('construction', () => {
    it.each(['domainClassifier', 'prioritiseFn', 'notifyFn'] as const)(
      'throws when %s missing',
      (missing) => {
        const opts = {
          domainClassifier: stubClassifier(),
          prioritiseFn: async () => ({ kind: 'skip', reason: 'x' }) as const,
          notifyFn: async () => 'notified' as const,
        };
        delete (opts as Record<string, unknown>)[missing];
        expect(() =>
          createProcessHandler(opts as Parameters<typeof createProcessHandler>[0]),
        ).toThrow(new RegExp(missing));
      },
    );
  });

  describe('happy path — deliver', () => {
    it('fiduciary priority → disposition=notified', async () => {
      const prioritiseFn: PrioritiseFn = async () => ({
        kind: 'deliver',
        priority: 'fiduciary',
      });
      const notifyFn: NotifyFn = async () => 'notified';
      const handler = createProcessHandler({
        domainClassifier: stubClassifier({ domain: 'financial' }),
        prioritiseFn,
        notifyFn,
      });
      const res = (await handler(baseReq)) as Extract<ProcessResult, { status: 200 }>;
      expect(res.status).toBe(200);
      expect(res.body.disposition).toBe('notified');
      expect(res.body.priority).toBe('fiduciary');
      expect(res.body.classification.domain).toBe('financial');
    });

    it('engagement priority → disposition=buffered', async () => {
      const prioritiseFn: PrioritiseFn = async () => ({
        kind: 'deliver',
        priority: 'engagement',
      });
      const notifyFn: NotifyFn = async () => 'buffered';
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn,
        notifyFn,
      });
      const res = (await handler(baseReq)) as Extract<ProcessResult, { status: 200 }>;
      expect(res.body.disposition).toBe('buffered');
      expect(res.body.priority).toBe('engagement');
    });

    it('skip outcome → disposition=skipped with reason', async () => {
      const prioritiseFn: PrioritiseFn = async () => ({
        kind: 'skip',
        reason: 'duplicate event',
      });
      const notifyFn: NotifyFn = jest.fn(async () => 'notified' as const);
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn,
        notifyFn,
      });
      const res = (await handler(baseReq)) as Extract<ProcessResult, { status: 200 }>;
      expect(res.body.disposition).toBe('skipped');
      expect(res.body.priority).toBeNull();
      expect(res.body.skip_reason).toBe('duplicate event');
      // notifyFn never called on skip.
      expect(notifyFn).not.toHaveBeenCalled();
    });

    it('classifier output threaded to prioritiser', async () => {
      let seenClassification: Classification | null = null;
      const handler = createProcessHandler({
        domainClassifier: stubClassifier({
          domain: 'health',
          sensitivity: 'sensitive',
        }),
        prioritiseFn: async ({ classification }) => {
          seenClassification = classification;
          return { kind: 'deliver', priority: 'fiduciary' };
        },
        notifyFn: async () => 'notified',
      });
      await handler(baseReq);
      expect(seenClassification!.domain).toBe('health');
      expect(seenClassification!.sensitivity).toBe('sensitive');
    });

    it('classification fields passed through in the response', async () => {
      const handler = createProcessHandler({
        domainClassifier: stubClassifier({
          domain: 'legal',
          sensitivity: 'elevated',
          confidence: 0.9,
          layer: 'persona',
          reason: 'legal persona override',
        }),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
      });
      const res = (await handler(baseReq)) as Extract<ProcessResult, { status: 200 }>;
      expect(res.body.classification).toEqual({
        domain: 'legal',
        sensitivity: 'elevated',
        confidence: 0.9,
        layer: 'persona',
        reason: 'legal persona override',
      });
    });
  });

  describe('request_id handling', () => {
    it('uses valid header', async () => {
      const id = 'abcdef1234567890abcdef12';
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
      });
      const res = await handler({ ...baseReq, requestIdHeader: id });
      expect(res.body.request_id).toBe(id);
    });

    it('generates fresh id when header is absent', async () => {
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
      });
      const res = await handler(baseReq);
      expect(res.body.request_id).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('input validation', () => {
    it.each([
      ['missing request body', undefined],
      ['empty eventId', { ...baseReq, eventId: '' }],
      ['empty content', { ...baseReq, content: '' }],
      ['whitespace content', { ...baseReq, content: '   ' }],
      ['empty persona', { ...baseReq, persona: '' }],
    ])('400 on %s', async (_label, input) => {
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
      });
      const res = (await handler(
        input as ProcessRequest,
      )) as Extract<ProcessResult, { status: 400 }>;
      expect(res.status).toBe(400);
      expect(res.body.error.kind).toBe('invalid_input');
    });

    it('400 body includes the attempted event_id when present', async () => {
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
      });
      const res = await handler({ ...baseReq, content: '' });
      expect(res.body.event_id).toBe('evt-1');
    });
  });

  describe('failures', () => {
    it('classifier throw → 500 with classify_failed', async () => {
      const failing: Pick<DomainClassifier, 'classify'> = {
        classify: async () => {
          throw new Error('classifier down');
        },
      };
      const handler = createProcessHandler({
        domainClassifier: failing,
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
      });
      const res = (await handler(baseReq)) as Extract<ProcessResult, { status: 500 }>;
      expect(res.status).toBe(500);
      expect(res.body.error.kind).toBe('classify_failed');
    });

    it('prioritiser throw → 500 with prioritise_failed', async () => {
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => {
          throw new Error('pri down');
        },
        notifyFn: async () => 'notified',
      });
      const res = (await handler(baseReq)) as Extract<ProcessResult, { status: 500 }>;
      expect(res.body.error.kind).toBe('prioritise_failed');
    });

    it('notify throw → 500 with notify_failed', async () => {
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'fiduciary' }),
        notifyFn: async () => {
          throw new Error('dispatcher down');
        },
      });
      const res = (await handler(baseReq)) as Extract<ProcessResult, { status: 500 }>;
      expect(res.body.error.kind).toBe('notify_failed');
    });
  });

  describe('events', () => {
    it('happy-path deliver emits classified + delivered', async () => {
      const events: ProcessHandlerEvent[] = [];
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
        onEvent: (e) => events.push(e),
      });
      await handler(baseReq);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['classified', 'delivered']);
    });

    it('skip emits classified + skipped', async () => {
      const events: ProcessHandlerEvent[] = [];
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'skip', reason: 'dup' }),
        notifyFn: async () => 'notified',
        onEvent: (e) => events.push(e),
      });
      await handler(baseReq);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['classified', 'skipped']);
    });

    it('invalid input fires invalid_input (no classified/delivered)', async () => {
      const events: ProcessHandlerEvent[] = [];
      const handler = createProcessHandler({
        domainClassifier: stubClassifier(),
        prioritiseFn: async () => ({ kind: 'deliver', priority: 'solicited' }),
        notifyFn: async () => 'notified',
        onEvent: (e) => events.push(e),
      });
      await handler({ ...baseReq, content: '' });
      expect(events.map((e) => e.kind)).toEqual(['invalid_input']);
    });
  });

  describe('realistic scenario', () => {
    it('invoice email → financial domain → fiduciary priority → notified', async () => {
      const handler = createProcessHandler({
        domainClassifier: stubClassifier({
          domain: 'financial',
          sensitivity: 'elevated',
          layer: 'keyword',
          confidence: 0.9,
        }),
        prioritiseFn: async ({ classification }) => {
          if (classification.domain === 'financial') {
            return { kind: 'deliver', priority: 'fiduciary' };
          }
          return { kind: 'deliver', priority: 'engagement' };
        },
        notifyFn: async () => 'notified',
      });
      const res = (await handler({
        ...baseReq,
        content: 'Invoice overdue — $342.10 for electric bill',
      })) as Extract<ProcessResult, { status: 200 }>;
      expect(res.body.disposition).toBe('notified');
      expect(res.body.priority).toBe('fiduciary');
    });
  });
});
