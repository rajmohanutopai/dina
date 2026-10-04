/**
 * A2A Lane 1 delivery to the asking conversation (design A2A-I7, §6.5):
 * Dina's own sentence for each outcome, from Core's one A2A event per
 * ending; the released result quoted only after the guard; and nothing for
 * the workflow's own events on A2A tasks.
 */

import {
  a2aDeliveryText,
  a2aOperationIdOf,
  renderReleasedResult,
} from '../../src/a2a/delivery_text';
import {
  WorkflowEventConsumer,
  type WorkflowEventConsumerCoreClient,
} from '../../src/service/workflow_event_consumer';

import type { A2AOperationStatus, WorkflowEvent, WorkflowTask } from '@dina/core';

const op = (over: Partial<A2AOperationStatus> = {}): A2AOperationStatus => ({
  operation_id: 'op-1',
  state: 'completed',
  reason: null,
  agent_name: 'Summarizer',
  skill: 'summarize',
  reply_to: 'main',
  result: { version: 1, parts: [{ text: 'The summary.' }, { data: { n: 1 } }] },
  updated_at: 1,
  ...over,
});

describe('the sentences', () => {
  it('quotes a released result, text and data', () => {
    expect(a2aDeliveryText('a2a_result_released', op())).toBe(
      'Summarizer answered:\n\nThe summary.\n\n{\n  "n": 1\n}',
    );
    expect(renderReleasedResult({ total: 3 })).toBe('{\n  "total": 3\n}');
  });

  it('says nothing for a released event whose result is not there', () => {
    expect(a2aDeliveryText('a2a_result_released', op({ result: null }))).toBeNull();
    expect(a2aDeliveryText('a2a_result_released', null)).toBeNull();
  });

  it.each(['completed', 'failed', 'cancelled', 'outcome_unknown', 'approved'])(
    'says nothing for the workflow’s own %s event: only Core’s A2A events speak',
    (kind) => {
      expect(a2aDeliveryText(kind, op({ state: 'failed', reason: 'remote_failed' }))).toBeNull();
    },
  );

  it.each([
    ['failed', 'remote_needs_input', /needs more information/],
    ['failed', 'remote_needs_auth', /asked to sign in/],
    ['failed', 'remote_failed', /could not do it/],
    ['failed', 'remote_rejected', /turned the request down/],
    ['failed', 'remote_error', /turned the request down/],
    ['failed', 'remote_unreachable:connect_failed', /could not reach Summarizer\. Nothing was sent/],
    ['failed', 'credential_unusable', /could not use the credential you set up for Summarizer, so nothing was sent/],
    // Cold audit C4-2: an outage at the sign-in service is no fault of the credential.
    ['failed', 'token_unavailable', /could not reach the sign-in service for Summarizer, so nothing was sent\. Try again later/],
    ['failed', 'result_refused:result_schema_mismatch', /could not accept/],
    ['failed', 'approval_missing', /did not finish/],
    ['stale_authority', 'binding_changed', /was not sent: something changed after you approved it/],
    ['stale_authority', 'agent_changed', /was not sent/],
    ['expired', 'permit_expired', /expired before it was sent/],
    ['expired', 'dispatch_expired', /expired before it was sent/],
    ['expired', 'expired', /expired before it was sent/],
    ['refused', 'refused', /You declined the request to Summarizer\. Nothing was sent/],
    ['cancelled', 'cancelled_by_remote', /^Summarizer cancelled the request\.$/],
    ['cancelled', 'cancelled_by_owner', /^The request to Summarizer was cancelled\.$/],
    ['outcome_unknown', 'remote_error_after_send', /cannot tell whether it was done/],
    ['outcome_unknown', 'dispatch_ended_unreported', /cannot tell whether it was done/],
    // A write, booking or agentic call the remote reported done, whose answer Dina refused.
    ['outcome_unknown', 'result_refused:result_schema_mismatch', /reported the request done, .*could not accept.* may have been carried out\. Check with the agent before asking again/],
  ])('an ending in %s (%s) in Dina’s words', (state, reason, sentence) => {
    expect(a2aDeliveryText('a2a_operation_ended', op({ state, reason, result: null }))).toMatch(sentence);
  });

  it('says nothing for an ending event whose operation has not ended', () => {
    expect(a2aDeliveryText('a2a_operation_ended', op({ state: 'running', reason: null, result: null }))).toBeNull();
    expect(a2aDeliveryText('a2a_operation_ended', null)).toBeNull();
  });

  it.each([
    ['guard_blocked:instruction_pattern', /trying to give Dina instructions/],
    ['guard_blocked:model_block', /trying to give Dina instructions/],
    ['guard_blocked:guard_unparseable', /did not give a clear answer/],
    ['quarantine_unreadable', /could not be read back/],
  ])('says why an answer was held back (%s), and never that it can be read later', (reason, sentence) => {
    const text = a2aDeliveryText('a2a_result_blocked', op({ state: 'blocked', reason, result: null }));
    expect(text).toMatch(sentence);
    expect(text).toMatch(/will not be shown/);
    expect(text).not.toMatch(/console/);
  });

  it('describes a held answer without claiming nothing looked at it', () => {
    expect(a2aDeliveryText('a2a_result_held', op())).toMatch(/has not been able to check this one yet/);
  });

  it('clips a long result for the bubble', () => {
    const long = renderReleasedResult({ version: 1, parts: [{ text: 'x'.repeat(10_000) }] });
    expect(long.length).toBe(4000);
    expect(long.endsWith('…')).toBe(true);
  });

  it('recognizes A2A tasks by their Core-minted payloads only', () => {
    expect(a2aOperationIdOf('{"type":"a2a_dispatch","operation_id":"op-1"}')).toBe('op-1');
    expect(a2aOperationIdOf('{"type":"a2a_delegation_consent","operation_id":"op-2"}')).toBe('op-2');
    expect(a2aOperationIdOf('{"type":"free_form_task","operation_id":"op-3"}')).toBeNull();
    expect(a2aOperationIdOf('not json')).toBeNull();
  });
});

describe('the consumer’s A2A branch', () => {
  const dispatchTask: WorkflowTask = {
    id: 'a2a-dispatch-1',
    kind: 'delegation',
    status: 'completed',
    priority: 'user_blocking',
    description: 'Send to Summarizer: Summarize',
    payload: JSON.stringify({ type: 'a2a_dispatch', operation_id: 'op-1' }),
    result: JSON.stringify({ operation_id: 'op-1', outcome: 'held_for_guard' }),
    result_summary: 'result held for the guard',
    policy: '{}',
    created_at: 1,
    updated_at: 2,
  };
  const event = (id: number, kind: string, taskId = dispatchTask.id): WorkflowEvent => ({
    event_id: id,
    task_id: taskId,
    at: 3,
    event_kind: kind,
    needs_delivery: true,
    delivery_attempts: 0,
    delivery_failed: false,
    details: '{"operation_id":"op-1"}',
  });

  function harness(
    events: WorkflowEvent[],
    tasks: WorkflowTask[],
    operation: A2AOperationStatus | null | Error,
    extra: Partial<ConstructorParameters<typeof WorkflowEventConsumer>[0]> = {},
  ) {
    const acked: number[] = [];
    const failed: number[] = [];
    const delivered: { text: string; details: unknown }[] = [];
    const client: WorkflowEventConsumerCoreClient = {
      listWorkflowEvents: async () => events,
      acknowledgeWorkflowEvent: async (id) => {
        acked.push(id);
        return true;
      },
      getWorkflowTask: async (id) => tasks.find((t) => t.id === id) ?? null,
      getA2AOperation: async () => {
        if (operation instanceof Error) throw operation;
        return operation;
      },
      failWorkflowEventDelivery: async (id) => {
        failed.push(id);
        return true;
      },
    };
    const consumer = new WorkflowEventConsumer({
      coreClient: client,
      deliver: ({ text, details }) => {
        delivered.push({ text, details });
      },
      ...extra,
    });
    return { consumer, acked, failed, delivered };
  }

  it('delivers the released result once, with its conversation', async () => {
    const h = harness([event(1, 'a2a_result_released')], [dispatchTask], op());
    await h.consumer.runTick();
    expect(h.delivered).toEqual([
      {
        text: 'Summarizer answered:\n\nThe summary.\n\n{\n  "n": 1\n}',
        details: { a2a: { operation_id: 'op-1', reply_to: 'main' } },
      },
    ]);
    expect(h.acked).toEqual([1]);
  });

  it.each(['completed', 'failed', 'cancelled', 'outcome_unknown'])(
    'skips the workflow’s own %s event on the dispatch child: no generic bubble, no second message',
    async (kind) => {
      const h = harness([event(1, kind)], [dispatchTask], op({ state: 'failed', reason: 'remote_failed', result: null }));
      await h.consumer.runTick();
      expect(h.delivered).toEqual([]);
      expect(h.acked).toEqual([1]);
    },
  );

  it('delivers an ending in Dina’s words', async () => {
    const h = harness([event(1, 'a2a_operation_ended')], [{ ...dispatchTask, status: 'failed', error: 'a2a: remote_failed' }], op({ state: 'failed', reason: 'remote_failed', result: null }));
    await h.consumer.runTick();
    expect(h.delivered.map((d) => d.text)).toEqual(['Summarizer could not do it.']);
  });

  it('delivers an ending on the consent card, before any dispatch child exists', async () => {
    const card: WorkflowTask = {
      ...dispatchTask,
      id: 'a2a-consent-op-1',
      kind: 'approval',
      status: 'cancelled',
      payload: JSON.stringify({ type: 'a2a_delegation_consent', operation_id: 'op-1' }),
    };
    const h = harness(
      [event(1, 'cancelled', card.id), event(2, 'a2a_operation_ended', card.id)],
      [card],
      op({ state: 'refused', reason: 'refused', result: null }),
    );
    await h.consumer.runTick();
    expect(h.delivered).toEqual([
      { text: 'You declined the request to Summarizer. Nothing was sent.', details: { a2a: { operation_id: 'op-1', reply_to: 'main' } } },
    ]);
    expect(h.acked).toEqual([1, 2]);
  });

  it('skips the consent card’s approved event: the dispatch path, not the chat, acts on it', async () => {
    const card: WorkflowTask = {
      ...dispatchTask,
      id: 'a2a-consent-op-1',
      kind: 'approval',
      status: 'queued',
      payload: JSON.stringify({ type: 'a2a_delegation_consent', operation_id: 'op-1' }),
    };
    const onApproved = jest.fn();
    const h = harness([event(1, 'approved', card.id)], [card], op({ state: 'queued', result: null }), { onApproved });
    await h.consumer.runTick();
    expect(onApproved).not.toHaveBeenCalled();
    expect(h.delivered).toEqual([]);
    expect(h.acked).toEqual([1]);
  });

  it('skips an A2A event kind on a task that is not an A2A dispatch', async () => {
    const other = { ...dispatchTask, id: 'free', payload: '{"type":"free_form_task"}' };
    const h = harness([event(1, 'a2a_result_released', 'free')], [other], op());
    await h.consumer.runTick();
    expect(h.delivered).toEqual([]);
    expect(h.acked).toEqual([1]);
  });

  it('backs off, unacknowledged, when Core cannot be read', async () => {
    const h = harness([event(1, 'a2a_result_released')], [dispatchTask], new Error('ECONNRESET'));
    await h.consumer.runTick();
    expect(h.delivered).toEqual([]);
    expect(h.acked).toEqual([]);
    expect(h.failed).toEqual([1]);
  });
});
