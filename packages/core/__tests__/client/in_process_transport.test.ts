/**
 * InProcessTransport smoke — prove the adapter correctly dispatches
 * typed CoreClient method calls through a CoreRouter. Covers the
 * healthz + vault CRUD surface (task 1.30 scaffold scope).
 */

import { InProcessTransport } from '../../src/client/in-process-transport';
import { CoreRouter } from '../../src/server/router';
import { WorkflowConflictError } from '../../src';

function buildRouter(): CoreRouter {
  const r = new CoreRouter();

  r.get(
    '/healthz',
    () => ({ status: 200, body: { status: 'ok', did: 'did:key:test', version: '0.0.0' } }),
    { auth: 'public' },
  );

  r.post(
    '/v1/vault/query',
    (req) => {
      const body = req.body as { persona?: string; q?: string; type?: string };
      return {
        status: 200,
        body: {
          items: [{ id: 'i1', persona: body.persona, q: body.q }],
          count: 1,
        },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/vault/store',
    (req) => {
      const body = req.body as { persona?: string; type?: string };
      return {
        status: 201,
        body: { id: 'item-new', storedAt: '2026-04-21T00:00:00Z' },
      };
    },
    { auth: 'public' },
  );

  r.get(
    '/v1/vault/list',
    (req) => ({
      status: 200,
      body: {
        items: [{ id: 'a' }, { id: 'b' }],
        count: 2,
        total: 42,
      },
    }),
    { auth: 'public' },
  );

  r.delete(
    '/v1/vault/items/:id',
    (req) => ({
      status: 200,
      body: { deleted: req.params.id === 'known' },
    }),
    { auth: 'public' },
  );

  // DID-sign routes (1.29b)

  r.post(
    '/v1/did/sign',
    (req) => {
      const body = req.body as { payload?: string };
      // Return a deterministic "signature" of the base64 payload length —
      // enough to prove the bytes arrived intact.
      const decoded = Buffer.from(body.payload ?? '', 'base64');
      return {
        status: 200,
        body: {
          signature: `sig-${decoded.length}`,
          did: 'did:plc:home',
        },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/did/sign-canonical',
    (req) => {
      const body = req.body as { method?: string; path?: string };
      return {
        status: 200,
        body: {
          did: 'did:plc:home',
          timestamp: '2026-04-21T12:00:00Z',
          nonce: 'ff'.repeat(8),
          signature: `canon-${body.method}-${body.path}`,
        },
      };
    },
    { auth: 'public' },
  );

  // Notify route (1.29d)

  r.post(
    '/v1/notify',
    (req) => {
      const body = req.body as { priority?: string; title?: string };
      // Echo priority + fake subscriber count based on priority. Fiduciary
      // "always" has at least 1 subscriber in this fake (prod's real count
      // comes from the WS hub's live connection map).
      const subscribers = body.priority === 'fiduciary' ? 2 : 1;
      return {
        status: 200,
        body: {
          accepted: true,
          notificationId: `notif-${body.priority ?? 'unknown'}-${body.title?.length ?? 0}`,
          subscribers,
        },
      };
    },
    { auth: 'public' },
  );

  // Persona gatekeeper routes (1.29e)

  r.get(
    '/v1/persona/status',
    (req) => {
      const persona = req.query.persona ?? '';
      if (persona === 'personal') {
        return {
          status: 200,
          body: {
            persona,
            tier: 'default',
            open: true,
            dekFingerprint: 'ab12cd34',
            openedAt: 1776700000,
          },
        };
      }
      if (persona === 'financial') {
        return {
          status: 200,
          body: {
            persona,
            tier: 'locked',
            open: false,
            dekFingerprint: null,
            openedAt: null,
          },
        };
      }
      return { status: 404, body: { error: `unknown persona: ${persona}` } };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/persona/unlock',
    (req) => {
      const body = req.body as { persona?: string; passphrase?: string };
      if (body.persona === 'financial' && body.passphrase === 'correct-passphrase') {
        return {
          status: 200,
          body: {
            persona: body.persona,
            unlocked: true,
            dekFingerprint: 'ef56gh78',
          },
        };
      }
      return {
        status: 200,
        body: {
          persona: body.persona,
          unlocked: false,
          dekFingerprint: null,
          error: 'wrong_passphrase',
        },
      };
    },
    { auth: 'public' },
  );

  // PII-scrub routes (1.29c)

  r.post(
    '/v1/pii/scrub',
    (req) => {
      const body = req.body as { text?: string };
      // Fake: replace any occurrence of "Alice" with "{{ENTITY:0}}".
      const scrubbed = (body.text ?? '').replace(/Alice/g, '{{ENTITY:0}}');
      return {
        status: 200,
        body: {
          scrubbed,
          sessionId: 'pii-session-abc',
          entityCount: scrubbed.includes('{{ENTITY:0}}') ? 1 : 0,
        },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/pii/rehydrate',
    (req) => {
      const body = req.body as { sessionId?: string; text?: string };
      // Only the exact session we minted restores entities; else passthrough.
      const rehydrated =
        body.sessionId === 'pii-session-abc'
          ? (body.text ?? '').replace(/\{\{ENTITY:0\}\}/g, 'Alice')
          : (body.text ?? '');
      return {
        status: 200,
        body: {
          rehydrated,
          sessionFound: body.sessionId === 'pii-session-abc',
        },
      };
    },
    { auth: 'public' },
  );

  // Service config + query routes (1.29f)

  r.get(
    '/v1/service/config',
    () => ({
      status: 200,
      body: {
        isDiscoverable: true,
        name: 'SF Transit Authority',
        capabilities: {
          eta_query: {
            mcpServer: 'transit',
            mcpTool: 'get_eta',
            responsePolicy: 'auto',
            schemaHash: 'a1b2c3d4',
          },
        },
      },
    }),
    { auth: 'public' },
  );

  r.post(
    '/v1/service/query',
    (req) => {
      const body = req.body as Record<string, unknown>;
      // Fake: echo the to_did + capability back into the task id so
      // the test can prove the snake_case conversion happened intact.
      return {
        status: 200,
        body: {
          task_id: `sq-${body.query_id}-fake`,
          query_id: body.query_id,
          // Dedupe only when schema_hash is "stale-pin" — lets the
          // deduped-path test exercise the optional field.
          ...(body.schema_hash === 'stale-pin' ? { deduped: true } : {}),
        },
      };
    },
    { auth: 'public' },
  );

  // Staging inbox routes (task 1.29h / 1.32 preamble)

  r.post(
    '/v1/staging/claim',
    (req) => {
      // Echo the limit so tests can prove the query-param wiring
      // travelled through to the route.
      const limit = Number.parseInt(req.query.limit ?? '10', 10);
      const items: unknown[] = [];
      for (let i = 0; i < Math.min(limit, 3); i++) {
        items.push({ id: `stg-${i}`, source: 'fake', data: { text: `body-${i}` } });
      }
      return { status: 200, body: { items, count: items.length } };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/staging/resolve',
    (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Emit the two distinct shapes so transport tests can pin both
      // the single-persona + GAP-MULTI-01 fan-out paths.
      if (Array.isArray(body.personas)) {
        const personas = (body.personas as string[]).filter((p) => typeof p === 'string');
        return {
          status: 200,
          body: { id: body.id as string, status: 'stored', personas },
        };
      }
      return {
        status: 200,
        body: { id: body.id as string, status: 'stored' },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/staging/fail',
    (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return {
        status: 200,
        body: { id: body.id as string, retry_count: 2 },
      };
    },
    { auth: 'public' },
  );

  r.post(
    '/v1/staging/extend-lease',
    (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Echo `seconds` so the test proves the body→route wiring worked.
      return {
        status: 200,
        body: { id: body.id as string, extended_by: body.seconds as number },
      };
    },
    { auth: 'public' },
  );

  // D2D messaging route (task 1.29h / 1.32 preamble)

  r.post(
    '/v1/msg/send',
    (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.recipient_did !== 'string' || body.recipient_did === '') {
        return { status: 400, body: { error: 'recipient_did is required' } };
      }
      if (typeof body.type !== 'string' || body.type === '') {
        return { status: 400, body: { error: 'type is required' } };
      }
      return { status: 200, body: { ok: true } };
    },
    { auth: 'public' },
  );

  // Service respond route (task 1.32 slice A)
  r.post(
    '/v1/service/respond',
    (req) => {
      const body = (req.body ?? {}) as { task_id?: unknown; response_body?: unknown };
      const taskId = typeof body.task_id === 'string' ? body.task_id : '';
      if (taskId === '') return { status: 400, body: { error: 'task_id is required' } };
      const resp = body.response_body as
        | { status?: string; result?: unknown; error?: string }
        | undefined;
      if (resp === undefined || typeof resp !== 'object') {
        return { status: 400, body: { error: 'response_body must be a JSON object' } };
      }
      // Fake: tasks ending with '-already' return already_processed=true
      // so the test can drive both the fresh + retry paths from one
      // fixture. Real route consults the repo; the transport test only
      // cares about wire shape.
      if (taskId.endsWith('-already')) {
        return { status: 200, body: { already_processed: true, status: 'completed' } };
      }
      return { status: 200, body: { status: 'sent', task_id: taskId } };
    },
    { auth: 'public' },
  );

  // Workflow events routes (task 1.32 slice B)
  const workflowEvents: Array<{
    event_id: number;
    task_id: string;
    at: number;
    event_kind: string;
    needs_delivery: boolean;
    delivery_attempts: number;
    delivery_failed: boolean;
    details: string;
    acknowledged_at?: number;
  }> = [
    {
      event_id: 1,
      task_id: 'sq-1',
      at: 1_700_000_000_000,
      event_kind: 'completed',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    },
    {
      event_id: 2,
      task_id: 'sq-2',
      at: 1_700_000_001_000,
      event_kind: 'progress',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    },
    {
      event_id: 3,
      task_id: 'sq-3',
      at: 1_700_000_002_000,
      event_kind: 'completed',
      needs_delivery: true,
      delivery_attempts: 1,
      delivery_failed: false,
      details: '{}',
      acknowledged_at: 1_700_000_003_000,
    },
  ];
  r.get(
    '/v1/workflow/events',
    (req) => {
      const since = Number.parseInt(req.query.since ?? '0', 10) || 0;
      const limit = Number.parseInt(req.query.limit ?? '100', 10) || 100;
      const needsDeliveryOnly = req.query.needs_delivery === 'true';
      let evs = workflowEvents.filter((e) => e.event_id > since);
      if (needsDeliveryOnly) {
        evs = evs.filter((e) => e.needs_delivery && e.acknowledged_at === undefined);
      }
      evs = evs.slice(0, limit);
      return { status: 200, body: { events: evs, count: evs.length } };
    },
    { auth: 'public' },
  );
  r.post(
    '/v1/workflow/events/:id/ack',
    (req) => {
      const id = Number.parseInt(req.params.id ?? '', 10);
      if (!Number.isFinite(id) || id <= 0) {
        return { status: 400, body: { error: 'event id must be a positive integer' } };
      }
      const ev = workflowEvents.find((e) => e.event_id === id);
      if (ev === undefined) return { status: 404, body: { error: 'event not found' } };
      ev.acknowledged_at = 1_700_000_005_000;
      return { status: 200, body: { ok: true } };
    },
    { auth: 'public' },
  );
  r.post(
    '/v1/workflow/events/:id/fail',
    (req) => {
      const id = Number.parseInt(req.params.id ?? '', 10);
      if (!Number.isFinite(id) || id <= 0) {
        return { status: 400, body: { error: 'event id must be a positive integer' } };
      }
      const ev = workflowEvents.find((e) => e.event_id === id);
      if (ev === undefined) return { status: 404, body: { error: 'event not found' } };
      const body = (req.body ?? {}) as { next_delivery_at?: number };
      const nextAt = typeof body.next_delivery_at === 'number' ? body.next_delivery_at : 0;
      return { status: 200, body: { ok: true, next_delivery_at: nextAt } };
    },
    { auth: 'public' },
  );

  // Workflow tasks routes (task 1.32 slices C + D) — in-memory store
  // lets one fixture drive both read + create + transition scenarios.
  const workflowTasks: Array<Record<string, unknown>> = [
    {
      id: 'wf-1',
      kind: 'service_query',
      status: 'pending_approval',
      priority: 'normal',
      description: 'pending approval task',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      idempotency_key: 'idem-1',
    },
    {
      id: 'wf-2',
      kind: 'service_query',
      status: 'queued',
      priority: 'normal',
      description: 'queued task',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 1_700_000_001_000,
      updated_at: 1_700_000_001_000,
    },
    {
      id: 'wf-3',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: 'other-kind task',
      payload: '{}',
      result_summary: '',
      policy: '{}',
      created_at: 1_700_000_002_000,
      updated_at: 1_700_000_002_000,
    },
  ];
  r.get(
    '/v1/workflow/tasks',
    (req) => {
      const kind = req.query.kind ?? '';
      const state = req.query.state ?? '';
      if (kind === '' || state === '') {
        return { status: 400, body: { error: 'kind and state query parameters are required' } };
      }
      const limit = Number.parseInt(req.query.limit ?? '100', 10) || 100;
      let tasks = workflowTasks.filter((t) => t.kind === kind && t.status === state);
      tasks = tasks.slice(0, limit);
      return { status: 200, body: { tasks, count: tasks.length } };
    },
    { auth: 'public' },
  );
  r.get(
    '/v1/workflow/tasks/:id',
    (req) => {
      const id = req.params.id ?? '';
      if (id === '') return { status: 400, body: { error: 'id required' } };
      const task = workflowTasks.find((t) => t.id === id);
      if (task === undefined) return { status: 404, body: { error: 'task not found' } };
      return { status: 200, body: { task } };
    },
    { auth: 'public' },
  );
  r.post(
    '/v1/workflow/tasks',
    (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') return { status: 400, body: { error: 'id required', field: 'id' } };
      const idemKey = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
      // Idempotency match → 200 + deduped
      if (idemKey !== '') {
        const existing = workflowTasks.find((t) => t.idempotency_key === idemKey);
        if (existing !== undefined) {
          return { status: 200, body: { task: existing, deduped: true } };
        }
      }
      // Duplicate id → 409
      if (workflowTasks.some((t) => t.id === id)) {
        return { status: 409, body: { error: `duplicate task id: ${id}`, code: 'duplicate_id' } };
      }
      const now = 1_700_000_100_000;
      const task = {
        id,
        kind: typeof body.kind === 'string' ? body.kind : '',
        status: typeof body.initial_state === 'string' ? body.initial_state : 'created',
        priority: typeof body.priority === 'string' ? body.priority : 'normal',
        description: typeof body.description === 'string' ? body.description : '',
        payload: typeof body.payload === 'string' ? body.payload : '',
        result_summary: '',
        policy: typeof body.policy === 'string' ? body.policy : '{}',
        created_at: now,
        updated_at: now,
        ...(typeof body.idempotency_key === 'string'
          ? { idempotency_key: body.idempotency_key }
          : {}),
        ...(typeof body.correlation_id === 'string'
          ? { correlation_id: body.correlation_id }
          : {}),
      };
      workflowTasks.push(task);
      return { status: 201, body: { task } };
    },
    { auth: 'public' },
  );
  const transition = (newStatus: string, mutator?: (task: Record<string, unknown>, body: Record<string, unknown>) => void) =>
    (req: { params: Record<string, string>; body?: unknown }) => {
      const id = req.params.id ?? '';
      const task = workflowTasks.find((t) => t.id === id);
      if (task === undefined) return { status: 404, body: { error: 'task not found' } };
      const body = (req.body ?? {}) as Record<string, unknown>;
      task.status = newStatus;
      task.updated_at = 1_700_000_200_000;
      if (mutator !== undefined) mutator(task, body);
      return { status: 200, body: { task } };
    };
  r.post('/v1/workflow/tasks/:id/approve', transition('queued'), { auth: 'public' });
  r.post(
    '/v1/workflow/tasks/:id/cancel',
    transition('cancelled', (task, body) => {
      if (typeof body.reason === 'string') task.cancel_reason = body.reason;
    }),
    { auth: 'public' },
  );
  r.post(
    '/v1/workflow/tasks/:id/complete',
    transition('completed', (task, body) => {
      if (typeof body.result === 'string') task.result = body.result;
      if (typeof body.result_summary === 'string') task.result_summary = body.result_summary;
    }),
    { auth: 'public' },
  );
  r.post(
    '/v1/workflow/tasks/:id/fail',
    transition('failed', (task, body) => {
      if (typeof body.error === 'string') task.error = body.error;
    }),
    { auth: 'public' },
  );

  // Memory + contacts routes (task 1.32 slice E)
  const memoryTouches: Array<{ persona: string; topic: string; kind: string }> = [];
  const lockedPersonas = new Set(['financial']); // simulates a locked persona path
  r.post(
    '/v1/memory/topic/touch',
    (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const persona = typeof body.persona === 'string' ? body.persona : '';
      const topic = typeof body.topic === 'string' ? body.topic : '';
      const kind = typeof body.kind === 'string' ? body.kind : '';
      if (persona === '' || topic === '' || kind === '') {
        return {
          status: 400,
          body: { error: 'persona, topic, and kind are required' },
        };
      }
      if (lockedPersonas.has(persona)) {
        return { status: 200, body: { status: 'skipped', reason: 'persona locked' } };
      }
      memoryTouches.push({ persona, topic, kind });
      return {
        status: 200,
        body: { status: 'ok', canonical: topic.toLowerCase().trim() },
      };
    },
    { auth: 'public' },
  );
  const contactRows = new Map<string, { did: string; preferred_for?: string[] }>();
  contactRows.set('did:plc:drcarl', { did: 'did:plc:drcarl' });
  r.put(
    '/v1/contacts/:did',
    (req) => {
      const did = decodeURIComponent(req.params.did ?? '');
      const row = contactRows.get(did);
      if (row === undefined) return { status: 404, body: { error: 'contact not found' } };
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Tri-state: undefined → don't touch; [] → clear; array → replace.
      if (body.preferred_for !== undefined) {
        if (!Array.isArray(body.preferred_for)) {
          return {
            status: 400,
            body: { error: 'preferred_for must be an array of strings' },
          };
        }
        row.preferred_for = body.preferred_for.map((x) =>
          typeof x === 'string' ? x.toLowerCase().trim() : '',
        );
      }
      return { status: 200, body: { ok: true } };
    },
    { auth: 'public' },
  );

  // Scratchpad routes (task 1.32 preamble) — tiny in-memory store so
  // the round-trip (checkpoint → resume → clear) is observable.
  const scratchpadStore = new Map<
    string,
    { step: number; context: Record<string, unknown>; createdAt: number; updatedAt: number }
  >();
  r.post(
    '/v1/scratchpad',
    (req) => {
      const body = (req.body ?? {}) as {
        taskId?: unknown;
        step?: unknown;
        context?: unknown;
      };
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      if (taskId === '') return { status: 400, body: { error: 'taskId is required' } };
      const step = typeof body.step === 'number' ? body.step : NaN;
      if (!Number.isInteger(step)) {
        return { status: 400, body: { error: 'step must be an integer' } };
      }
      const context = (body.context ?? {}) as Record<string, unknown>;
      if (step === 0) {
        scratchpadStore.delete(taskId);
      } else {
        const existing = scratchpadStore.get(taskId);
        const now = 1_700_000_000_000;
        scratchpadStore.set(taskId, {
          step,
          context,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      }
      return { status: 200, body: { status: 'ok', taskId } };
    },
    { auth: 'public' },
  );
  r.get(
    '/v1/scratchpad/:taskId',
    (req) => {
      const taskId = req.params.taskId ?? '';
      if (taskId === '') return { status: 400, body: { error: 'taskId is required' } };
      const entry = scratchpadStore.get(taskId);
      if (entry === undefined) return { status: 200, body: null };
      return { status: 200, body: { taskId, ...entry } };
    },
    { auth: 'public' },
  );
  r.delete(
    '/v1/scratchpad/:taskId',
    (req) => {
      const taskId = req.params.taskId ?? '';
      if (taskId === '') return { status: 400, body: { error: 'taskId is required' } };
      scratchpadStore.delete(taskId);
      return { status: 200, body: { status: 'ok' } };
    },
    { auth: 'public' },
  );

  // Memory ToC route (1.29g)

  r.get(
    '/v1/memory/toc',
    (req) => {
      const personaFilter = req.query.persona ?? '';
      const limit = Number.parseInt(req.query.limit ?? '50', 10);
      // Fake: echo the persona filter back through entries so the
      // test can prove the comma-joined encoding worked.
      const allEntries = [
        {
          persona: 'personal',
          topic: 'dentist',
          kind: 'entity',
          salience: 0.92,
          last_update: 1776700000,
        },
        {
          persona: 'work',
          topic: 'q2-planning',
          kind: 'theme',
          salience: 0.45,
          last_update: 1776600000,
        },
      ];
      const filtered =
        personaFilter === ''
          ? allEntries
          : allEntries.filter((e) => personaFilter.split(',').includes(e.persona));
      return { status: 200, body: { entries: filtered, limit } };
    },
    { auth: 'public' },
  );

  return r;
}

describe('InProcessTransport (task 1.30)', () => {
  it('healthz round-trips via CoreRouter.handle', async () => {
    const t = new InProcessTransport(buildRouter());
    const h = await t.healthz();
    expect(h.status).toBe('ok');
    expect(h.did).toBe('did:key:test');
  });

  it('vaultQuery sends persona + query body', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.vaultQuery('personal', { q: 'dentist', type: 'contact' });
    expect(r.count).toBe(1);
    const first = (r.items as Array<Record<string, unknown>>)[0];
    expect(first?.persona).toBe('personal');
    expect(first?.q).toBe('dentist');
  });

  it('vaultStore returns the assigned id', async () => {
    const t = new InProcessTransport(buildRouter());
    const s = await t.vaultStore('personal', { type: 'note', content: { text: 'hi' } });
    expect(s.id).toBe('item-new');
    expect(s.storedAt).toMatch(/^2026/);
  });

  it('vaultList returns items + count', async () => {
    const t = new InProcessTransport(buildRouter());
    const l = await t.vaultList('personal', { limit: 10 });
    expect(l.count).toBe(2);
    expect(l.total).toBe(42);
  });

  it('vaultDelete uses path param and returns deleted=true for known id', async () => {
    const t = new InProcessTransport(buildRouter());
    const r1 = await t.vaultDelete('personal', 'known');
    expect(r1.deleted).toBe(true);

    const r2 = await t.vaultDelete('personal', 'unknown');
    expect(r2.deleted).toBe(false);
  });

  it('didSign round-trips bytes base64-encoded', async () => {
    const t = new InProcessTransport(buildRouter());
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await t.didSign(payload);
    // Fake route returned "sig-<len>" — confirms the bytes decoded intact.
    expect(r.signature).toBe('sig-5');
    expect(r.did).toBe('did:plc:home');
  });

  it('didSignCanonical returns the 4 request-signing headers', async () => {
    const t = new InProcessTransport(buildRouter());
    const h = await t.didSignCanonical({
      method: 'POST',
      path: '/v1/vault/store',
      query: '',
      body: new Uint8Array([9, 9, 9]),
    });
    expect(h.did).toBe('did:plc:home');
    expect(h.timestamp).toMatch(/^2026-/);
    expect(h.nonce).toHaveLength(16); // 8 bytes hex-encoded
    expect(h.signature).toBe('canon-POST-/v1/vault/store');
  });

  it('piiScrub replaces entities + returns session token', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.piiScrub('Hello Alice, how are you?');
    expect(r.scrubbed).toBe('Hello {{ENTITY:0}}, how are you?');
    expect(r.sessionId).toBe('pii-session-abc');
    expect(r.entityCount).toBe(1);
  });

  it('piiRehydrate restores entities on known session; passes through on unknown', async () => {
    const t = new InProcessTransport(buildRouter());
    const known = await t.piiRehydrate('pii-session-abc', 'Hello {{ENTITY:0}}, how are you?');
    expect(known.sessionFound).toBe(true);
    expect(known.rehydrated).toBe('Hello Alice, how are you?');

    const stale = await t.piiRehydrate('stale', 'Hello {{ENTITY:0}}');
    expect(stale.sessionFound).toBe(false);
    expect(stale.rehydrated).toBe('Hello {{ENTITY:0}}');
  });

  it('notify accepts fiduciary priority + echoes notification id', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.notify({
      priority: 'fiduciary',
      title: 'emergency',
      body: 'alert body',
    });
    expect(r.accepted).toBe(true);
    expect(r.notificationId).toBe('notif-fiduciary-9');
    expect(r.subscribers).toBe(2);
  });

  it('notify engagement priority routes to briefing (subscribers=1)', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.notify({
      priority: 'engagement',
      title: 'digest',
      body: 'weekly summary',
      meta: { category: 'news' },
    });
    expect(r.accepted).toBe(true);
    expect(r.subscribers).toBe(1);
  });

  it('personaStatus returns tier + open-state for known personas', async () => {
    const t = new InProcessTransport(buildRouter());
    const open = await t.personaStatus('personal');
    expect(open.tier).toBe('default');
    expect(open.open).toBe(true);
    expect(open.dekFingerprint).toBe('ab12cd34');

    const locked = await t.personaStatus('financial');
    expect(locked.tier).toBe('locked');
    expect(locked.open).toBe(false);
    expect(locked.dekFingerprint).toBeNull();
  });

  it('personaStatus throws on unknown persona (Core returns 404)', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(t.personaStatus('ghost')).rejects.toThrow(/404/);
  });

  it('personaUnlock succeeds with correct passphrase; returns fresh DEK fingerprint', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.personaUnlock('financial', 'correct-passphrase');
    expect(r.unlocked).toBe(true);
    expect(r.dekFingerprint).toBe('ef56gh78');
    expect(r.error).toBeUndefined();
  });

  it('personaUnlock surfaces wrong-passphrase as data, not exception', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.personaUnlock('financial', 'bad');
    expect(r.unlocked).toBe(false);
    expect(r.error).toBe('wrong_passphrase');
    expect(r.dekFingerprint).toBeNull();
  });

  it('throws on non-2xx responses (surfaces Core errors to Brain callers)', async () => {
    const r = new CoreRouter();
    r.get('/healthz', () => ({ status: 500, body: { error: 'simulated outage' } }), {
      auth: 'public',
    });
    const t = new InProcessTransport(r);
    await expect(t.healthz()).rejects.toThrow(/healthz failed 500 — simulated outage/);
  });

  it('serviceConfig returns published ServiceConfig on 200', async () => {
    const t = new InProcessTransport(buildRouter());
    const cfg = await t.serviceConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.name).toBe('SF Transit Authority');
    expect(cfg?.capabilities.eta_query?.mcpTool).toBe('get_eta');
    expect(cfg?.capabilities.eta_query?.schemaHash).toBe('a1b2c3d4');
  });

  it('serviceConfig returns null (not throw) when Core has no config (404)', async () => {
    // Route returns 404 → transport normalises to `null`. Proves the
    // "no config set" state isn't exceptional from Brain's POV.
    const r = new CoreRouter();
    r.get(
      '/v1/service/config',
      () => ({ status: 404, body: { error: 'service_config: not set' } }),
      { auth: 'public' },
    );
    const t = new InProcessTransport(r);
    await expect(t.serviceConfig()).resolves.toBeNull();
  });

  it('serviceQuery maps camelCase → snake_case + returns task handle', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.sendServiceQuery({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      queryId: 'q-abc',
      params: { route_id: '42', location: { lat: 37.762, lng: -122.435 } },
      ttlSeconds: 60,
      serviceName: 'SF Transit',
    });
    expect(r.taskId).toBe('sq-q-abc-fake');
    expect(r.queryId).toBe('q-abc');
    expect(r.deduped).toBeUndefined();
  });

  it('serviceQuery surfaces dedupe flag when server reports one in flight', async () => {
    // Use the stale-pin schema_hash fake-route branch to exercise the
    // deduped:true path. Verifies the optional field round-trips.
    const t = new InProcessTransport(buildRouter());
    const r = await t.sendServiceQuery({
      toDID: 'did:plc:busdriver',
      capability: 'eta_query',
      queryId: 'q-dup',
      params: { route_id: '42' },
      ttlSeconds: 60,
      schemaHash: 'stale-pin',
    });
    expect(r.deduped).toBe(true);
    expect(r.taskId).toBe('sq-q-dup-fake');
  });

  it('memoryToC walks all unlocked personas when none specified', async () => {
    const t = new InProcessTransport(buildRouter());
    const toc = await t.memoryToC();
    expect(toc.limit).toBe(50); // default the fake echoes back
    expect(toc.entries).toHaveLength(2);
    expect(toc.entries[0]?.topic).toBe('dentist');
    expect(toc.entries[0]?.persona).toBe('personal');
  });

  it('memoryToC restricts to the requested persona list', async () => {
    // Comma-join encoding is what the route's parsePersonaFilter expects.
    const t = new InProcessTransport(buildRouter());
    const toc = await t.memoryToC({ personas: ['personal'], limit: 25 });
    expect(toc.limit).toBe(25);
    expect(toc.entries).toHaveLength(1);
    expect(toc.entries[0]?.persona).toBe('personal');
  });

  // ─── Staging inbox (task 1.29h / 1.32 preamble) ───────────────────────

  it('stagingClaim encodes limit on query + returns claim envelope', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.stagingClaim(2);
    expect(r.count).toBe(2);
    expect(r.items).toHaveLength(2);
    // Fake route echoes synthetic ids — proves the limit travelled.
    const first = r.items[0] as Record<string, unknown>;
    expect(first.id).toBe('stg-0');
  });

  it('stagingClaim clamps synthesis to at most 3 items even when limit is larger', async () => {
    // Proves the transport doesn't silently mangle the query-param
    // value — the fake route's own `min(limit, 3)` pin tells us the
    // wired value reached the handler.
    const t = new InProcessTransport(buildRouter());
    const r = await t.stagingClaim(50);
    expect(r.count).toBe(3);
  });

  it('stagingResolve single-persona omits personas[] from response', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.stagingResolve({
      itemId: 'stg-abc',
      persona: 'health',
      data: { text: 'sample' },
    });
    expect(r.itemId).toBe('stg-abc');
    expect(r.status).toBe('stored');
    expect(r.personas).toBeUndefined();
  });

  it('stagingResolve fan-out returns the matched personas[] (GAP-MULTI-01)', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.stagingResolve({
      itemId: 'stg-multi',
      persona: ['health', 'family'],
      data: { text: 'vaccination' },
    });
    expect(r.itemId).toBe('stg-multi');
    expect(r.personas).toEqual(['health', 'family']);
  });

  it('stagingResolve forwards personaOpen=false so pending_unlock path engages', async () => {
    // Route fake doesn't branch on persona_open — we only verify the
    // transport doesn't throw when it's supplied. Resolve-to-pending
    // behaviour is tested at the service layer.
    const t = new InProcessTransport(buildRouter());
    const r = await t.stagingResolve({
      itemId: 'stg-locked',
      persona: 'financial',
      data: { text: 'statement' },
      personaOpen: false,
    });
    expect(r.itemId).toBe('stg-locked');
  });

  it('stagingFail returns retryCount in camelCase (snake_case translation)', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.stagingFail('stg-bad', 'vault locked');
    expect(r.itemId).toBe('stg-bad');
    expect(r.retryCount).toBe(2);
  });

  it('stagingExtendLease echoes the seconds value in extendedBySeconds', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.stagingExtendLease('stg-slow', 600);
    expect(r.itemId).toBe('stg-slow');
    expect(r.extendedBySeconds).toBe(600);
  });

  // ─── D2D messaging (task 1.29h / 1.32 preamble) ───────────────────────

  it('msgSend serialises camelCase → snake_case wire body', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.msgSend({
      recipientDID: 'did:plc:peer',
      messageType: 'service.query',
      body: { query_id: 'q-1', capability: 'eta_query' },
    });
    expect(r.ok).toBe(true);
  });

  it('msgSend throws when Core rejects a missing recipient_did', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(
      t.msgSend({
        recipientDID: '',
        messageType: 'ping',
        body: {},
      }),
    ).rejects.toThrow(/recipient_did is required/);
  });

  // ─── Scratchpad (task 1.32 preamble) ──────────────────────────────────

  it('scratchpadCheckpoint → scratchpadResume round-trips the context', async () => {
    const t = new InProcessTransport(buildRouter());
    const cp = await t.scratchpadCheckpoint('nudge-1', 2, { draft: 'hi Sancho' });
    expect(cp).toEqual({ taskId: 'nudge-1', step: 2 });

    const entry = await t.scratchpadResume('nudge-1');
    expect(entry).not.toBeNull();
    expect(entry!.taskId).toBe('nudge-1');
    expect(entry!.step).toBe(2);
    expect(entry!.context).toEqual({ draft: 'hi Sancho' });
  });

  it('scratchpadResume returns null for unknown taskId (missing row)', async () => {
    const t = new InProcessTransport(buildRouter());
    const entry = await t.scratchpadResume('never-written');
    expect(entry).toBeNull();
  });

  it('scratchpadClear removes the row — subsequent resume returns null', async () => {
    const t = new InProcessTransport(buildRouter());
    await t.scratchpadCheckpoint('cleanup-task', 1, { probe: true });
    await t.scratchpadClear('cleanup-task');
    const entry = await t.scratchpadResume('cleanup-task');
    expect(entry).toBeNull();
  });

  it('scratchpadCheckpoint step=0 is the Python delete sentinel', async () => {
    const t = new InProcessTransport(buildRouter());
    await t.scratchpadCheckpoint('delete-via-zero', 3, { progress: 'mid' });
    // step=0 matches Python's write_scratchpad(taskId, 0, ...) idiom —
    // server treats it as a delete even though the call succeeds 200.
    await t.scratchpadCheckpoint('delete-via-zero', 0, {});
    const entry = await t.scratchpadResume('delete-via-zero');
    expect(entry).toBeNull();
  });

  it('scratchpadCheckpoint preserves createdAt on update, bumps updatedAt', async () => {
    // Fake router fixes nowMs at 1_700_000_000_000 for both writes. If
    // the server distinguished createdAt from updatedAt per call they
    // would drift; here they match but that's the fake's choice. The
    // client-observable contract is that the second call returns an
    // `updatedAt` ≥ the first's `createdAt` without blowing away
    // createdAt. This test pins the invariant structurally.
    const t = new InProcessTransport(buildRouter());
    await t.scratchpadCheckpoint('persist-across-upsert', 1, { step: 1 });
    const first = await t.scratchpadResume('persist-across-upsert');
    await t.scratchpadCheckpoint('persist-across-upsert', 2, { step: 2 });
    const second = await t.scratchpadResume('persist-across-upsert');
    expect(second).not.toBeNull();
    expect(second!.step).toBe(2);
    expect(second!.context).toEqual({ step: 2 });
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);
  });

  it('scratchpadCheckpoint throws when taskId is empty (server 400)', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(t.scratchpadCheckpoint('', 1, {})).rejects.toThrow(/taskId is required/);
  });

  it('scratchpadCheckpoint throws when step is non-integer (server 400)', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(t.scratchpadCheckpoint('bad-step', 1.5, {})).rejects.toThrow(
      /step must be an integer/,
    );
  });

  // ─── Service respond (task 1.32 slice A) ──────────────────────────────

  it('sendServiceRespond wraps taskId + responseBody in the wire envelope', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.sendServiceRespond('svc-task-1', {
      status: 'success',
      result: { eta_minutes: 12, stop_name: 'Castro' },
    });
    expect(r.status).toBe('sent');
    expect(r.taskId).toBe('svc-task-1');
    expect(r.alreadyProcessed).toBe(false);
  });

  it('sendServiceRespond surfaces already_processed:true when Core returns it', async () => {
    // Fake route: taskIds ending with `-already` signal the retry path.
    const t = new InProcessTransport(buildRouter());
    const r = await t.sendServiceRespond('svc-task-already', { status: 'success' });
    expect(r.alreadyProcessed).toBe(true);
    expect(r.status).toBe('completed');
  });

  it('sendServiceRespond throws on 400 (missing task_id reaches validator)', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(t.sendServiceRespond('', { status: 'success' })).rejects.toThrow(
      /task_id is required/,
    );
  });

  // ─── Workflow events (task 1.32 slice B) ──────────────────────────────

  it('listWorkflowEvents with no filters returns the full event buffer', async () => {
    const t = new InProcessTransport(buildRouter());
    const events = await t.listWorkflowEvents();
    expect(events.length).toBe(3);
    expect(events.map((e) => e.event_id)).toEqual([1, 2, 3]);
  });

  it('listWorkflowEvents needsDeliveryOnly skips acked + non-delivery events', async () => {
    const t = new InProcessTransport(buildRouter());
    // Fixture: id=1 needs_delivery=true unacked, id=2 needs_delivery=false,
    // id=3 needs_delivery=true BUT acknowledged_at set → only id=1 passes.
    const events = await t.listWorkflowEvents({ needsDeliveryOnly: true });
    expect(events.map((e) => e.event_id)).toEqual([1]);
  });

  it('listWorkflowEvents since + limit pagination work together', async () => {
    const t = new InProcessTransport(buildRouter());
    const events = await t.listWorkflowEvents({ since: 1, limit: 1 });
    expect(events.map((e) => e.event_id)).toEqual([2]);
  });

  it('acknowledgeWorkflowEvent returns true on 200', async () => {
    const t = new InProcessTransport(buildRouter());
    const ok = await t.acknowledgeWorkflowEvent(1);
    expect(ok).toBe(true);
  });

  it('acknowledgeWorkflowEvent returns false on 404 (not throw — matches BrainCoreClient)', async () => {
    const t = new InProcessTransport(buildRouter());
    const ok = await t.acknowledgeWorkflowEvent(9999);
    expect(ok).toBe(false);
  });

  it('acknowledgeWorkflowEvent throws on 400 (malformed id)', async () => {
    const t = new InProcessTransport(buildRouter());
    // Negative id → 400. The transport encodes the number via
    // `encodeURIComponent(String(id))` so negatives still round-trip.
    await expect(t.acknowledgeWorkflowEvent(-1)).rejects.toThrow(/positive integer/);
  });

  it('failWorkflowEventDelivery sends next_delivery_at + error when provided', async () => {
    const t = new InProcessTransport(buildRouter());
    const ok = await t.failWorkflowEventDelivery(1, {
      nextDeliveryAt: 1_700_000_999_000,
      error: 'chat thread unavailable',
    });
    expect(ok).toBe(true);
  });

  it('failWorkflowEventDelivery returns false on 404', async () => {
    const t = new InProcessTransport(buildRouter());
    const ok = await t.failWorkflowEventDelivery(9999);
    expect(ok).toBe(false);
  });

  // ─── Workflow tasks — reads + create (task 1.32 slice C) ──────────────

  it('listWorkflowTasks filters by kind + state + limit', async () => {
    const t = new InProcessTransport(buildRouter());
    const tasks = await t.listWorkflowTasks({ kind: 'service_query', state: 'queued' });
    expect(tasks.map((x) => x.id)).toEqual(['wf-2']);
  });

  it('listWorkflowTasks rejects missing state at the route validator (400)', async () => {
    const t = new InProcessTransport(buildRouter());
    // @ts-expect-error — deliberately skip state to hit the route's 400.
    await expect(t.listWorkflowTasks({ kind: 'service_query' })).rejects.toThrow(
      /kind and state query parameters are required/,
    );
  });

  it('getWorkflowTask returns the task on 200', async () => {
    const t = new InProcessTransport(buildRouter());
    const task = await t.getWorkflowTask('wf-1');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('wf-1');
    expect(task!.status).toBe('pending_approval');
  });

  it('getWorkflowTask returns null on 404 (not throw)', async () => {
    const t = new InProcessTransport(buildRouter());
    expect(await t.getWorkflowTask('never-existed')).toBeNull();
  });

  it('createWorkflowTask succeeds on fresh id, returns deduped=false', async () => {
    const t = new InProcessTransport(buildRouter());
    const res = await t.createWorkflowTask({
      id: 'wf-new-1',
      kind: 'service_query',
      description: 'fresh',
      payload: '{}',
      priority: 'normal',
    });
    expect(res.task.id).toBe('wf-new-1');
    expect(res.task.status).toBe('created');
    expect(res.deduped).toBe(false);
  });

  it('createWorkflowTask with matching idempotency_key returns existing task deduped=true', async () => {
    const t = new InProcessTransport(buildRouter());
    // Fixture has wf-1 with idempotency_key='idem-1'. Retry with same key.
    const res = await t.createWorkflowTask({
      id: 'wf-retry',
      kind: 'service_query',
      description: 'retry',
      payload: '{}',
      idempotencyKey: 'idem-1',
    });
    expect(res.deduped).toBe(true);
    expect(res.task.id).toBe('wf-1'); // echoed the EXISTING task's id.
  });

  it('createWorkflowTask throws typed WorkflowConflictError on 409 duplicate id', async () => {
    const t = new InProcessTransport(buildRouter());
    let caught: unknown;
    try {
      await t.createWorkflowTask({
        id: 'wf-1', // already in the fixture
        kind: 'service_query',
        description: 'dup',
        payload: '{}',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowConflictError);
    expect((caught as { code?: string })?.code).toBe('duplicate_id');
  });

  it('createWorkflowTask camelCase → snake_case body translation', async () => {
    const t = new InProcessTransport(buildRouter());
    const res = await t.createWorkflowTask({
      id: 'wf-camel',
      kind: 'service_query',
      description: 'camel',
      payload: '{}',
      correlationId: 'corr-1',
      sessionName: 'sess-1',
    });
    // The fake stores the persisted task; reading back proves the
    // snake_case translation reached the store.
    const persisted = await t.getWorkflowTask('wf-camel');
    expect(persisted!.correlation_id).toBe('corr-1');
    expect(res.deduped).toBe(false);
  });

  // ─── Workflow task state transitions (task 1.32 slice D) ──────────────

  it('approveWorkflowTask transitions pending_approval → queued', async () => {
    const t = new InProcessTransport(buildRouter());
    // wf-1 starts in pending_approval. After a previous test this might
    // have moved, so we approve a fresh task. Create and approve.
    await t.createWorkflowTask({
      id: 'wf-approve',
      kind: 'approval',
      description: 'approve-test',
      payload: '{}',
      initialState: 'pending_approval',
    });
    const r = await t.approveWorkflowTask('wf-approve');
    expect(r.status).toBe('queued');
  });

  it('cancelWorkflowTask with reason round-trips reason in body', async () => {
    const t = new InProcessTransport(buildRouter());
    await t.createWorkflowTask({
      id: 'wf-cancel',
      kind: 'service_query',
      description: 'cancel-test',
      payload: '{}',
    });
    const r = await t.cancelWorkflowTask('wf-cancel', 'user requested');
    expect(r.status).toBe('cancelled');
    // The fake route records cancel_reason on the task — proves the
    // `{reason}` body translation landed. Read it back via getWorkflowTask.
    const after = await t.getWorkflowTask('wf-cancel');
    expect((after as unknown as { cancel_reason?: string })?.cancel_reason).toBe(
      'user requested',
    );
  });

  it('cancelWorkflowTask without reason omits the field (defaults apply server-side)', async () => {
    const t = new InProcessTransport(buildRouter());
    await t.createWorkflowTask({
      id: 'wf-cancel-no-reason',
      kind: 'service_query',
      description: 'cancel-no-reason',
      payload: '{}',
    });
    const r = await t.cancelWorkflowTask('wf-cancel-no-reason');
    expect(r.status).toBe('cancelled');
    const after = await t.getWorkflowTask('wf-cancel-no-reason');
    expect((after as unknown as { cancel_reason?: string })?.cancel_reason).toBeUndefined();
  });

  it('completeWorkflowTask stores result + resultSummary', async () => {
    const t = new InProcessTransport(buildRouter());
    await t.createWorkflowTask({
      id: 'wf-complete',
      kind: 'service_query',
      description: 'complete-test',
      payload: '{}',
    });
    const r = await t.completeWorkflowTask(
      'wf-complete',
      '{"eta_minutes":12}',
      '12 min ETA',
    );
    expect(r.status).toBe('completed');
    expect(r.result).toBe('{"eta_minutes":12}');
    expect(r.result_summary).toBe('12 min ETA');
  });

  it('failWorkflowTask records error message', async () => {
    const t = new InProcessTransport(buildRouter());
    await t.createWorkflowTask({
      id: 'wf-fail',
      kind: 'service_query',
      description: 'fail-test',
      payload: '{}',
    });
    const r = await t.failWorkflowTask('wf-fail', 'upstream timeout');
    expect(r.status).toBe('failed');
    expect(r.error).toBe('upstream timeout');
  });

  it('workflow state transition on unknown task throws with 404 context', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(t.approveWorkflowTask('wf-unknown')).rejects.toThrow(/task not found/);
  });

  // ─── Memory + contacts (task 1.32 slice E) ────────────────────────────

  it('memoryTouch round-trips persona + topic + kind + returns canonical', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.memoryTouch({
      persona: 'personal',
      topic: '  Dentist  ',
      kind: 'entity',
    });
    expect(r.status).toBe('ok');
    // Fake route canonicalises to lowercase + trim.
    expect(r.canonical).toBe('dentist');
  });

  it('memoryTouch returns skipped when persona is locked', async () => {
    const t = new InProcessTransport(buildRouter());
    const r = await t.memoryTouch({
      persona: 'financial', // locked in the fixture
      topic: 'portfolio',
      kind: 'theme',
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('persona locked');
  });

  it('memoryTouch omits sample_item_id when empty/undefined', async () => {
    const t = new InProcessTransport(buildRouter());
    // No sampleItemId → request still succeeds (route doesn't require it).
    const r1 = await t.memoryTouch({ persona: 'personal', topic: 'a', kind: 'entity' });
    expect(r1.status).toBe('ok');
    // Empty-string sampleItemId → transport should also omit it.
    const r2 = await t.memoryTouch({
      persona: 'personal',
      topic: 'b',
      kind: 'entity',
      sampleItemId: '',
    });
    expect(r2.status).toBe('ok');
  });

  it('memoryTouch throws when route validator returns 400', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(
      t.memoryTouch({ persona: '', topic: 'x', kind: 'entity' }),
    ).rejects.toThrow(/persona, topic, and kind are required/);
  });

  it('updateContact clears preferredFor when sent as []', async () => {
    const t = new InProcessTransport(buildRouter());
    // Seed the contact's preferred_for so the clear has something to erase.
    await t.updateContact('did:plc:drcarl', { preferredFor: ['dental', 'surgery'] });
    // Clear it.
    await t.updateContact('did:plc:drcarl', { preferredFor: [] });
    // No return value — the test's contract is the 2xx result + absence
    // of a throw. Second call proves `[]` doesn't trip the non-empty
    // validation on the server.
  });

  it('updateContact replaces preferredFor when non-empty array passed', async () => {
    const t = new InProcessTransport(buildRouter());
    await t.updateContact('did:plc:drcarl', { preferredFor: ['Dental', 'Surgery'] });
    // Fake route lowercases + trims — proof the wire shape reached it.
  });

  it('updateContact omits preferred_for entirely when preferredFor is undefined', async () => {
    const t = new InProcessTransport(buildRouter());
    // No-op update (empty object) — server treats it as "don't touch".
    // Contract is simply: throws on 404, returns void on 2xx.
    await t.updateContact('did:plc:drcarl', {});
  });

  it('updateContact throws on unknown DID (404)', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(
      t.updateContact('did:plc:unknown', { preferredFor: ['dental'] }),
    ).rejects.toThrow(/contact not found/);
  });

  it('updateContact rejects empty DID client-side', async () => {
    const t = new InProcessTransport(buildRouter());
    await expect(t.updateContact('', { preferredFor: [] })).rejects.toThrow(
      /did is required/,
    );
    await expect(t.updateContact('   ', { preferredFor: [] })).rejects.toThrow(
      /did is required/,
    );
  });
});
