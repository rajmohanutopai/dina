/**
 * Task 5.41 — ReminderPlanner tests.
 */

import {
  DEFAULT_MAX_REMINDERS,
  ReminderPlanner,
  type LlmPlanCallFn,
  type PlanResult,
  type ReminderPlannerEvent,
  type VaultContextGatherFn,
} from '../src/brain/reminder_planner';

/** Fixed "now" — 2026-04-22T00:00:00Z. */
const NOW_MS = Date.UTC(2026, 3, 22);

function stubLlm(payload: unknown): LlmPlanCallFn {
  return async () => ({
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

function iso(nowMs: number, offsetMs: number): string {
  return new Date(nowMs + offsetMs).toISOString();
}

describe('ReminderPlanner (task 5.41)', () => {
  describe('construction validation', () => {
    it('rejects missing planCallFn', () => {
      expect(
        () => new ReminderPlanner({ planCallFn: undefined as unknown as LlmPlanCallFn }),
      ).toThrow(/planCallFn is required/);
    });

    it('rejects non-positive maxReminders', () => {
      expect(
        () => new ReminderPlanner({ planCallFn: async () => ({ content: '{}' }), maxReminders: 0 }),
      ).toThrow(/maxReminders must be > 0/);
    });
  });

  describe('happy path', () => {
    it('plans a single reminder from content + LLM output', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [
            { fire_at: iso(NOW_MS, 60 * 60 * 1000), message: 'Call Emma', kind: 'call' },
          ],
          summary: '1 reminder set for today.',
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'Call Emma about her appointment',
        eventHint: 'appointment',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.ok).toBe(true);
      expect(res.reminders).toHaveLength(1);
      expect(res.reminders[0]!.message).toBe('Call Emma');
      expect(res.reminders[0]!.kind).toBe('call');
      expect(res.reminders[0]!.fireAtMs).toBe(NOW_MS + 60 * 60 * 1000);
      expect(res.summary).toBe('1 reminder set for today.');
    });

    it('fills a default summary when LLM omits one', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [
            { fire_at: iso(NOW_MS, 60_000), message: 'one' },
            { fire_at: iso(NOW_MS, 120_000), message: 'two' },
          ],
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.summary).toBe('2 reminders set.');
    });

    it('kind defaults to "reminder" when LLM omits it', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [{ fire_at: iso(NOW_MS, 60_000), message: 'x' }],
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.reminders[0]!.kind).toBe('reminder');
    });

    it('sorts reminders by earliest fire time', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [
            { fire_at: iso(NOW_MS, 3 * 60_000), message: 'c' },
            { fire_at: iso(NOW_MS, 1 * 60_000), message: 'a' },
            { fire_at: iso(NOW_MS, 2 * 60_000), message: 'b' },
          ],
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.reminders.map((r) => r.message)).toEqual(['a', 'b', 'c']);
    });

    it('accepts ISO with ±HH:MM timezone suffix (not just Z)', async () => {
      const future = new Date(NOW_MS + 60 * 60_000).toISOString().replace('Z', '+00:00');
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [{ fire_at: future, message: 'x' }],
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.reminders).toHaveLength(1);
    });

    it('strips ```json fences from LLM output', async () => {
      const planner = new ReminderPlanner({
        planCallFn: async () => ({
          content:
            '```json\n' +
            JSON.stringify({
              reminders: [{ fire_at: iso(NOW_MS, 60_000), message: 'x' }],
            }) +
            '\n```',
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.ok).toBe(true);
      expect(res.reminders).toHaveLength(1);
    });
  });

  describe('filtering + validation', () => {
    it('drops past reminders silently (no error) + counts via event', async () => {
      const events: ReminderPlannerEvent[] = [];
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [
            { fire_at: iso(NOW_MS, -60_000), message: 'past' },
            { fire_at: iso(NOW_MS, 60_000), message: 'future' },
            { fire_at: iso(NOW_MS, 0), message: 'now-exact' }, // boundary: <= now → dropped
          ],
        }),
        nowMsFn: () => NOW_MS,
        onEvent: (e) => events.push(e),
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.ok).toBe(true);
      expect(res.reminders.map((r) => r.message)).toEqual(['future']);
      const done = events.find((e) => e.kind === 'plan_succeeded') as Extract<
        ReminderPlannerEvent,
        { kind: 'plan_succeeded' }
      >;
      expect(done.droppedPast).toBe(2);
    });

    it('drops tz-less fire_at strings', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [
            { fire_at: '2026-04-22T15:30:00', message: 'naive' }, // no tz
            { fire_at: iso(NOW_MS, 60_000), message: 'good' },
          ],
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.reminders.map((r) => r.message)).toEqual(['good']);
    });

    it('drops entries with empty message or bad shape', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [
            { fire_at: iso(NOW_MS, 60_000), message: '' },
            { fire_at: iso(NOW_MS, 60_000) }, // missing message
            null,
            'not-an-object',
            { fire_at: iso(NOW_MS, 60_000), message: 'ok' },
          ],
        }),
        nowMsFn: () => NOW_MS,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.reminders).toHaveLength(1);
      expect(res.reminders[0]!.message).toBe('ok');
    });

    it('caps at maxReminders (drops latest firings)', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [
            { fire_at: iso(NOW_MS, 1 * 60_000), message: 'keep-1' },
            { fire_at: iso(NOW_MS, 2 * 60_000), message: 'keep-2' },
            { fire_at: iso(NOW_MS, 3 * 60_000), message: 'keep-3' },
            { fire_at: iso(NOW_MS, 4 * 60_000), message: 'drop-1' },
            { fire_at: iso(NOW_MS, 5 * 60_000), message: 'drop-2' },
          ],
        }),
        nowMsFn: () => NOW_MS,
        maxReminders: 3,
      });
      const res = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(res.reminders.map((r) => r.message)).toEqual(['keep-1', 'keep-2', 'keep-3']);
    });

    it('DEFAULT_MAX_REMINDERS is 5', () => {
      expect(DEFAULT_MAX_REMINDERS).toBe(5);
    });
  });

  describe('rejections', () => {
    it('empty content → invalid_input', async () => {
      const planner = new ReminderPlanner({ planCallFn: stubLlm({ reminders: [] }) });
      const r = (await planner.plan({ content: '', eventHint: 'x' })) as Extract<
        PlanResult,
        { ok: false }
      >;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('invalid_input');
    });

    it('LLM throws → llm_failed (error message preserved)', async () => {
      const planner = new ReminderPlanner({
        planCallFn: async () => {
          throw new Error('rate limited');
        },
        nowMsFn: () => NOW_MS,
      });
      const r = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: false; reason: 'llm_failed' }>;
      expect(r.ok).toBe(false);
      if (r.ok === false && r.reason === 'llm_failed') {
        expect(r.error).toMatch(/rate limited/);
      }
    });

    it('LLM returns non-JSON → parse_failed', async () => {
      const planner = new ReminderPlanner({
        planCallFn: async () => ({ content: 'hello not-json' }),
        nowMsFn: () => NOW_MS,
      });
      const r = await planner.plan({ content: 'x', eventHint: '' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('parse_failed');
    });

    it('LLM returns a bare JSON array → parse_failed (not the expected object shape)', async () => {
      const planner = new ReminderPlanner({
        planCallFn: async () => ({ content: '[1, 2, 3]' }),
        nowMsFn: () => NOW_MS,
      });
      const r = await planner.plan({ content: 'x', eventHint: '' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('parse_failed');
    });

    it('LLM returns a JSON primitive → parse_failed', async () => {
      const planner = new ReminderPlanner({
        planCallFn: async () => ({ content: '42' }),
        nowMsFn: () => NOW_MS,
      });
      const r = await planner.plan({ content: 'x', eventHint: '' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('parse_failed');
    });

    it('zero valid reminders still returns ok=true with empty list', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({ reminders: [] }),
        nowMsFn: () => NOW_MS,
      });
      const r = (await planner.plan({ content: 'x', eventHint: '' })) as Extract<
        PlanResult,
        { ok: true }
      >;
      expect(r.ok).toBe(true);
      expect(r.reminders).toEqual([]);
      expect(r.summary).toBe('No reminders set.');
    });
  });

  describe('vault context integration', () => {
    it('calls gatherer with extracted terms + surfaces count via event', async () => {
      const calls: string[][] = [];
      const gather: VaultContextGatherFn = async (terms) => {
        calls.push(terms);
        return ['Emma is a close friend', 'pet clinic: Dr. Rosen'];
      };
      const events: ReminderPlannerEvent[] = [];
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [{ fire_at: iso(NOW_MS, 60_000), message: 'x' }],
        }),
        gatherVaultContextFn: gather,
        nowMsFn: () => NOW_MS,
        onEvent: (e) => events.push(e),
      });
      await planner.plan({
        content: 'Emma has an appointment at the clinic',
        eventHint: 'appointment',
      });
      expect(calls.length).toBe(1);
      // Proper nouns come first (Emma).
      expect(calls[0]![0]).toBe('Emma');
      const fetched = events.find((e) => e.kind === 'vault_context_fetched') as Extract<
        ReminderPlannerEvent,
        { kind: 'vault_context_fetched' }
      >;
      expect(fetched.itemCount).toBe(2);
    });

    it('clamps snippet length + count', async () => {
      const longSnippet = 'x'.repeat(500);
      const events: ReminderPlannerEvent[] = [];
      const promptCapture: string[] = [];
      const planner = new ReminderPlanner({
        planCallFn: async (prompt) => {
          promptCapture.push(prompt);
          return {
            content: JSON.stringify({ reminders: [] }),
          };
        },
        gatherVaultContextFn: async () => [longSnippet, longSnippet, longSnippet, longSnippet, longSnippet, longSnippet, longSnippet],
        maxVaultSnippets: 3,
        nowMsFn: () => NOW_MS,
        onEvent: (e) => events.push(e),
      });
      await planner.plan({ content: 'Emma is here', eventHint: '' });
      const fetched = events.find((e) => e.kind === 'vault_context_fetched') as Extract<
        ReminderPlannerEvent,
        { kind: 'vault_context_fetched' }
      >;
      expect(fetched.itemCount).toBe(3);
      // Prompt must not carry the full 500-char snippet — capped at 150.
      const occurrences = (promptCapture[0]!.match(new RegExp('x'.repeat(151), 'g')) ?? []).length;
      expect(occurrences).toBe(0);
    });

    it('gatherer that throws does NOT fail the plan', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [{ fire_at: iso(NOW_MS, 60_000), message: 'x' }],
        }),
        gatherVaultContextFn: async () => {
          throw new Error('vault offline');
        },
        nowMsFn: () => NOW_MS,
      });
      const r = (await planner.plan({
        content: 'x',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(r.ok).toBe(true);
      expect(r.reminders).toHaveLength(1);
    });

    it('no gatherer configured → planner still works', async () => {
      const planner = new ReminderPlanner({
        planCallFn: stubLlm({
          reminders: [{ fire_at: iso(NOW_MS, 60_000), message: 'x' }],
        }),
        nowMsFn: () => NOW_MS,
      });
      const r = (await planner.plan({
        content: 'Emma is here',
        eventHint: '',
      })) as Extract<PlanResult, { ok: true }>;
      expect(r.ok).toBe(true);
    });
  });

  describe('extractSearchTerms', () => {
    const planner = new ReminderPlanner({
      planCallFn: async () => ({ content: '{}' }),
    });

    it('strips stop words + short tokens', () => {
      const out = planner.extractSearchTerms(
        'the a is an Emma appointment',
        '',
      );
      expect(out).toEqual(['Emma', 'appointment']);
    });

    it('strips possessives (ASCII + Unicode)', () => {
      const out = planner.extractSearchTerms(
        "Emma's and Jane’s records",
        '',
      );
      expect(out).toContain('Emma');
      expect(out).toContain('Jane');
    });

    it('prioritises proper nouns before lowercase', () => {
      const out = planner.extractSearchTerms(
        'doctor Rosen and Emma checkup',
        '',
      );
      // Uppercase tokens Rosen + Emma come first.
      expect(out.slice(0, 2).sort()).toEqual(['Emma', 'Rosen']);
    });

    it('de-duplicates + caps at maxSearchTerms', () => {
      const p = new ReminderPlanner({
        planCallFn: async () => ({ content: '{}' }),
        maxSearchTerms: 2,
      });
      const out = p.extractSearchTerms('Emma Emma Bob Bob Carol', '');
      expect(out.length).toBe(2);
    });
  });
});
