/**
 * T7.3 — Two-pass email triage: deterministic filters + LLM batch classify.
 *
 * Source: ARCHITECTURE.md Task 7.3
 */

import {
  triagePass1,
  triagePass2,
  triageBatch,
  type EmailItem,
  type LLMTriageClassifier,
} from '../../src/sync/triage';

function email(overrides: Partial<EmailItem> & { id: string }): EmailItem {
  return {
    from: 'test@example.com',
    subject: 'Test email',
    body: 'Hello world',
    ...overrides,
  };
}

describe('Two-Pass Email Triage', () => {
  describe('Pass 1 — deterministic', () => {
    describe('Gmail category filter', () => {
      it('skips promotions', () => {
        const r = triagePass1(email({ id: '1', category: 'promotions', subject: 'Sale 50% off' }));
        expect(r.decision).toBe('skip');
        expect(r.reason).toContain('promotions');
        expect(r.pass).toBe(1);
      });

      it('skips social', () => {
        const r = triagePass1(
          email({ id: '2', category: 'social', subject: 'Alice liked your post' }),
        );
        expect(r.decision).toBe('skip');
      });

      it('skips forums', () => {
        const r = triagePass1(email({ id: '3', category: 'forums' }));
        expect(r.decision).toBe('skip');
      });

      it('does not skip primary', () => {
        const r = triagePass1(email({ id: '4', category: 'primary', subject: 'Meeting at 3pm' }));
        expect(r.decision).toBe('ingest');
      });

      it('does not skip updates', () => {
        const r = triagePass1(
          email({ id: '5', category: 'updates', subject: 'Your package shipped' }),
        );
        expect(r.decision).toBe('ingest');
      });
    });

    describe('bot sender detection', () => {
      it('skips noreply@', () => {
        const r = triagePass1(email({ id: '6', from: 'noreply@company.com' }));
        expect(r.decision).toBe('skip');
        expect(r.reason).toContain('Bot sender');
      });

      it('skips no-reply@', () => {
        const r = triagePass1(email({ id: '7', from: 'no-reply@service.io' }));
        expect(r.decision).toBe('skip');
      });

      it('skips notifications@', () => {
        const r = triagePass1(email({ id: '8', from: 'notifications@github.com' }));
        expect(r.decision).toBe('skip');
      });

      it('skips "Name <noreply@...>" format', () => {
        const r = triagePass1(email({ id: '9', from: 'Company <noreply@company.com>' }));
        expect(r.decision).toBe('skip');
      });

      it('does not skip real people', () => {
        const r = triagePass1(email({ id: '10', from: 'alice@example.com' }));
        expect(r.decision).toBe('ingest');
      });
    });

    describe('unsubscribe heuristic', () => {
      it('skips emails with unsubscribe link', () => {
        const r = triagePass1(
          email({
            id: '11',
            from: 'newsletter@brand.com',
            body: 'Great deals! Click here to unsubscribe: https://brand.com/unsub',
          }),
        );
        expect(r.decision).toBe('skip');
        expect(r.reason).toContain('Unsubscribe');
      });

      it('does not skip "unsubscribe" without link', () => {
        const r = triagePass1(
          email({
            id: '12',
            from: 'alice@example.com',
            body: 'I tried to unsubscribe from that list',
          }),
        );
        // 'unsubscribe' text without a URL → not marketing
        expect(r.decision).toBe('ingest');
      });
    });

    describe('fiduciary override', () => {
      it('always ingests security alerts regardless of category', () => {
        const r = triagePass1(
          email({
            id: '13',
            category: 'promotions',
            subject: 'Security alert: unusual login detected',
          }),
        );
        expect(r.decision).toBe('ingest');
        expect(r.reason).toContain('Fiduciary');
        expect(r.confidence).toBeGreaterThan(0.95);
      });

      it('always ingests lab results from noreply', () => {
        const r = triagePass1(
          email({
            id: '14',
            from: 'noreply@hospital.org',
            subject: 'Your lab result is ready',
          }),
        );
        expect(r.decision).toBe('ingest');
      });

      it('always ingests payment due from bot sender', () => {
        const r = triagePass1(
          email({
            id: '15',
            from: 'notifications@bank.com',
            subject: 'Payment due tomorrow',
          }),
        );
        expect(r.decision).toBe('ingest');
      });

      it('always ingests fraud alerts', () => {
        const r = triagePass1(
          email({
            id: '16',
            category: 'social',
            body: 'Fraud alert on your credit card',
          }),
        );
        expect(r.decision).toBe('ingest');
      });
    });

    describe('undecided items', () => {
      it('returns ingest with low confidence for ambiguous items', () => {
        const r = triagePass1(
          email({
            id: '17',
            from: 'alice@work.com',
            subject: 'Quick question about the project',
          }),
        );
        expect(r.decision).toBe('ingest');
        expect(r.confidence).toBe(0.5);
      });
    });
  });

  describe('Pass 2 — LLM classify', () => {
    it('defaults to ingest when no classifier provided', async () => {
      const items = [email({ id: '1' }), email({ id: '2' })];
      const results = await triagePass2(items);

      expect(results.size).toBe(2);
      expect(results.get('1')!.decision).toBe('ingest');
      expect(results.get('1')!.reason).toContain('No LLM');
    });

    it('uses LLM classifier results', async () => {
      const classifier: LLMTriageClassifier = async () => [
        { id: '1', decision: 'skip', confidence: 0.9 },
        { id: '2', decision: 'ingest', confidence: 0.85 },
      ];

      const items = [email({ id: '1' }), email({ id: '2' })];
      const results = await triagePass2(items, classifier);

      expect(results.get('1')!.decision).toBe('skip');
      expect(results.get('2')!.decision).toBe('ingest');
    });

    it('rejects low-confidence skip decisions', async () => {
      const classifier: LLMTriageClassifier = async () => [
        { id: '1', decision: 'skip', confidence: 0.5 },
      ];

      const results = await triagePass2([email({ id: '1' })], classifier, 0.7);
      expect(results.get('1')!.decision).toBe('ingest');
      expect(results.get('1')!.reason).toContain('below threshold');
    });

    it('defaults unclassified items to ingest', async () => {
      const classifier: LLMTriageClassifier = async () => [
        { id: '1', decision: 'skip', confidence: 0.9 },
        // id '2' not returned by LLM
      ];

      const items = [email({ id: '1' }), email({ id: '2' })];
      const results = await triagePass2(items, classifier);

      expect(results.get('2')!.decision).toBe('ingest');
      expect(results.get('2')!.reason).toContain('did not classify');
    });
  });

  describe('triageBatch — full pipeline', () => {
    it('combines Pass 1 and Pass 2', async () => {
      const items = [
        email({ id: '1', category: 'promotions', subject: 'Sale' }), // P1 skip
        email({ id: '2', from: 'noreply@bot.com' }), // P1 skip
        email({ id: '3', from: 'alice@work.com', subject: 'Meeting' }), // P1 undecided → P2
        email({ id: '4', subject: 'Security alert: breach' }), // P1 fiduciary ingest
      ];

      const classifier: LLMTriageClassifier = async (batch) => {
        return batch.map((item) => ({
          id: item.id,
          decision: 'skip' as const,
          confidence: 0.85,
        }));
      };

      const results = await triageBatch(items, classifier);

      expect(results.get('1')!.decision).toBe('skip'); // category
      expect(results.get('1')!.pass).toBe(1);
      expect(results.get('2')!.decision).toBe('skip'); // bot sender
      expect(results.get('2')!.pass).toBe(1);
      expect(results.get('3')!.decision).toBe('skip'); // LLM
      expect(results.get('3')!.pass).toBe(2);
      expect(results.get('4')!.decision).toBe('ingest'); // fiduciary override
      expect(results.get('4')!.pass).toBe(1);
    });

    it('ingests everything when no LLM available', async () => {
      const items = [
        email({ id: '1', from: 'alice@work.com', subject: 'Hey' }),
        email({ id: '2', from: 'bob@work.com', subject: 'Question' }),
      ];

      const results = await triageBatch(items);

      expect(results.get('1')!.decision).toBe('ingest');
      expect(results.get('2')!.decision).toBe('ingest');
    });

    it('achieves ~70% reduction on typical inbox', async () => {
      // Simulate a typical inbox: 30% promotions, 20% social, 15% bot, 35% primary
      const items: EmailItem[] = [];
      for (let i = 0; i < 30; i++) items.push(email({ id: `promo-${i}`, category: 'promotions' }));
      for (let i = 0; i < 20; i++) items.push(email({ id: `social-${i}`, category: 'social' }));
      for (let i = 0; i < 15; i++)
        items.push(email({ id: `bot-${i}`, from: 'noreply@service.com' }));
      for (let i = 0; i < 35; i++)
        items.push(email({ id: `primary-${i}`, from: 'alice@work.com', category: 'primary' }));

      const results = await triageBatch(items);

      const skipped = [...results.values()].filter((r) => r.decision === 'skip').length;
      const skipRate = skipped / items.length;
      expect(skipRate).toBeGreaterThanOrEqual(0.6); // At least 60% reduction
    });
  });
});
