/**
 * Startup composition — wires the orchestrator into the chat
 * `/service <capability> <text>` command.
 *
 * The orchestrator path is strictly dispatch-only:
 *   - The chat handler calls `orchestrator.issueQuery(...)` and returns an
 *     acknowledgement the user sees immediately ("Asking Bus 42…").
 *   - The actual response arrives asynchronously as a `workflow_event` and
 *     is rendered by `WorkflowEventConsumer`, which routes the formatted
 *     text back to the chat thread via its `deliver` callback.
 *
 * There is no D2D dispatcher binding here: the `service.response` wire
 * message is absorbed by Core's ingress pipeline, which marks the
 * `service_query` task completed + emits the event consumed above.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md BRAIN-P2-Q (simplified — Core owns state).
 */

import {
  resetServiceCommandHandler,
  setServiceCommandHandler,
  type ServiceCommandHandler,
} from '../chat/orchestrator';
import {
  ServiceOrchestratorError,
  type ServiceQueryOrchestrator,
  type IssueQueryRequest,
} from './service_query_orchestrator';

/** Options for `wireServiceOrchestrator`. */
export interface ServiceWiringOptions {
  orchestrator: ServiceQueryOrchestrator;
  /**
   * Optional adapter that turns the chat command's `(capability, payload)`
   * pair into a structured `IssueQueryRequest`. Lets integrators inject
   * location, radius, etc. that don't come from the chat line.
   *
   * Default: `{capability, params: {text: payload}}` — the payload is
   * wrapped into a generic text field so capabilities that accept free
   * text work without an adapter.
   */
  buildRequest?: (capability: string, payload: string) => IssueQueryRequest;
  /**
   * Shape the user-visible ack string. Default: "Asking {serviceName}…".
   * Override to localize or to include a progress indicator.
   */
  formatAck?: (result: {
    capability: string;
    serviceName: string;
    queryId: string;
    taskId: string;
    deduped: boolean;
  }) => string;
}

/** Disposer returned by `wireServiceOrchestrator`. */
export type ServiceWiringDisposer = () => void;

/**
 * Install the chat-command handler. Idempotent-ish: calling it again
 * replaces the current handler; callers should dispose the previous
 * binding first.
 */
export function wireServiceOrchestrator(options: ServiceWiringOptions): ServiceWiringDisposer {
  if (!options.orchestrator) {
    throw new Error('wireServiceOrchestrator: orchestrator is required');
  }

  const orchestrator = options.orchestrator;
  const buildRequest = options.buildRequest ?? defaultBuildRequest;
  const formatAck = options.formatAck ?? defaultFormatAck;

  const chatHandler: ServiceCommandHandler = async (capability, payload) => {
    try {
      const req = buildRequest(capability, payload);
      const result = await orchestrator.issueQuery(req);
      return {
        ack: formatAck({
          capability,
          serviceName: result.serviceName,
          queryId: result.queryId,
          taskId: result.taskId,
          deduped: result.deduped,
        }),
        // Surface the dispatch so the chat orchestrator can post a
        // lifecycle-tracked dina message (status `pending`) keyed by
        // taskId. The `WorkflowEventConsumer` patches the same message
        // in place when the response arrives — same path the agentic
        // `/ask` flow uses.
        dispatch: {
          taskId: result.taskId,
          queryId: result.queryId,
          capability,
          serviceName: result.serviceName,
        },
      };
    } catch (err) {
      return { ack: errorToAck(capability, err) };
    }
  };
  setServiceCommandHandler(chatHandler);

  return () => {
    resetServiceCommandHandler();
  };
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Default payload → IssueQueryRequest builder.
 *
 * For ad-hoc text (`/service eta_query castro bus`) wraps as
 * `{text: payload}` — matches the original single-arg contract.
 *
 * For structured capabilities (`/service eta_query {...json...}`) the
 * operator can pass a JSON object and we forward it verbatim. This
 * covers issue #17 — capabilities like eta_query with a typed schema
 * can actually be invoked from the slash-command surface without a
 * custom adapter.
 */
function defaultBuildRequest(capability: string, payload: string): IssueQueryRequest {
  const trimmed = payload.trim();
  if (trimmed === '') {
    return { capability, params: {}, originChannel: 'chat' };
  }
  // Only attempt JSON parse when the payload looks like it:
  // starts with `{` and ends with `}`. Otherwise every free-text
  // operator input would incur a parse failure log.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { capability, params: parsed, originChannel: 'chat' };
      }
    } catch {
      // Fall through to text fallback — JSON-looking but not JSON.
    }
  }
  return { capability, params: { text: trimmed }, originChannel: 'chat' };
}

function defaultFormatAck(result: { serviceName: string; deduped: boolean }): string {
  const name = result.serviceName !== '' ? result.serviceName : 'the service';
  if (result.deduped) return `Still asking ${name}…`;
  return `Asking ${name}…`;
}

/**
 * Turn an orchestrator failure into a single user-visible acknowledgement
 * string. Pre-send failures only — post-send failures arrive through the
 * workflow event path.
 */
export function errorToAck(capability: string, err: unknown): string {
  if (err instanceof ServiceOrchestratorError) {
    switch (err.code) {
      case 'no_candidate':
        return `No public service advertises "${capability}" right now.`;
      case 'capability_required':
      case 'params_required':
        return `Can't run service query: ${err.message}.`;
      case 'send_failed':
        return `Couldn't reach the service: ${err.message}.`;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `Couldn't start service query: ${msg}`;
}
