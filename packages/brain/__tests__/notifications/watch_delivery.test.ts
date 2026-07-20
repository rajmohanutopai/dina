/**
 * R2-05 — the shared watch-result delivery pipeline: filter (R2-04) → silence
 * classifier (ceiling-capped) → DND/quiet-hours → inbox / briefing. Deterministic
 * over the process-global silence/DND/inbox state (reset per test).
 */

import { type CardSpec } from '@dina/protocol';

import {
  InMemoryNotificationLogRepository,
  setNotificationLogRepository,
} from '@dina/core';

import { resetUserOverrides } from '../../src/guardian/silence';
import { resetDND, setDND } from '../../src/notifications/dnd';
import { resetNotifications, listNotifications } from '../../src/notifications/inbox';
import { deliverWatchResult } from '../../src/notifications/watch_delivery';

// NOON is outside the default quiet-hours window (22:00–07:00).
const NOON = new Date(2026, 0, 1, 12, 0, 0);

function card(title: string, body: string): CardSpec {
  return {
    version: 1,
    blocks: [
      { kind: 'title', text: title },
      { kind: 'body', text: body },
    ],
  } as unknown as CardSpec;
}

const base = {
  subscriptionId: 'sub-1',
  capability: 'flight_status',
  serviceName: 'Flights',
  status: 'resolved',
  sourceId: 'task-1',
  text: 'BA117 is delayed 40m',
};

beforeEach(() => {
  setNotificationLogRepository(null);
  resetNotifications();
  resetDND();
  resetUserOverrides();
});

describe('deliverWatchResult (R2-05)', () => {
  it('skips a non-resolved poll (no inbox entry)', async () => {
    expect(await deliverWatchResult({ ...base, status: 'failed', card: null }, NOON)).toBe('skipped');
    expect(listNotifications()).toHaveLength(0);
  });

  it('a matched filtered watch delivers a bounded `push` from the validated card', async () => {
    const out = await deliverWatchResult(
      { ...base, card: card('Flight delayed', 'BA117 +40m'), filter: { contains: 'delayed' } },
      NOON,
    );
    expect(out).toBe('delivered');
    const items = listNotifications();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('push');
    expect(items[0].title).toBe('Flight delayed'); // bounded card title, not raw text
  });

  it('suppresses a non-matching filtered watch (cry-wolf guard, R2-04)', async () => {
    const out = await deliverWatchResult(
      {
        ...base,
        text: 'BA117 on time',
        card: card('On time', 'BA117 on time'),
        filter: { contains: 'delayed' },
      },
      NOON,
    );
    expect(out).toBe('suppressed_filter');
    expect(listNotifications()).toHaveLength(0);
  });

  it('DEFERS the banner in quiet hours but RETAINS the inbox record (R3-05)', async () => {
    // All-day quiet hours → any `now` is inside the window (deterministic, clock-free).
    setDND({ quietHoursStart: '00:00', quietHoursEnd: '23:59' });
    const out = await deliverWatchResult(
      { ...base, card: card('Flight delayed', 'BA117 +40m'), filter: { contains: 'delayed' } },
      NOON,
    );
    // R3-05 — DND governs the BANNER only; the durable record is never dropped.
    expect(out).toBe('deferred_dnd');
    const items = listNotifications();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('push');
  });

  it('routes a Tier-3 (ceiling 3) watch to a RETAINED briefing item (R3-05)', async () => {
    const out = await deliverWatchResult({ ...base, card: card('FYI', 'nothing urgent'), ceilingTier: 3 }, NOON);
    expect(out).toBe('briefing');
    // R3-05 — a Tier-3 result is retained as a `briefing` item for the daily digest.
    const items = listNotifications();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('briefing');
  });

  it('fails CLOSED for a cancelled/unknown (inactive) watch (R3-02)', async () => {
    const out = await deliverWatchResult(
      {
        ...base,
        card: card('Flight delayed', 'BA117 +40m'),
        filter: { contains: 'delayed' },
        watchActive: false,
      },
      NOON,
    );
    expect(out).toBe('suppressed_inactive');
    expect(listNotifications()).toHaveLength(0);
  });

  it('renders display ONLY from the card — a null card uses fixed non-provider copy (R3-04)', async () => {
    const out = await deliverWatchResult(
      { ...base, text: 'raw provider text MUST NOT appear', card: null },
      NOON,
    );
    // Resolved + active + (unfiltered, so it matches) → always retained (R3-05).
    expect(out === 'delivered' || out === 'briefing').toBe(true);
    const items = listNotifications();
    expect(items).toHaveLength(1);
    // R3-04 — display is derived from the CardSpec only; a null card yields fixed
    // non-provider copy, never the raw provider `text`.
    expect(items[0].title).toBe('Subscription update');
    expect(items[0].body).toBe('A watch you set has an update.');
    expect(items[0].body).not.toContain('raw provider');
  });

  it('is idempotent on sourceId (a re-delivered event does not double-notify)', async () => {
    const input = { ...base, card: card('Flight delayed', 'BA117 +40m'), filter: { contains: 'delayed' } };
    expect(await deliverWatchResult(input, NOON)).toBe('delivered');
    await deliverWatchResult(input, NOON);
    expect(listNotifications()).toHaveLength(1);
  });

  it('R5-04: REJECTS when the durable append fails (caller can refuse to ack), retry converges', async () => {
    class FailOnceRepo extends InMemoryNotificationLogRepository {
      failures = 1;
      override async append(item: Parameters<InMemoryNotificationLogRepository['append']>[0]) {
        if (this.failures > 0) {
          this.failures -= 1;
          throw new Error('durable write failed');
        }
        return super.append(item);
      }
    }
    const repo = new FailOnceRepo();
    setNotificationLogRepository(repo);
    const input = { ...base, card: card('Flight delayed', 'BA117 +40m'), filter: { contains: 'delayed' } };

    // First delivery: the durable write fails → the delivery REJECTS, so a
    // caller (split-server route / workflow consumer) will not ack the event.
    await expect(deliverWatchResult(input, NOON)).rejects.toThrow('durable write failed');
    expect(await repo.listAll()).toHaveLength(0); // nothing durable yet

    // Core redelivers: the idempotent sourceId append upserts (no duplicate)
    // and the durable row lands.
    expect(await deliverWatchResult(input, NOON)).toBe('delivered');
    expect(listNotifications()).toHaveLength(1);
    expect(await repo.listAll()).toHaveLength(1);
  });
});
