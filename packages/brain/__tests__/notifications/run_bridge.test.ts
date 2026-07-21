/**
 * Round-A NEW-3 — the run delivery edge honors the §9.1 outputs:
 * a Tier-3 (engagement) informational message and a MUTED run's informational
 * update route to the `briefing` kind (retained, collected by the daily digest,
 * no Activity banner); an ACTION always lands a `run`-kind decision entry
 * ("decisions still accrue in the inbox", §5).
 */

import { notifyRunMessageClassified } from '../../src/notifications/bridges';
import { listNotifications, resetNotifications } from '../../src/notifications/inbox';

import type { MessageRecord, RunRecord } from '@dina/core';

const NOW = 1_700_000_000_000;

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: 'run-1',
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/bus42',
    provider_did: 'did:plc:prov',
    persona: 'general',
    muted: false,
    ...over,
  } as RunRecord;
}

function msg(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    message_id: `m-${Math.random().toString(36).slice(2, 8)}`,
    run_id: 'run-1',
    kind: 'informational',
    final_tier: 2,
    created_at: NOW,
    ...over,
  } as MessageRecord;
}

describe('notifyRunMessageClassified — §9.1 delivery edge (NEW-3)', () => {
  beforeEach(() => resetNotifications());
  afterEach(() => resetNotifications());

  it('a Tier-2 informational lands a run-kind entry', () => {
    notifyRunMessageClassified(msg({ final_tier: 2 }), run());
    expect(listNotifications()[0]?.kind).toBe('run');
  });

  it('a Tier-3 (engagement) informational routes to the briefing kind', () => {
    notifyRunMessageClassified(msg({ final_tier: 3 }), run());
    const items = listNotifications();
    expect(items).toHaveLength(1); // retained — never dropped
    expect(items[0]?.kind).toBe('briefing');
  });

  it('a MUTED run quiets informational updates to briefing (retained, no banner)', () => {
    notifyRunMessageClassified(msg({ final_tier: 2 }), run({ muted: true }));
    const items = listNotifications();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('briefing');
  });

  it('an ACTION always lands a run-kind decision entry — even muted, even tier 3', () => {
    notifyRunMessageClassified(
      msg({ kind: 'action', action_type: 'book', final_tier: 3 }),
      run({ muted: true }),
    );
    expect(listNotifications()[0]?.kind).toBe('run');
  });
});
