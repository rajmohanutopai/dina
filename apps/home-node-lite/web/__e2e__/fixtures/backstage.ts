/**
 * Backstage — the direct-API side channel (docs/E2E_TESTING.md §8).
 *
 * The human-visible behavior under test is ALWAYS driven through the
 * browser. Backstage is used ONLY for the two things a single browser
 * cannot do:
 *   1. Preconditions a person can't stage in one browser (seed a peer's
 *      outbound message, pre-populate a relationship).
 *   2. Asserting the INVISIBLE — vault contents, the audit trail, the
 *      negative "no approval task was created", the export archive.
 *
 * It talks to Core's `POST /v1/debug/dispatch` (registered only under
 * `DINA_DEBUG_MODE=1`, loopback-only, refuses release endpoints, runs any
 * Core route as the in-process OWNER with auth bypassed). Never use it to
 * PERFORM the behavior under test — that would test the router, not the
 * product.
 *
 * NB: this hits Core directly (`:18298`), not Brain (`:18299`) — Brain is
 * where the browser goes; Core is where state lives.
 */

const CORE_PORT = Number(process.env.DINA_CORE_E2E_PORT ?? 18298);
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const DEBUG_TOKEN = process.env.DINA_DEBUG_TOKEN ?? '';

export interface DispatchResult {
  /** HTTP status the Core router returned for the wrapped request. */
  status: number;
  /** The wrapped response body (already JSON-parsed by Core). */
  body: unknown;
}

export interface DispatchOptions {
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

/**
 * Run any Core route as the owner. Returns `{ status, body }` where
 * `status` is the WRAPPED ROUTE's HTTP status and `body` is its response
 * body. Does not throw on a non-2xx route status (use `dispatchOk` for
 * that) — only on a genuine transport failure (Core unreachable).
 *
 * Verified against the live handler (`debug_dispatch.ts:123`,
 * `reply.code(res.status).send(res.body)`): the outer HTTP status equals
 * the route status, and the response body IS the route body — NOT a
 * `{ status, body }` envelope (the handler's doc header is stale).
 */
export async function dispatch(
  method: string,
  path: string,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  let res: Response;
  try {
    res = await fetch(`${CORE_URL}/v1/debug/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(DEBUG_TOKEN !== '' ? { 'x-debug-token': DEBUG_TOKEN } : {}),
      },
      body: JSON.stringify({
        method,
        path,
        ...(opts.query !== undefined ? { query: opts.query } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      }),
    });
  } catch (err) {
    throw new Error(
      `backstage: cannot reach debug-dispatch at ${CORE_URL} (${String(err)}). ` +
        `Is core-server booted with DINA_DEBUG_MODE=1?`,
    );
  }
  const text = await res.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

/** Same as `dispatch`, but also asserts the wrapped route returned 2xx —
 *  for seeding steps where a non-2xx means the seed did not take. */
export async function dispatchOk(
  method: string,
  path: string,
  opts: DispatchOptions = {},
): Promise<unknown> {
  const { status, body } = await dispatch(method, path, opts);
  if (status < 200 || status >= 300) {
    throw new Error(
      `backstage: ${method} ${path} returned ${status} (expected 2xx): ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body;
}

/**
 * A vault item as `/v1/vault/list` returns it (verified against a live
 * Core). The searchable text is in `body` / `summary` — NOT a `content`
 * field (there is none on the wire). `type` carries the kind (`note`, …).
 */
export interface VaultItem {
  id: string;
  type?: string;
  body?: string;
  summary?: string;
  [k: string]: unknown;
}

/**
 * List a persona's vault items (invisible-assertion helper: confirm
 * `/remember` routed a fact to the right vault). Uses the vault list
 * route; the exact request/response shape is Core's — kept permissive and
 * narrowed at the call site.
 */
export async function listVault(persona: string, limit = 100): Promise<VaultItem[]> {
  // The route defaults limit to 20 (hard cap 100); pass an explicit limit
  // so callers don't silently see only the first page.
  const body = (await dispatchOk('GET', '/v1/vault/list', { query: { persona, limit } })) as
    | { items?: VaultItem[] }
    | VaultItem[]
    | undefined;
  if (Array.isArray(body)) return body;
  return body?.items ?? [];
}

/** Case-insensitive: does any item in `persona` contain `needle` in its
 *  body/summary? The invisible-assertion for "the fact routed here". */
export async function vaultHasText(persona: string, needle: string): Promise<boolean> {
  const n = needle.toLowerCase();
  const items = await listVault(persona);
  return items.some((it) =>
    [it.body, it.summary, it.type].some((f) => typeof f === 'string' && f.toLowerCase().includes(n)),
  );
}

/** Find which persona (of a candidate set) contains `needle`, or null. */
export async function personaContaining(
  personas: string[],
  needle: string,
): Promise<string | null> {
  for (const p of personas) {
    if (await vaultHasText(p, needle)) return p;
  }
  return null;
}

/**
 * Poll `personaContaining` until it resolves or the timeout elapses. The
 * `/remember` "Stored" ack appears BEFORE the async staging → drain → vault
 * write completes, so an immediate check can miss a just-remembered fact
 * (especially under load). Returns the persona, or null on timeout.
 */
export async function waitForPersonaContaining(
  personas: string[],
  needle: string,
  { timeoutMs = 20_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await personaContaining(personas, needle);
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const DEFAULT_PERSONAS = ['general', 'health', 'finance', 'work'];

/**
 * Clear every item from the given personas — a clean vault per test.
 * The functional stack shares ONE Core vault across the run, so without
 * this the tests accumulate each other's facts (and the brain's working
 * state), which both pollutes assertions and, at volume, stalls the
 * remember pipeline. Called at the start of the human_session fixture.
 */
export async function resetVault(personas: string[] = DEFAULT_PERSONAS): Promise<void> {
  for (const persona of personas) {
    // Drain until empty — a single list() only sees one page (up to 100),
    // and delete is a soft-delete that removes items from subsequent lists,
    // so the loop terminates. A hard cap guards against a delete that
    // doesn't actually remove the row (would otherwise spin forever).
    for (let pass = 0; pass < 200; pass++) {
      const items = await listVault(persona);
      if (items.length === 0) break;
      for (const item of items) {
        const { status } = await dispatch('DELETE', `/v1/vault/item/${item.id}`, {
          query: { persona },
        });
        // 200 deleted or 404 already-gone are both fine; anything else is a bug.
        if (status !== 200 && status !== 404) {
          throw new Error(`backstage.resetVault: DELETE ${item.id} → ${status}`);
        }
      }
    }
  }
}

export interface WorkflowTaskSummary {
  id: string;
  kind: string;
  status: string;
  [k: string]: unknown;
}

/**
 * Approval tasks currently pending. The load-bearing use is the NEGATIVE
 * assertion: an owner-in-app flow must create ZERO approval tasks (§ MRS-01,
 * the "no approval card ever appears" invariant) — a SERVER-side check that
 * complements the UI card-count (which could read 0 from a render bug).
 *
 * Returns `null` when the workflow plane is not wired in this stack (the
 * route 404/503s without PDS provisioning) so callers can distinguish
 * "no tasks" from "cannot tell". With `null`, the UI card-count remains the
 * authoritative negative.
 */
export async function pendingApprovals(): Promise<WorkflowTaskSummary[] | null> {
  return approvalTasks('pending_approval');
}

/**
 * Approval tasks in a given workflow state. The list route REQUIRES both
 * `kind` and `state` (400 otherwise), so there is no "all states" list —
 * query the state you care about. Returns `null` when the workflow plane
 * is not wired (no PDS provisioning → 404/503).
 */
export async function approvalTasks(
  state: string,
  kind = 'approval',
): Promise<WorkflowTaskSummary[] | null> {
  const { status, body } = await dispatch('GET', '/v1/workflow/tasks', {
    query: { kind, state },
  });
  if (status === 404 || status === 503 || status === 501) return null;
  if (status < 200 || status >= 300) {
    throw new Error(`backstage.approvalTasks(${state}): /v1/workflow/tasks → ${status}`);
  }
  return (body as { tasks?: WorkflowTaskSummary[] } | undefined)?.tasks ?? [];
}

export interface IntentDecision {
  /** auto_approve | deny | flag_for_review */
  action: string;
  requires_approval?: boolean;
  /** Present for flag_for_review (MODERATE / HIGH): the created task id. */
  proposal_id?: string;
  /** The risk band — the wire field is `risk` (AgentValidateResponse), NOT
   *  `risk_level`. */
  risk?: 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';
  reason?: string;
  [k: string]: unknown;
}

/**
 * Submit an agent intent to `/v1/agent/validate` — the SAME endpoint
 * `dina-agent` hits. This STAGES the precondition (an agent asking to act)
 * so the browser can drive the human decision; the gatekeeper, the created
 * approval task, and the owner-decision routes are all the real product
 * path. `agentDid` rides in the body (Core prefers X-DID when signature-
 * authed; backstage has none, so the body value is used).
 */
export async function stageAgentIntent(intent: {
  action: string;
  target?: string;
  agentDid: string;
  session: string;
  trustLevel?: string;
}): Promise<IntentDecision> {
  const body = await dispatchOk('POST', '/v1/agent/validate', {
    body: {
      type: 'agent_intent',
      action: intent.action,
      target: intent.target ?? '',
      agent_did: intent.agentDid,
      session: intent.session,
      ...(intent.trustLevel !== undefined ? { trust_level: intent.trustLevel } : {}),
    },
  });
  return body as IntentDecision;
}

/** Is a task with `id` currently in `state` (for the given kind)? List-based,
 *  since the path-param GET does not round-trip cleanly through debug-dispatch. */
export async function approvalTaskInState(
  id: string,
  state: string,
  kind = 'approval',
): Promise<boolean> {
  const tasks = await approvalTasks(state, kind);
  return (tasks ?? []).some((t) => t.id === id);
}

/**
 * The owner's APPROVE decision (`pending_approval → queued`). This is the
 * exact route the browser's Approve tap triggers (`approveWorkflowTask`);
 * it runs the real owner-decision guard + state transition. Used to drive
 * the approval STATE MACHINE where the limited-mode-web inbox can't yet
 * surface the card for a UI tap (see the MRS-08 open question).
 */
export async function ownerApprove(id: string): Promise<void> {
  await dispatchOk('POST', `/v1/workflow/tasks/${id}/approve`, { body: {} });
}

/** The owner's DENY decision (`pending_approval → cancelled`). Same route
 *  the browser's Deny tap triggers (`cancelWorkflowTask`). */
export async function ownerDeny(id: string): Promise<void> {
  await dispatchOk('POST', `/v1/workflow/tasks/${id}/cancel`, { body: {} });
}

/**
 * Cancel every pending approval task — a clean approval queue per test.
 * Workflow tasks live in Core's store (NOT the vault), so `resetVault`
 * doesn't clear them; without this, an agent test's leftover proposal would
 * make another test's "zero pending approvals" negative fail. No-op when the
 * workflow plane isn't wired.
 */
export async function resetApprovals(): Promise<void> {
  const pending = await approvalTasks('pending_approval');
  if (pending === null) return;
  for (const task of pending) {
    await dispatch('POST', `/v1/workflow/tasks/${task.id}/cancel`, { body: {} });
  }
}
