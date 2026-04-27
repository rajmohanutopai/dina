/**
 * `createCoordinatorAskHandler` — bridges `AskCoordinator` (5.21-F)
 * back to the chat orchestrator's `AskCommandHandler` shape so mobile
 * builds can route `/ask` through the full Pattern A chain.
 *
 * **Why this shim exists**: the chat orchestrator's
 * `AskCommandHandler` is `(query) => Promise<{response, sources}>` —
 * a synchronous request/response shape. The coordinator's
 * `handleAsk` returns one of:
 *   - `fast_path` 200 + complete → final answer ready
 *   - `fast_path` 200 + pending_approval → operator must approve;
 *     answer arrives later via the resumer
 *   - `async` 202 → answer arrives later via background execution
 *
 * For pending/async outcomes the chat thread needs a deferred
 * delivery: the placeholder response goes back to the orchestrator
 * immediately so the user sees acknowledgement, then when the
 * registry transitions to `complete` (or `failed`) we append the
 * real answer via `addDinaResponse` on the same chat thread.
 *
 * **Subscription scope**: the bridge subscribes to the
 * `AskRegistry`'s event stream once at construction. Each pending ask
 * is tracked in an in-memory map keyed by `askId`; when a `completed`
 * or `failed` event fires for a tracked id, the bridge emits the
 * deferred message and removes the tracking entry. Untracked ids
 * (e.g. asks submitted by other paths) are ignored.
 *
 * **Multi-thread**: the chat orchestrator passes the originating
 * thread id through `AskCommandContext` on every call. The bridge
 * captures that per-ask in its tracking map and uses it on late
 * delivery, so a `/ask` from `/health` and one from `/work` post
 * their resumed answers back to their own threads. The constructor's
 * `defaultThreadId` is only the fallback for callers that ignore the
 * context (e.g. legacy tests that call `askHandler(query)` directly).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md task 5.21-H.
 */

import {
  addDinaResponse,
  addLifecycleMessage,
  addMessage,
  addSystemMessage,
  findMessageByTaskId,
  type ServiceQueryLifecycle,
} from '../chat/thread';
import type { AskCommandHandler } from '../chat/orchestrator';
import type { AskCoordinator } from './ask_coordinator';
import type { AskFailure } from '../ask/ask_handler';
import { resetAskApprovalGateway, setAskApprovalGateway } from './ask_gateway_registry';

export interface CreateCoordinatorAskHandlerOptions {
  coordinator: AskCoordinator;
  /**
   * DID of the human user — every `/ask` from this device is
   * attributed to this DID. Mobile passes its own `did` from the
   * boot identity; brain-server callers might pass a request-derived
   * value if they ever consume this path.
   */
  requesterDid: string;
  /**
   * Fallback thread id used when the orchestrator invokes the handler
   * WITHOUT an `AskCommandContext` (e.g. a legacy test that called
   * `askHandler(query)` directly). Production calls pass the user's
   * current thread through the context, so this default rarely fires.
   * Defaults to the chat orchestrator's `DEFAULT_THREAD` (`'main'`).
   */
  defaultThreadId?: string;
  /**
   * Renders the placeholder text the user sees when the ask transitions
   * to `pending_approval`. Defaults to a static prompt naming the
   * approval id; callers can override for a richer UI nudge.
   */
  formatPendingMessage?: (input: { approvalId: string; persona?: string }) => string;
  /**
   * Renders the late-arriving system note that frames the resumed
   * answer (e.g. "Operator approved. Here's the answer:"). Defaults
   * to silent — set to a function to add a header before the answer.
   */
  formatResumeHeader?: (input: { askId: string; approvalId: string }) => string | null;
  /**
   * Renders the late-arriving failure note (e.g. on operator denial
   * or LLM error). Defaults to a generic "/ask failed: <reason>".
   */
  formatFailureMessage?: (input: { failureKind: string; raw: AskFailure | string }) => string;
}

// Mirrors the orchestrator's own `DEFAULT_THREAD` constant. Kept as a
// local copy because the orchestrator doesn't export it; if it ever
// does, switch to the imported value.
const DEFAULT_THREAD = 'main';

interface PendingTracking {
  approvalId: string | undefined;
  persona: string | undefined;
  /** Thread id captured from the ask's originating chat call. */
  threadId: string;
}

/**
 * Build the chat-orchestrator-shaped `AskCommandHandler` backed by an
 * `AskCoordinator`. Returns the handler — install via
 * `setAskCommandHandler(handler)`.
 *
 * **Returns**: an opaque object with `handler` (for
 * `setAskCommandHandler`) and `dispose()` (cleanup the registry
 * subscription on shutdown). Callers that don't need cleanup can
 * destructure just the handler.
 */
export function createCoordinatorAskHandler(opts: CreateCoordinatorAskHandlerOptions): {
  handler: AskCommandHandler;
  dispose: () => void;
} {
  if (!opts || !opts.coordinator) {
    throw new TypeError('createCoordinatorAskHandler: coordinator is required');
  }
  if (typeof opts.requesterDid !== 'string' || opts.requesterDid.trim() === '') {
    throw new TypeError('createCoordinatorAskHandler: requesterDid must be non-empty');
  }

  const { coordinator, requesterDid } = opts;
  const defaultThreadId = opts.defaultThreadId ?? DEFAULT_THREAD;
  const formatPending =
    opts.formatPendingMessage ??
    (({ approvalId, persona }): string => {
      const p = persona ? ` /${persona}` : '';
      return `I need your approval to read${p}. Approve with: /approve ${approvalId}`;
    });
  const formatHeader = opts.formatResumeHeader ?? null;
  const formatFailure =
    opts.formatFailureMessage ??
    (({ failureKind, raw }): string => {
      const detail =
        typeof raw === 'object' && raw !== null && 'message' in raw
          ? String(raw.message)
          : typeof raw === 'string'
            ? raw
            : failureKind;
      return `/ask failed: ${detail}`;
    });

  // askId → tracked metadata. Populated when handleAsk returns
  // pending_approval; cleaned when the deferred event fires (or when
  // we observe a terminal status outside our tracking flow).
  const pending = new Map<string, PendingTracking>();

  // Install the gateway singleton so the chat-tab approval card's
  // Approve/Deny buttons can drive the full Pattern A resume chain
  // (gateway approves the source AND triggers the registry's
  // resumeAfterApproval). Cleared in `dispose()` below.
  setAskApprovalGateway(coordinator.gateway);

  // Subscribe to the coordinator's event fan-out. The same stream
  // feeds the resumer (the coordinator wires its registry's onEvent →
  // resumer.handle then dispatches to subscribers), so we get
  // notified after the resumer settles the ask. We layer on top —
  // never block, never throw. Fan-out is provided by the coordinator
  // because the underlying `AskRegistry.onEvent` is a single
  // constructor callback already bound to the resumer.
  const unsubscribe = coordinator.subscribe((event) => {
    if (event.kind !== 'completed' && event.kind !== 'failed' && event.kind !== 'expired') {
      return;
    }
    const tracking = pending.get(event.id);
    if (!tracking) return; // not ours
    pending.delete(event.id);

    void deliverDeferred(event.id, tracking).catch(() => {
      /* swallow — chat-thread writes are best-effort */
    });
  });

  async function deliverDeferred(askId: string, tracking: PendingTracking): Promise<void> {
    const record = await coordinator.registry.get(askId);
    if (record === null) return;
    const targetThread = tracking.threadId;

    if (record.status === 'complete' && record.answerJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.answerJson);
      } catch {
        parsed = record.answerJson;
      }
      const answerText = extractAnswerText(parsed);
      const serviceQueries = extractServiceQueries(parsed);

      if (formatHeader !== null && tracking.approvalId !== undefined) {
        const header = formatHeader({ askId, approvalId: tracking.approvalId });
        if (header !== null && header !== '') addSystemMessage(targetThread, header);
      }

      // Service-query dispatches: post one lifecycle-tracked dina
      // message per dispatch (status `pending` if no workflow event has
      // landed yet; otherwise the deliver path already posted/patched
      // it — this branch becomes a no-op via `findMessageByTaskId`).
      // Suppresses the LLM narrative for this turn since the cards
      // carry the user-facing message (the narrative is typically just
      // "I have sent a request — will follow up", which is redundant
      // with the spinner state).
      if (serviceQueries.length > 0) {
        for (const sq of serviceQueries) {
          if (findMessageByTaskId(targetThread, sq.taskId) !== null) continue;
          const lifecycle: ServiceQueryLifecycle = {
            kind: 'service_query',
            status: 'pending',
            taskId: sq.taskId,
            queryId: sq.queryId,
            capability: sq.capability,
            serviceName: sq.serviceName,
          };
          addLifecycleMessage(targetThread, answerText, lifecycle);
        }
        return;
      }

      if (answerText !== '') {
        addDinaResponse(targetThread, answerText, []);
      }
      return;
    }

    if (record.status === 'failed' || record.status === 'expired') {
      const errPayload =
        record.errorJson !== undefined ? safeParse(record.errorJson) : { kind: record.status };
      const failureKind = extractFailureKind(errPayload, record.status);
      const text = formatFailure({
        failureKind,
        raw: errPayload as AskFailure | string,
      });
      addDinaResponse(targetThread, text, []);
      return;
    }
  }

  const handler: AskCommandHandler = async (query, context) => {
    // Capture the originating thread once per call. If the
    // orchestrator passed `AskCommandContext` (production path), use
    // it. Otherwise fall back to the constructor-supplied default
    // (legacy / direct invocation in tests).
    const callerThread = context?.threadId ?? defaultThreadId;
    let result;
    try {
      result = await coordinator.handleAsk({
        question: query,
        requesterDid,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { response: `/ask failed to submit: ${detail}`, sources: [] };
    }

    // Submission produced a terminal answer in the fast-path window.
    if (result.kind === 'fast_path' && result.body.status === 'complete') {
      const answer = result.body.answer ?? {};
      return { response: extractAnswerText(answer), sources: [] };
    }

    // Submission produced a terminal failure in the fast-path window.
    if (result.kind === 'fast_path' && result.body.status === 'failed') {
      const raw = result.body.error ?? {};
      const failureKind = extractFailureKind(raw, 'failed');
      return {
        response: formatFailure({ failureKind, raw: raw as AskFailure | string }),
        sources: [],
      };
    }

    // Submission entered pending_approval — track for deferred delivery
    // AND post an approval-typed message so the chat tab can render an
    // inline card instead of a plain text bubble.
    if (result.kind === 'fast_path' && result.body.status === 'pending_approval') {
      const approvalId = result.body.approval_id ?? '';
      const askId = result.body.request_id;
      const persona = extractPersonaFromApprovalId(approvalId);
      pending.set(askId, {
        approvalId,
        persona,
        threadId: callerThread,
      });
      const placeholder = formatPending({ approvalId, persona });
      // Write an `approval`-typed message into the originating thread.
      // Metadata carries everything the UI's inline card needs:
      //   - kind: 'ask_approval' lets the renderer disambiguate from
      //     service-approval cards (which use `kind: 'service_approval'`)
      //   - approvalId: passed back to `gateway.approve(...)` on tap
      //   - askId / persona: shown in the card preview
      // Returning the synchronous reply with EMPTY response keeps the
      // chat orchestrator from posting a duplicate `dina` bubble — the
      // approval card IS the user-facing reply for this turn.
      addMessage(callerThread, 'approval', placeholder, {
        metadata: {
          kind: 'ask_approval',
          askId,
          approvalId,
          persona,
          requesterDid,
        },
      });
      return { response: '', sources: [] };
    }

    // Submission timed out the fast-path window — answer arrives later
    // via the registry event stream. Track the id and acknowledge.
    if (result.kind === 'async') {
      pending.set(result.body.request_id, {
        approvalId: undefined,
        persona: undefined,
        threadId: callerThread,
      });
      return {
        response: "Working on it — I'll reply when the answer is ready.",
        sources: [],
      };
    }

    return { response: "I couldn't process that ask.", sources: [] };
  };

  const dispose = (): void => {
    unsubscribe();
    resetAskApprovalGateway();
  };

  return { handler, dispose };
}

function extractAnswerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  const v = value as Record<string, unknown>;
  if (typeof v.text === 'string') return v.text;
  if (typeof v.response === 'string') return v.response;
  if (typeof v.answer === 'string') return v.answer;
  return JSON.stringify(value);
}

function extractFailureKind(raw: unknown, fallback: string): string {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const v = raw as Record<string, unknown>;
  if (typeof v.kind === 'string') return v.kind;
  return fallback;
}

function extractPersonaFromApprovalId(approvalId: string): string | undefined {
  // Approval ids minted by `createPersonaGuard` use the deterministic
  // form `appr-<askId>-<persona>`. The persona is the LAST segment
  // when the askId itself contains hyphens. Use the rightmost segment
  // as a heuristic — falls through to undefined for non-derived ids.
  const m = approvalId.match(/^appr-.+-([^-]+)$/);
  return m ? m[1] : undefined;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Extract the `serviceQueries` array off the AskCoordinator's answer
 * payload (set by `translateLoopResult` when the agentic loop made
 * successful `query_service` tool calls). Defensive — any malformed
 * shape returns `[]` so the bridge falls back to the plain narrative
 * path.
 */
function extractServiceQueries(value: unknown): Array<{
  taskId: string;
  queryId: string;
  capability: string;
  serviceName: string;
}> {
  if (typeof value !== 'object' || value === null) return [];
  const v = value as Record<string, unknown>;
  const raw = v.serviceQueries;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ taskId: string; queryId: string; capability: string; serviceName: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.taskId !== 'string' || e.taskId === '') continue;
    out.push({
      taskId: e.taskId,
      queryId: typeof e.queryId === 'string' ? e.queryId : '',
      capability: typeof e.capability === 'string' ? e.capability : '',
      serviceName: typeof e.serviceName === 'string' ? e.serviceName : 'service',
    });
  }
  return out;
}
