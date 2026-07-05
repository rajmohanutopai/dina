/**
 * Tests for `sendChatMessage` — the outbound-chat wrapper over Core's
 * D2DSender. Covers the optimistic-local-echo behaviour, the wire
 * payload shape, and the failure path that writes an error row.
 *
 * Also covers `sendServiceQuery` (Contact Services seam 5) — the
 * Talk-initiated peer service invoke that drives the orchestrator's
 * correlating workflow-task path and posts a pending `service_query`
 * card into the PEER thread.
 */

import {
  sendChatMessage,
  sendServiceQuery,
  sendGrantRequest,
  ChatSendError,
  setServiceQueryDispatcher,
  type ServiceQueryDispatcher,
} from '../../src/services/chat_d2d';
import { setD2DSender, getD2DSender } from '../../../core/src/server/routes/d2d_msg';
import { resetThreads, getThread, readLifecycle } from '../../../brain/src/chat/thread';
import { validateServiceGrantRequestBody } from '@dina/protocol';

const PEER = 'did:plc:testdemoprovider';

beforeEach(() => {
  resetThreads();
  setD2DSender(null);
  setServiceQueryDispatcher(null);
});

afterEach(() => {
  setD2DSender(null);
  setServiceQueryDispatcher(null);
});

describe('sendChatMessage', () => {
  it('throws ChatSendError when the D2D sender is not wired', async () => {
    await expect(sendChatMessage(PEER, 'hi')).rejects.toBeInstanceOf(ChatSendError);
  });

  it('rejects empty peer DID', async () => {
    setD2DSender(async () => {});
    await expect(sendChatMessage('', 'hi')).rejects.toThrow(/peerDID/);
  });

  it('rejects empty text (after trim)', async () => {
    setD2DSender(async () => {});
    await expect(sendChatMessage(PEER, '   ')).rejects.toThrow(/text/);
  });

  it('sends a coordination.request with {text} body and echos locally', async () => {
    const calls: Array<{ to: string; type: string; body: unknown }> = [];
    setD2DSender(async (to, type, body) => {
      calls.push({ to, type, body });
    });

    const msg = await sendChatMessage(PEER, 'hello');
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(PEER);
    expect(calls[0].type).toBe('coordination.request');
    expect(calls[0].body).toEqual({ text: 'hello' });

    const thread = getThread(PEER);
    expect(thread).toHaveLength(1);
    expect(thread[0].id).toBe(msg.id);
    expect(thread[0].content).toBe('hello');
    expect(thread[0].type).toBe('user');
    expect(thread[0].metadata?.source).toBe('d2d');
    expect(thread[0].metadata?.peerDID).toBe(PEER);
  });

  it('trims the outgoing text', async () => {
    const calls: Array<{ body: unknown }> = [];
    setD2DSender(async (_to, _type, body) => {
      calls.push({ body });
    });
    await sendChatMessage(PEER, '   padded hi   ');
    expect(calls[0].body).toEqual({ text: 'padded hi' });
    expect(getThread(PEER)[0].content).toBe('padded hi');
  });

  it('keeps the user bubble AND appends an error row on send failure', async () => {
    setD2DSender(async () => {
      throw new Error('relay down');
    });

    await expect(sendChatMessage(PEER, 'try me')).rejects.toThrow(/relay down/);
    const thread = getThread(PEER);
    expect(thread).toHaveLength(2);
    expect(thread[0].type).toBe('user');
    expect(thread[0].content).toBe('try me');
    expect(thread[1].type).toBe('error');
    expect(thread[1].content).toMatch(/relay down/);
    expect(thread[1].metadata?.failedMessageId).toBe(thread[0].id);
  });

  it('does not hit the sender when validation fails', async () => {
    let hit = 0;
    setD2DSender(async () => {
      hit++;
    });
    await expect(sendChatMessage(PEER, '')).rejects.toThrow();
    expect(hit).toBe(0);
    expect(getThread(PEER)).toHaveLength(0);
  });

  it('leaves the installed D2D sender untouched across calls', async () => {
    const fn = jest.fn(async () => {});
    setD2DSender(fn);
    await sendChatMessage(PEER, 'first');
    await sendChatMessage(PEER, 'second');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getD2DSender()).toBe(fn);
  });

  it('flips deliveryStatus from sending → delivered on a successful send (MT-19-I1)', async () => {
    // Hold the wire-send until we explicitly let it through. While it
    // hangs, the user bubble must already carry deliveryStatus:'sending'
    // so the chat row can render the spinner immediately. Once the
    // wire send resolves, it must transition to 'delivered'.
    let release!: () => void;
    setD2DSender(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const sendPromise = sendChatMessage(PEER, 'in flight');
    // Microtask flush so the optimistic addMessage runs.
    await Promise.resolve();
    const inFlight = getThread(PEER)[0];
    expect(inFlight.metadata?.deliveryStatus).toBe('sending');
    release();
    await sendPromise;
    const settled = getThread(PEER)[0];
    expect(settled.id).toBe(inFlight.id); // same bubble, just patched
    expect(settled.metadata?.deliveryStatus).toBe('delivered');
  });

  it('flips deliveryStatus to failed and records the reason on send failure (MT-19-I1)', async () => {
    setD2DSender(async () => {
      throw new Error('msgbox unreachable');
    });
    await expect(sendChatMessage(PEER, 'oh no')).rejects.toThrow(/msgbox unreachable/);
    const userBubble = getThread(PEER)[0];
    expect(userBubble.type).toBe('user');
    expect(userBubble.metadata?.deliveryStatus).toBe('failed');
    expect(userBubble.metadata?.deliveryError).toMatch(/msgbox unreachable/);
  });
});

describe('sendServiceQuery (Contact Services seam 5)', () => {
  /**
   * A stub orchestrator that records the `issueQueryToDID` call and returns a
   * deterministic taskId — the SAME id the real Core route mints + the
   * WorkflowEventConsumer later patches by. We assert the card carries it so
   * the correlation contract holds.
   */
  function makeStubDispatcher(
    taskId = 'sq-q1-deadbeef',
    queryId = 'q1',
  ): { dispatcher: ServiceQueryDispatcher; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    const dispatcher: ServiceQueryDispatcher = {
      issueQueryToDID: async (req) => {
        calls.push(req as unknown as Record<string, unknown>);
        return { queryId, taskId, toDID: req.toDID, serviceName: req.serviceName ?? req.capability };
      },
    };
    return { dispatcher, calls };
  }

  it('throws ChatSendError when the dispatcher is not wired', async () => {
    await expect(
      sendServiceQuery(PEER, 'availability_coordination', { intent: 'find a time' }),
    ).rejects.toBeInstanceOf(ChatSendError);
  });

  it('rejects empty peer DID', async () => {
    const { dispatcher } = makeStubDispatcher();
    setServiceQueryDispatcher(dispatcher);
    await expect(
      sendServiceQuery('', 'availability_coordination', {}),
    ).rejects.toThrow(/peerDID/);
  });

  it('rejects empty capability', async () => {
    const { dispatcher } = makeStubDispatcher();
    setServiceQueryDispatcher(dispatcher);
    await expect(sendServiceQuery(PEER, '   ', {})).rejects.toThrow(/capability/);
  });

  it('dispatches a service.query to the peer DID and posts a pending card in the peer thread', async () => {
    const { dispatcher, calls } = makeStubDispatcher('sq-q1-aabbccdd', 'q1');
    setServiceQueryDispatcher(dispatcher);

    const params = { intent: 'find a time next week', candidate_slots: [{ start: 'Tue 3pm' }] };
    const msg = await sendServiceQuery(PEER, 'availability_coordination', params, {
      offer: {
        grantId: 'grant-xyz',
        serviceUri: 'at://did:plc:testdemoprovider/com.dinakernel.service.profile/sched',
        serviceName: 'Sancho scheduling',
        schemaHash: 'hash123',
      },
    });

    // (a) the orchestrator (= the wire send + the correlating workflow task)
    //     was invoked toward the peer, carrying the grant + listing + the peer
    //     thread as the origin_channel.
    expect(calls).toHaveLength(1);
    expect(calls[0].toDID).toBe(PEER);
    expect(calls[0].capability).toBe('availability_coordination');
    expect(calls[0].params).toEqual(params);
    expect(calls[0].originChannel).toBe(PEER);
    expect(calls[0].grantId).toBe('grant-xyz');
    expect(calls[0].serviceUri).toBe(
      'at://did:plc:testdemoprovider/com.dinakernel.service.profile/sched',
    );
    expect(calls[0].schemaHash).toBe('hash123');

    // (b) the PEER thread has exactly one pending service_query card, keyed by
    //     the orchestrator-returned taskId (the correlation key).
    const thread = getThread(PEER);
    expect(thread).toHaveLength(1);
    expect(thread[0].id).toBe(msg.id);
    const lc = readLifecycle(thread[0]);
    expect(lc?.kind).toBe('service_query');
    if (lc?.kind !== 'service_query') throw new Error('expected service_query lifecycle');
    expect(lc.status).toBe('pending');
    expect(lc.taskId).toBe('sq-q1-aabbccdd');
    expect(lc.queryId).toBe('q1');
    expect(lc.capability).toBe('availability_coordination');
    expect(lc.serviceName).toBe('Sancho scheduling');
    expect(lc.providerDid).toBe(PEER);
    expect(lc.params).toEqual(params);
  });

  it('falls back to the capability name when no offer/serviceName is given', async () => {
    const { dispatcher, calls } = makeStubDispatcher();
    setServiceQueryDispatcher(dispatcher);
    await sendServiceQuery(PEER, 'availability_coordination', {});
    // No offer → no grant/uri forwarded (the provider authorizes by other rules
    // or rejects; the function does not invent a grant).
    expect(calls[0].grantId).toBeUndefined();
    expect(calls[0].serviceUri).toBeUndefined();
    const lc = readLifecycle(getThread(PEER)[0]);
    if (lc?.kind !== 'service_query') throw new Error('expected service_query lifecycle');
    expect(lc.serviceName).toBe('availability_coordination');
  });

  it("forwards the offer's defaultTtlSeconds when no explicit ttl is given (P3-b)", async () => {
    const { dispatcher, calls } = makeStubDispatcher();
    setServiceQueryDispatcher(dispatcher);
    await sendServiceQuery(PEER, 'availability_coordination', {}, {
      offer: {
        grantId: 'g',
        serviceUri: 'at://did:plc:testdemoprovider/com.dinakernel.service.profile/sched',
        defaultTtlSeconds: 300,
      },
    });
    expect(calls[0].ttlSeconds).toBe(300);
  });

  it('an explicit ttlSeconds overrides the offer default (P3-b precedence)', async () => {
    const { dispatcher, calls } = makeStubDispatcher();
    setServiceQueryDispatcher(dispatcher);
    await sendServiceQuery(PEER, 'availability_coordination', {}, {
      ttlSeconds: 120,
      offer: {
        grantId: 'g',
        serviceUri: 'at://did:plc:testdemoprovider/com.dinakernel.service.profile/sched',
        defaultTtlSeconds: 300,
      },
    });
    expect(calls[0].ttlSeconds).toBe(120);
  });

  it('forwards NO ttl when neither an explicit ttl nor an offer default exists (orchestrator default applies)', async () => {
    const { dispatcher, calls } = makeStubDispatcher();
    setServiceQueryDispatcher(dispatcher);
    await sendServiceQuery(PEER, 'availability_coordination', {});
    expect(calls[0].ttlSeconds).toBeUndefined();
  });

  it('posts an error row AND throws when the dispatch fails', async () => {
    const dispatcher: ServiceQueryDispatcher = {
      issueQueryToDID: async () => {
        throw new Error('no candidate / relay down');
      },
    };
    setServiceQueryDispatcher(dispatcher);
    await expect(
      sendServiceQuery(PEER, 'availability_coordination', {}),
    ).rejects.toThrow(/relay down/);
    const thread = getThread(PEER);
    // No pending card was left behind (the dispatch never produced a taskId);
    // the user sees a standalone error row instead of a phantom "pending".
    expect(thread).toHaveLength(1);
    expect(thread[0].type).toBe('error');
    expect(thread[0].content).toMatch(/relay down/);
    expect(readLifecycle(thread[0])).toBeNull();
  });

  it('does NOT post a stuck "Asking…" card when the dispatch returns an empty taskId', async () => {
    // A contract violation: an empty taskId is uncorrelatable (readLifecycle
    // drops it + the WorkflowEventConsumer can never patch it). The function
    // must surface an error row + throw rather than leave a dead card.
    const dispatcher: ServiceQueryDispatcher = {
      issueQueryToDID: async (req) => ({
        queryId: 'q1',
        taskId: '', // empty — uncorrelatable
        toDID: req.toDID,
        serviceName: req.serviceName ?? req.capability,
      }),
    };
    setServiceQueryDispatcher(dispatcher);
    await expect(
      sendServiceQuery(PEER, 'availability_coordination', {}),
    ).rejects.toThrow(/no task id|uncorrelatable/i);
    const thread = getThread(PEER);
    // Exactly one error row, NO service_query lifecycle card.
    expect(thread).toHaveLength(1);
    expect(thread[0].type).toBe('error');
    expect(readLifecycle(thread[0])).toBeNull();
  });
});

describe('sendGrantRequest (Contact Services §5.2 bootstrap)', () => {
  it('throws ChatSendError when the D2D sender is not wired', async () => {
    await expect(sendGrantRequest(PEER, 'availability_coordination')).rejects.toBeInstanceOf(
      ChatSendError,
    );
  });

  it('rejects empty peer DID / capability', async () => {
    setD2DSender(async () => {});
    await expect(sendGrantRequest('', 'availability_coordination')).rejects.toThrow(/peerDID/);
    await expect(sendGrantRequest(PEER, '   ')).rejects.toThrow(/capability/);
  });

  it('sends exactly ONE service.grant_request with capability + requested_surface:talk and NO rkey', async () => {
    const calls: Array<{ to: string; type: string; body: Record<string, unknown> }> = [];
    setD2DSender(async (to, type, body) => {
      calls.push({ to, type, body });
    });

    const { requestId } = await sendGrantRequest(
      PEER,
      'availability_coordination',
      'find a time next week',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(PEER);
    expect(calls[0].type).toBe('service.grant_request');
    const body = calls[0].body;
    expect(body.capability).toBe('availability_coordination');
    expect(body.requested_surface).toBe('talk');
    expect(body.intent).toBe('find a time next week');
    expect(typeof body.request_id).toBe('string');
    expect(body.request_id).toBe(requestId);
    // The whole point of §5.2: the requester NEVER names the provider's private rkey.
    expect(body).not.toHaveProperty('rkey');
    // The produced body is wire-valid against the protocol validator the
    // provider's receive pipeline runs.
    expect(validateServiceGrantRequestBody(body)).toBeNull();
  });

  it('omits intent when blank/absent', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    setD2DSender(async (_to, _type, body) => {
      calls.push({ body });
    });
    await sendGrantRequest(PEER, 'availability_coordination');
    expect(calls[0].body).not.toHaveProperty('intent');
    await sendGrantRequest(PEER, 'availability_coordination', '   ');
    expect(calls[1].body).not.toHaveProperty('intent');
  });

  it('throws ChatSendError (wrapping the cause) when the send fails', async () => {
    setD2DSender(async () => {
      throw new Error('relay down');
    });
    await expect(
      sendGrantRequest(PEER, 'availability_coordination'),
    ).rejects.toThrow(/relay down/);
  });
});
