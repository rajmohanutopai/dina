/**
 * Chat orchestrator — user-facing entry point for chat interactions.
 *
 * Ties together: command parser → intent routing → handler → thread update.
 *
 * Intents:
 *   /remember → store in vault via staging
 *   /ask (or question) → reason pipeline (vault search + LLM)
 *   /search → vault FTS search (no LLM)
 *   /help → return command list
 *   chat → general conversation via reasoning pipeline
 *
 * Source: ARCHITECTURE.md Tasks 4.7–4.9
 */

import { parseCommand, getAvailableCommands, type ChatIntent } from './command_parser';
import { addUserMessage, addDinaResponse, addSystemMessage } from './thread';
import { reason } from '../pipeline/chat_reasoning';
import { executeToolSearch } from '../vault_context/assembly';
import { ingest } from '../../../core/src/staging/service';
import { CoreHttpError } from '../core_client/http';

export interface ChatResponse {
  intent: ChatIntent;
  response: string;
  sources: string[];
  messageId: string;
}

/** Default thread ID for the main chat. */
const DEFAULT_THREAD = 'main';

/** Default persona for reasoning. */
let defaultPersona = 'general';

/** Default LLM provider. */
let defaultProvider = 'none';

/** Set the default persona for chat reasoning. */
export function setDefaultPersona(persona: string): void {
  defaultPersona = persona;
}

/** Set the default LLM provider. */
export function setDefaultProvider(provider: string): void {
  defaultProvider = provider;
}

/** Reset defaults (for testing). */
export function resetChatDefaults(): void {
  defaultPersona = 'general';
  defaultProvider = 'none';
}

/**
 * Handle a user chat message.
 *
 * Parses the input, routes to the appropriate handler,
 * stores both user message and response in the thread.
 */
export async function handleChat(text: string, threadId?: string): Promise<ChatResponse> {
  const thread = threadId ?? DEFAULT_THREAD;
  const parsed = parseCommand(text);

  // Store user message
  addUserMessage(thread, text);

  let response: string;
  let sources: string[] = [];

  switch (parsed.intent) {
    case 'remember':
      response = await handleRemember(parsed.payload);
      break;

    case 'ask':
      ({ response, sources } = await handleAsk(parsed.payload));
      break;

    case 'search':
      ({ response, sources } = await handleSearch(parsed.payload));
      break;

    case 'service':
      response = await handleService(parsed.capability ?? '', parsed.payload);
      break;

    case 'service_approve':
      response = await handleServiceApprove(parsed.taskId ?? '');
      break;

    case 'service_deny':
      response = await handleServiceDeny(parsed.taskId ?? '', parsed.payload);
      break;

    case 'help':
      response = handleHelp();
      break;

    case 'chat':
    default:
      ({ response, sources } = await handleAsk(parsed.payload));
      break;
  }

  // Store response
  const msg = addDinaResponse(thread, response, sources.length > 0 ? sources : undefined);

  return {
    intent: parsed.intent,
    response,
    sources,
    messageId: msg.id,
  };
}

/** Handle /remember: store text via staging ingest. */
async function handleRemember(text: string): Promise<string> {
  if (!text) return 'What would you like me to remember?';

  const { id, duplicate } = ingest({
    source: 'user_remember',
    source_id: `remember-${Date.now()}`,
    data: { summary: text, type: 'user_memory', body: text },
  });

  if (duplicate) return 'I already have that stored.';
  return `Got it — I'll remember that. (${id})`;
}

/** Handle /ask or detected question: reason pipeline. */
async function handleAsk(query: string): Promise<{ response: string; sources: string[] }> {
  if (!query) return { response: 'What would you like to know?', sources: [] };

  // When an agentic handler is installed (via bootstrap's globalWiring),
  // route `/ask` through it — the handler runs the multi-turn tool-use
  // loop that can call geocode / search_provider_services / query_service.
  // When absent, fall back to the single-shot `reason()` pipeline so
  // `/ask` still works in test / early-boot paths.
  if (askHandler !== null) {
    return askHandler(query);
  }

  const result = await reason({
    query,
    persona: defaultPersona,
    provider: defaultProvider,
  });

  return { response: result.answer, sources: result.sources };
}

// ---------------------------------------------------------------------------
// /ask command handler hook — installed by bootstrap when the agentic
// reasoning loop is available. When null, handleAsk uses the single-shot
// fallback above.
// ---------------------------------------------------------------------------

export type AskCommandHandler = (query: string) => Promise<{ response: string; sources: string[] }>;

let askHandler: AskCommandHandler | null = null;

export function setAskCommandHandler(h: AskCommandHandler | null): void {
  askHandler = h;
}

export function resetAskCommandHandler(): void {
  askHandler = null;
}

/** Handle /search: vault FTS only, no LLM. */
async function handleSearch(query: string): Promise<{ response: string; sources: string[] }> {
  if (!query) return { response: 'What would you like to search for?', sources: [] };

  const items = await executeToolSearch(defaultPersona, query, 10);

  if (items.length === 0) {
    return { response: 'No results found.', sources: [] };
  }

  const lines = items.map((item, i) => `${i + 1}. ${item.content_l0}`);
  return {
    response: `Found ${items.length} result(s):\n${lines.join('\n')}`,
    sources: items.map((i) => i.id),
  };
}

/** Handle /help: return available commands. */
function handleHelp(): string {
  const commands = getAvailableCommands();
  return commands.map((c) => `${c.command} — ${c.description}`).join('\n');
}

// ---------------------------------------------------------------------------
// /service command (BRAIN-P1-W)
// ---------------------------------------------------------------------------

/**
 * Handler invoked when a `/service <capability> <text>` command is parsed.
 * The result is delivered asynchronously via a workflow event — this handler
 * only returns the synchronous acknowledgement string shown to the user.
 *
 * `null` (the default) is swapped in by `setServiceCommandHandler` when
 * `ServiceQueryOrchestrator` is wired via `wireServiceOrchestrator`.
 */
export type ServiceCommandHandler = (
  capability: string,
  payload: string,
) => Promise<{ ack: string }>;

let serviceHandler: ServiceCommandHandler | null = null;

/**
 * Install the service-command handler. Typically called once at brain
 * startup via `wireServiceOrchestrator(ServiceQueryOrchestrator)`.
 */
export function setServiceCommandHandler(handler: ServiceCommandHandler | null): void {
  serviceHandler = handler;
}

/** Reset handler (for tests). */
export function resetServiceCommandHandler(): void {
  serviceHandler = null;
}

async function handleService(capability: string, payload: string): Promise<string> {
  if (!capability) {
    return 'Which service? Usage: /service <capability> <question>';
  }
  if (serviceHandler === null) {
    // Orchestrator not yet wired. Tell the user we heard them and
    // acknowledge the capability — the actual query flow lands in BRAIN-P1-Q.
    return `Service lookup for "${capability}" isn't wired up yet. (Coming soon.)`;
  }
  try {
    const { ack } = await serviceHandler(capability, payload);
    return ack;
  } catch (err) {
    return `Couldn't start service query: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// /service_approve command (BRAIN-P2-W)
// ---------------------------------------------------------------------------

/**
 * Handler invoked when `/service_approve <taskId>` is parsed. Wired at
 * brain startup to call `coreClient.approveWorkflowTask(taskId)`, which
 * moves the task `pending_approval → queued` so execution can begin.
 *
 * Returning an `ack` string lets different wirings produce different
 * user-facing messages (e.g. "Approved — executing…" vs "Approved, awaiting
 * runner").
 */
export type ServiceApproveCommandHandler = (taskId: string) => Promise<{ ack: string }>;

let serviceApproveHandler: ServiceApproveCommandHandler | null = null;

/**
 * Install the approve-command handler. Typically called once at brain
 * startup with `makeDefaultServiceApproveHandler(coreClient)`.
 */
export function setServiceApproveCommandHandler(
  handler: ServiceApproveCommandHandler | null,
): void {
  serviceApproveHandler = handler;
}

/** Reset handler (for tests). */
export function resetServiceApproveCommandHandler(): void {
  serviceApproveHandler = null;
}

async function handleServiceApprove(taskId: string): Promise<string> {
  if (!taskId) {
    return 'Usage: /service_approve <taskId>';
  }
  if (serviceApproveHandler === null) {
    return `Approval for "${taskId}" isn't wired up yet. (Coming soon.)`;
  }
  try {
    const { ack } = await serviceApproveHandler(taskId);
    return ack;
  } catch (err) {
    return formatApprovalError(taskId, err as Error);
  }
}

/**
 * Translate a Core HTTP error into an operator-friendly explanation.
 * `BrainCoreClient` surfaces non-2xx statuses as `CoreHttpError` with a
 * `.status` field (CORE-P4-F03 — no more error-message string matching).
 *
 * `verb` is the user-visible action name — "approve" or "deny" — so the
 * fallback message reads naturally in both contexts.
 */
function formatApprovalError(
  taskId: string,
  err: Error,
  verb: 'approve' | 'deny' = 'approve',
): string {
  if (err instanceof CoreHttpError) {
    if (err.status === 404) {
      return `No approval task with id "${taskId}".`;
    }
    if (err.status === 409) {
      return `Task "${taskId}" is no longer pending approval.`;
    }
  }
  const msg = err.message ?? String(err);
  return `Couldn't ${verb} "${taskId}": ${msg}`;
}

// ---------------------------------------------------------------------------
// /service_deny command (BRAIN-P2-W05)
// ---------------------------------------------------------------------------

/**
 * Handler invoked when `/service_deny <taskId> [reason]` is parsed. Wired at
 * brain startup with `makeServiceDenyHandler(coreClient)` — see
 * `service/approve_command.ts`.
 */
export type ServiceDenyCommandHandler = (
  taskId: string,
  reason: string,
) => Promise<{ ack: string }>;

let serviceDenyHandler: ServiceDenyCommandHandler | null = null;

/** Install the deny-command handler. */
export function setServiceDenyCommandHandler(handler: ServiceDenyCommandHandler | null): void {
  serviceDenyHandler = handler;
}

/** Reset handler (for tests). */
export function resetServiceDenyCommandHandler(): void {
  serviceDenyHandler = null;
}

async function handleServiceDeny(taskId: string, reason: string): Promise<string> {
  if (!taskId) {
    return 'Usage: /service_deny <taskId> [reason]';
  }
  if (serviceDenyHandler === null) {
    return `Denial for "${taskId}" isn't wired up yet. (Coming soon.)`;
  }
  try {
    const { ack } = await serviceDenyHandler(taskId, reason);
    return ack;
  } catch (err) {
    return formatApprovalError(taskId, err as Error, 'deny');
  }
}
