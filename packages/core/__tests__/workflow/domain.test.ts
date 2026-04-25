/**
 * CORE-P2-E01 → E09 — WorkflowTask domain types and transitions.
 */

import {
  AllowedOrigins,
  isAllowedOrigin,
  isTerminal,
  isValidTransition,
  ValidTransitions,
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
  type WorkflowEvent,
  type WorkflowTask,
} from '../../src/workflow/domain';

describe('WorkflowTaskState enum values', () => {
  it('includes every state required by the wire protocol', () => {
    const expected: WorkflowTaskState[] = [
      'created',
      'pending',
      'queued',
      'claimed',
      'running',
      'awaiting',
      'pending_approval',
      'scheduled',
      'completed',
      'failed',
      'cancelled',
      'recorded',
    ];
    for (const s of expected) {
      // Compile-time narrowing + runtime equality.
      expect<WorkflowTaskState>(s).toBe(s);
    }
  });

  it('exposes a const namespace mirroring Go WF* constants', () => {
    expect(WorkflowTaskState.Created).toBe('created');
    expect(WorkflowTaskState.Running).toBe('running');
    expect(WorkflowTaskState.PendingApproval).toBe('pending_approval');
    expect(WorkflowTaskState.Recorded).toBe('recorded');
  });
});

describe('WorkflowTaskKind enum values', () => {
  it('covers all 6 kinds', () => {
    expect(WorkflowTaskKind.Delegation).toBe('delegation');
    expect(WorkflowTaskKind.Approval).toBe('approval');
    expect(WorkflowTaskKind.ServiceQuery).toBe('service_query');
    expect(WorkflowTaskKind.Timer).toBe('timer');
    expect(WorkflowTaskKind.Watch).toBe('watch');
    expect(WorkflowTaskKind.Generic).toBe('generic');
  });
});

describe('WorkflowTaskPriority enum values', () => {
  it('covers user_blocking / normal / background', () => {
    expect(WorkflowTaskPriority.UserBlocking).toBe('user_blocking');
    expect(WorkflowTaskPriority.Normal).toBe('normal');
    expect(WorkflowTaskPriority.Background).toBe('background');
  });
});

describe('AllowedOrigins', () => {
  it('contains the empty-string legacy allowance plus the 7 concrete origins', () => {
    expect(AllowedOrigins).toEqual([
      '',
      'telegram',
      'api',
      'd2d',
      'admin',
      'system',
      'cli',
      'dinamobile',
    ]);
  });

  it('is frozen / immutable at runtime', () => {
    expect(Object.isFrozen(AllowedOrigins)).toBe(true);
  });

  it('isAllowedOrigin narrows correctly', () => {
    expect(isAllowedOrigin('')).toBe(true);
    expect(isAllowedOrigin('telegram')).toBe(true);
    expect(isAllowedOrigin('cli')).toBe(true);
    expect(isAllowedOrigin('dinamobile')).toBe(true);
    expect(isAllowedOrigin('webhook')).toBe(false);
    expect(isAllowedOrigin('TELEGRAM')).toBe(false); // case-sensitive
    expect(isAllowedOrigin('mobile')).toBe(false); // bare 'mobile' not allowed
  });

  it('SQL CHECK constraint in storage/schemas.ts mirrors AllowedOrigins', () => {
    // Drift detector: the CREATE TABLE statement carries a CHECK
    // constraint listing the same origins. If they fall out of sync,
    // a brand-new install rejects valid origins (or worse — accepts
    // values the domain layer rejects). Lock them together at the
    // string level so a future origin addition can't slip past.
    //
    // We don't import the schema string (it's in storage/schemas.ts);
    // we use the file's text via fs to keep this test cheap.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const schemasPath = path.join(__dirname, '../../src/storage/schemas.ts');
    const schemasSrc = fs.readFileSync(schemasPath, 'utf8');
    const checkLine = schemasSrc
      .split('\n')
      .find((l: string) => l.includes('origin TEXT CHECK'));
    expect(checkLine).toBeDefined();
    for (const origin of AllowedOrigins) {
      expect(checkLine!).toContain(`'${origin}'`);
    }
  });
});

describe('ValidTransitions', () => {
  it('created can reach every live state but not directly to recorded', () => {
    expect(ValidTransitions.created).toEqual(
      expect.arrayContaining([
        'pending',
        'queued',
        'pending_approval',
        'running',
        'completed',
        'failed',
        'cancelled',
      ]),
    );
    expect(ValidTransitions.created).not.toContain('recorded');
  });

  it('running has the full termination escape hatch plus lease-expiry requeue', () => {
    // `queued` is a sweeper-only transition — the lease-expiry path reverts
    // a stuck running task (agent died mid-execution) back to queued so
    // another agent can re-claim it. Normal completion paths use the
    // completed/failed/cancelled terminals.
    expect(ValidTransitions.running).toEqual([
      'awaiting',
      'completed',
      'failed',
      'cancelled',
      'queued',
    ]);
  });

  it('completed → recorded only (archive path)', () => {
    expect(ValidTransitions.completed).toEqual(['recorded']);
  });

  it('cancelled has no outgoing transitions', () => {
    expect(ValidTransitions.cancelled).toEqual([]);
  });

  it('recorded has no outgoing transitions', () => {
    expect(ValidTransitions.recorded).toEqual([]);
  });

  it('failed retains recovery escapes (scheduled, queued, recorded, cancelled)', () => {
    expect(ValidTransitions.failed).toEqual(
      expect.arrayContaining(['scheduled', 'queued', 'recorded', 'cancelled']),
    );
  });

  it('is frozen at the top level', () => {
    expect(Object.isFrozen(ValidTransitions)).toBe(true);
  });
});

describe('isValidTransition', () => {
  it('allows created → running', () => {
    expect(isValidTransition('created', 'running')).toBe(true);
  });

  it('allows running → completed', () => {
    expect(isValidTransition('running', 'completed')).toBe(true);
  });

  it('rejects running → created (no backward transition)', () => {
    expect(isValidTransition('running', 'created')).toBe(false);
  });

  it('rejects completed → running (can only archive)', () => {
    expect(isValidTransition('completed', 'running')).toBe(false);
  });

  it('rejects transitions out of cancelled / recorded terminals', () => {
    expect(isValidTransition('cancelled', 'running')).toBe(false);
    expect(isValidTransition('recorded', 'running')).toBe(false);
  });

  it('unknown from-state always fails', () => {
    expect(isValidTransition('garbage' as unknown as WorkflowTaskState, 'running')).toBe(false);
  });

  it('every (from, to) pair in ValidTransitions is considered valid', () => {
    for (const [from, tos] of Object.entries(ValidTransitions)) {
      for (const to of tos) {
        expect(isValidTransition(from as WorkflowTaskState, to)).toBe(true);
      }
    }
  });
});

describe('isTerminal', () => {
  it('returns true for the four terminal states', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('recorded')).toBe(true);
  });

  it('returns false for all live states', () => {
    const live: WorkflowTaskState[] = [
      'created',
      'pending',
      'queued',
      'claimed',
      'running',
      'awaiting',
      'pending_approval',
      'scheduled',
    ];
    for (const s of live) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('WorkflowTask shape smoke check', () => {
  it('accepts a minimal valid shape', () => {
    const t: WorkflowTask = {
      id: 'task-1',
      kind: WorkflowTaskKind.ServiceQuery,
      status: WorkflowTaskState.Created,
      priority: WorkflowTaskPriority.Normal,
      description: 'service query for eta_query',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 0,
      updated_at: 0,
    };
    expect(t.id).toBe('task-1');
  });

  it('payload + policy are JSON strings, not parsed objects (wire parity)', () => {
    const t: WorkflowTask = {
      id: 'task-1',
      kind: WorkflowTaskKind.ServiceQuery,
      status: WorkflowTaskState.Created,
      priority: WorkflowTaskPriority.Normal,
      description: '',
      payload: '{"to_did":"did:plc:x","capability":"eta_query"}',
      result_summary: '',
      policy: '{}',
      created_at: 0,
      updated_at: 0,
    };
    const parsed = JSON.parse(t.payload);
    expect(parsed.capability).toBe('eta_query');
  });
});

describe('WorkflowEvent shape smoke check', () => {
  it('accepts a minimal valid shape with delivery fields', () => {
    const e: WorkflowEvent = {
      event_id: 1,
      task_id: 'task-1',
      at: 0,
      event_kind: 'created',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    };
    expect(e.event_id).toBe(1);
  });
});
