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
  makeMissingCapabilityNotice,
  type AskCommandHandler,
  type MissingCapabilityNotice,
} from '../chat/orchestrator';
import {
  addDinaResponse,
  addLifecycleMessage,
  addMessage,
  addSystemMessage,
  findMessageByAskId,
  findMessageByTaskId,
  updateAskLifecycle,
  type ServiceQueryLifecycle,
} from '../chat/thread';
import {
  classifyProviderErrorKind,
  classifyProviderErrorMessage,
  GENERIC_PROVIDER_FAILURE_MESSAGE,
  providerErrorMessageForKind,
  type ProviderErrorKind,
} from '../llm/provider_error_classify';

import { resetAskApprovalGateway, setAskApprovalGateway } from './ask_gateway_registry';

import type { AskCoordinator } from './ask_coordinator';
import type { AskFailure } from '../ask/ask_handler';

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
  /**
   * Fired when an /ask fails on a CLASSIFIED provider error (credits
   * exhausted, invalid key, …). Lets the host surface the condition
   * outside the chat bubble — mobile feeds the Settings key-health
   * pill so it is already lit the moment chat hits the wall, instead
   * of waiting for the next Settings-visit probe. Best-effort: errors
   * thrown by the callback are swallowed.
   */
  onProviderFailure?: (input: { kind: ProviderErrorKind; message: string }) => void;
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
  /** Original user ask; used to recover capability empty states from async failures. */
  query: string;
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
    (({ failureKind, raw }: { failureKind: string; raw: AskFailure | string }): string => {
      switch (failureKind) {
        case 'provider_error': {
          // Prefer the STRUCTURED kind the loop attached
          // (failure.detail.providerErrorKind): the loop already turned the
          // raw error into a template, and re-classifying the TEMPLATE text
          // is lossy (its wording need not match the raw-error patterns —
          // that exact double-classification regressed the credits message
          // back to the generic apology).
          const structuredKind =
            typeof raw === 'object' && raw !== null
              ? (raw as AskFailure).detail?.providerErrorKind
              : undefined;
          if (typeof structuredKind === 'string') {
            return providerErrorMessageForKind(structuredKind as ProviderErrorKind);
          }
          // Otherwise surface the underlying error message when the loop
          // captured one (set by ask_coordinator.translateLoopResult). Run
          // it through `humaniseProviderError` so quota / rate-limit /
          // auth / timeout failures become user-friendly one-liners
          // with actionable next steps instead of raw vendor stack
          // traces (RetryError + docs URLs + nested wrappers).
          const detail =
            typeof raw === 'object' && raw !== null && 'message' in raw
              ? String((raw as { message: unknown }).message)
              : '';
          if (detail !== '' && !detail.startsWith('agentic loop terminated with')) {
            return humaniseProviderError(detail);
          }
          return 'I ran into a problem reaching the AI provider. Please try again in a moment.';
        }
        case 'max_iterations':
        case 'max_tool_calls':
          return "I wasn't able to complete this in the available steps. Try a simpler query.";
        case 'cancelled':
          return 'Your request was cancelled.';
        default: {
          const detail =
            typeof raw === 'object' && raw !== null && 'message' in raw
              ? String((raw as { message: unknown }).message)
              : typeof raw === 'string'
                ? raw
                : failureKind;
          return `/ask failed: ${detail}`;
        }
      }
    });

  // Best-effort host notification for CLASSIFIED provider failures
  // (credits exhausted / invalid key / …). Prefers the structured kind the
  // agentic loop attached (failure.detail.providerErrorKind); falls back to
  // re-classifying the failure MESSAGE so failures arriving via persisted
  // error_json (the async/deferred path round-trips through JSON and may
  // predate the kind field) still notify. Only called for
  // failureKind === 'provider_error' — never classify denial/cancel text.
  const notifyProviderFailure = (raw: AskFailure | string): void => {
    if (opts.onProviderFailure === undefined) return;
    try {
      let kind: ProviderErrorKind | null = null;
      let message = '';
      if (typeof raw === 'object' && raw !== null) {
        const m = (raw as { message?: unknown }).message;
        message = typeof m === 'string' ? m : '';
        const fromDetail = (raw as AskFailure).detail?.providerErrorKind;
        if (typeof fromDetail === 'string') kind = fromDetail as ProviderErrorKind;
      } else if (typeof raw === 'string') {
        message = raw;
      }
      if (kind === null && message !== '') kind = classifyProviderErrorKind(message);
      if (kind !== null) opts.onProviderFailure({ kind, message });
    } catch {
      // Best-effort — a host callback must never break the chat path.
    }
  };

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
    // True iff the bridge posted an `ask_pending` placeholder up
    // front (async-window deferral). In that case we patch the same
    // message in place so the user sees one bubble morphing from
    // "Working on it…" into the resolved answer, instead of two
    // stacked bubbles. False for pending_approval flows (the
    // approval card is already a distinct typed message; we still
    // append a fresh dina bubble below it for the answer).
    const hasAskPlaceholder = findMessageByAskId(targetThread, askId) !== null;

    if (record.status === 'complete' && record.answerJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.answerJson);
      } catch {
        parsed = record.answerJson;
      }
      const answerText = extractAnswerText(parsed);
      const serviceQueries = extractServiceQueries(parsed);
      const missingCapabilities = extractMissingCapabilities(parsed, tracking.query);

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
        // If a placeholder is sitting in the thread, retire it. We blank
        // its content (rather than swapping in the LLM narrative) so the
        // service-query card is the *single* user-facing artifact for the
        // turn — the narrative ("I'm checking the live ETA…") is redundant
        // with the card's own progress + result, and reads as clutter
        // above it. The empty placeholder renders nothing (the chat skips
        // empty dina rows). The user's own question already carries the
        // request context.
        if (hasAskPlaceholder) {
          updateAskLifecycle(targetThread, askId, { status: 'complete' }, '');
        }
        for (const sq of serviceQueries) {
          if (findMessageByTaskId(targetThread, sq.taskId) !== null) continue;
          const lifecycle: ServiceQueryLifecycle = {
            kind: 'service_query',
            status: 'pending',
            taskId: sq.taskId,
            queryId: sq.queryId,
            capability: sq.capability,
            serviceName: sq.serviceName,
            providerDid: sq.providerDid,
            params: sq.params,
          };
          addLifecycleMessage(targetThread, answerText, lifecycle);
        }
        return;
      }

      if (missingCapabilities.length > 0) {
        if (hasAskPlaceholder) {
          updateAskLifecycle(targetThread, askId, { status: 'complete' }, '');
        }
        postMissingCapabilityCards(targetThread, answerText, missingCapabilities);
        return;
      }

      if (hasAskPlaceholder) {
        // One-bubble morph — patch the placeholder content + status. Carry the
        // review-source provenance so the morphed (plain-bubble) row shows the pill.
        updateAskLifecycle(
          targetThread,
          askId,
          { status: 'complete' },
          answerText,
          reviewSourcesFor(parsed),
        );
      } else if (answerText !== '') {
        addDinaResponse(targetThread, answerText, reviewSourcesFor(parsed));
      }
      return;
    }

    if (record.status === 'failed' || record.status === 'expired') {
      const errPayload =
        record.errorJson !== undefined ? safeParse(record.errorJson) : { kind: record.status };
      const failureKind = extractFailureKind(errPayload, record.status);
      if (failureKind === 'provider_error') {
        notifyProviderFailure(errPayload as AskFailure | string);
      }
      const text = formatFailure({
        failureKind,
        raw: errPayload as AskFailure | string,
      });
      let missingCapabilities = extractMissingCapabilities(errPayload, tracking.query);
      if (missingCapabilities.length === 0) {
        missingCapabilities = missingCapabilitiesFromFailedAsk(
          tracking.query,
          failureKind,
          errPayload,
        );
      }
      if (missingCapabilities.length > 0) {
        if (hasAskPlaceholder) {
          updateAskLifecycle(targetThread, askId, { status: 'complete' }, '');
        }
        postMissingCapabilityCards(targetThread, text, missingCapabilities);
        return;
      }
      const status = record.status === 'failed' ? 'failed' : 'expired';
      if (hasAskPlaceholder) {
        updateAskLifecycle(targetThread, askId, { status, error: text }, text);
      } else {
        addDinaResponse(targetThread, text, []);
      }
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
        // Forced composer lane (Services/Reviews) — propagate so the coordinator's
        // executeFn enforces the lane (skip inference, scope tools, gate result).
        // Without this the production /ask path silently ran plain Ask behavior
        // for Services/Reviews (docs/COMPOSER_MODES_DESIGN.md 6.5).
        ...(context?.forcedSources !== undefined && context.forcedSources.length > 0
          ? { forcedSources: context.forcedSources }
          : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { response: `/ask failed to submit: ${detail}`, sources: [] };
    }

    // Submission produced a terminal answer in the fast-path window.
    if (result.kind === 'fast_path' && result.body.status === 'complete') {
      const answer = result.body.answer ?? {};
      return {
        response: extractAnswerText(answer),
        sources: reviewSourcesFor(answer),
        // A service query can dispatch WITHIN the fast-path window — surface it
        // so the orchestrator posts the service_query lifecycle card (it reads
        // result.serviceQueries). The deferred/async path already does this;
        // omitting it here dropped the card on fast-path completions.
        serviceQueries: extractServiceQueries(answer),
        missingCapabilities: extractMissingCapabilities(answer, query),
      };
    }

    // Submission produced a terminal failure in the fast-path window.
    if (result.kind === 'fast_path' && result.body.status === 'failed') {
      const raw = result.body.error ?? {};
      const failureKind = extractFailureKind(raw, 'failed');
      if (failureKind === 'provider_error') {
        notifyProviderFailure(raw as AskFailure | string);
      }
      let missingCapabilities = extractMissingCapabilities(raw, query);
      if (missingCapabilities.length === 0) {
        missingCapabilities = missingCapabilitiesFromFailedAsk(query, failureKind, raw);
      }
      return {
        response: formatFailure({ failureKind, raw: raw as AskFailure | string }),
        sources: [],
        missingCapabilities,
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
        query,
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
    // via the registry event stream. Post an `ask_pending` placeholder
    // INTO the chat thread directly so the bridge owns the row it later
    // patches in place. Returning `response: ''` keeps the orchestrator
    // from posting a duplicate `dina` bubble (the orchestrator skips
    // empty handler responses — see chat/orchestrator.ts handleChat).
    if (result.kind === 'async') {
      const askId = result.body.request_id;
      pending.set(askId, {
        approvalId: undefined,
        persona: undefined,
        threadId: callerThread,
        query,
      });
      const placeholder = "Working on it — I'll reply when the answer is ready.";
      addLifecycleMessage(callerThread, placeholder, {
        kind: 'ask_pending',
        status: 'pending',
        askId,
      });
      return { response: '', sources: [] };
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

/**
 * The chat `sources` for a resolved answer — carries the `reviewsrc:<count>`
 * provenance token (set by the ask coordinator when network reviews informed the
 * answer) so the mobile dina bubble can render the "Ranked / Network reviews"
 * source pill. Empty when the answer used no network reviews.
 */
function reviewSourcesFor(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const token = (value as Record<string, unknown>).reviewSource;
  return typeof token === 'string' && token.length > 0 ? [token] : [];
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
function extractServiceQueries(value: unknown): {
  taskId: string;
  queryId: string;
  capability: string;
  serviceName: string;
  providerDid?: string;
  params?: Record<string, unknown>;
}[] {
  if (typeof value !== 'object' || value === null) return [];
  const v = value as Record<string, unknown>;
  const raw = v.serviceQueries;
  if (!Array.isArray(raw)) return [];
  const out: {
    taskId: string;
    queryId: string;
    capability: string;
    serviceName: string;
    providerDid?: string;
    params?: Record<string, unknown>;
  }[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.taskId !== 'string' || e.taskId === '') continue;
    out.push({
      taskId: e.taskId,
      queryId: typeof e.queryId === 'string' ? e.queryId : '',
      capability: typeof e.capability === 'string' ? e.capability : '',
      serviceName: typeof e.serviceName === 'string' ? e.serviceName : 'service',
      providerDid: typeof e.providerDid === 'string' ? e.providerDid : undefined,
      params:
        typeof e.params === 'object' && e.params !== null
          ? (e.params as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

function extractMissingCapabilities(
  value: unknown,
  fallbackQuery?: string,
): MissingCapabilityNotice[] {
  const raw = readMissingCapabilityArray(value);
  if (!Array.isArray(raw)) return [];

  const out: MissingCapabilityNotice[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let capability = '';
    let query = fallbackQuery;
    let noticeId = '';

    if (typeof entry === 'string') {
      capability = entry;
    } else if (typeof entry === 'object' && entry !== null) {
      const e = entry as Record<string, unknown>;
      capability = typeof e.capability === 'string' ? e.capability : '';
      if (typeof e.query === 'string' && e.query.trim() !== '') query = e.query;
      if (typeof e.noticeId === 'string') noticeId = e.noticeId;
    }

    const normalized = capability.trim();
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);

    const trimmedQuery = query?.trim();
    if (noticeId.trim() !== '') {
      out.push({
        noticeId: noticeId.trim(),
        capability: normalized,
        ...(trimmedQuery !== undefined && trimmedQuery !== '' ? { query: trimmedQuery } : {}),
      });
    } else {
      out.push(makeMissingCapabilityNotice(normalized, trimmedQuery));
    }
  }
  return out;
}

function readMissingCapabilityArray(value: unknown): unknown[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.missingCapabilities)) return v.missingCapabilities;
  const detail = v.detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const d = detail as Record<string, unknown>;
  return Array.isArray(d.missingCapabilities) ? d.missingCapabilities : null;
}

function missingCapabilitiesFromFailedAsk(
  query: string,
  failureKind: string,
  raw: unknown,
): MissingCapabilityNotice[] {
  if (!isCapabilityDiscoveryFailure(failureKind, raw)) return [];
  const capability = extractNamespacedCapability(query);
  return capability === null ? [] : [makeMissingCapabilityNotice(capability, query)];
}

function isCapabilityDiscoveryFailure(failureKind: string, raw: unknown): boolean {
  if (failureKind === 'max_iterations' || failureKind === 'max_tool_calls') return true;
  const detail =
    typeof raw === 'object' && raw !== null && 'message' in raw
      ? String((raw as { message: unknown }).message)
      : typeof raw === 'string'
        ? raw
        : '';
  return /AppView responded 400|no_candidate|no live providers|zero live providers/i.test(detail);
}

function extractNamespacedCapability(text: string): string | null {
  const match = text.toLowerCase().match(/\b[a-z0-9]+(?:\.[a-z0-9_]+)+\b/);
  return match?.[0] ?? null;
}

function postMissingCapabilityCards(
  threadId: string,
  content: string,
  notices: MissingCapabilityNotice[],
): void {
  for (const notice of notices) {
    addLifecycleMessage(threadId, content, {
      kind: 'missing_capability',
      status: 'ready',
      noticeId: notice.noticeId,
      capability: notice.capability,
      query: notice.query,
    });
  }
}

/**
 * Map a raw provider error string into a user-friendly one-liner.
 *
 * The agentic loop's underlying SDK throws wrapped errors like
 * `"RetryError: Failed after 3 attempts. Last error: <vendor body>"`.
 * Those are diagnostics, not user copy — they mention RetryError,
 * link to platform.openai.com docs, and use jargon the chat-bubble
 * reader will not parse.
 *
 * `humaniseProviderError` is the user-facing wrapper: a classified
 * template (P1.2 — see `provider_error_classify.ts` for the patterns),
 * otherwise a fixed generic apology. The previous "cleaned raw"
 * fallback was a P1.2-residual leak — an LLM SDK error string can
 * contain the failing request body (prompt + vault content), and
 * "cleaned" regex-strips didn't redact PII, they just trimmed URLs /
 * wrappers. The raw error is never propagated through this function.
 *
 * Exported for tests; consumers should go through `formatFailure`.
 */
export function humaniseProviderError(raw: string): string {
  return classifyProviderErrorMessage(raw) ?? GENERIC_PROVIDER_FAILURE_MESSAGE;
}
