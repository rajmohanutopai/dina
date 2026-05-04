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

import { listByPersona as listRemindersByPersona, type Reminder } from '../../../core/src/reminders/service';
import { CoreHttpError } from '../errors';
import { reason } from '../pipeline/chat_reasoning';
import { executeToolSearch } from '../vault_context/assembly';

import { parseCommand, getAvailableCommands, type ChatIntent } from './command_parser';
import {
  plainResponse,
  richResponse,
  errorResponse,
  type BotResponse,
} from './response_types';
import {
  addUserMessage,
  addDinaResponse,
  addLifecycleMessage,
} from './thread';

import type { ServiceQueryDispatch } from '../reasoning/ask_handler';
import type { CoreClient } from '@dina/core';

export interface ChatResponse {
  intent: ChatIntent;
  /**
   * Plain-language rendering of the response. Every channel gets this
   * — text-only transports display it verbatim.
   * For typed kinds, `response` is the same as `typed.text`.
   */
  response: string;
  sources: string[];
  messageId: string;
  /**
   * Structured envelope carrying the `kind` discriminator + per-kind
   * payload (trust score, contact list, confirmation dialog, etc.).
   * Mobile UI reads this to render native card components; text-only
   * readers can use the plain string above.
   *
   * Always populated — at minimum it carries `kind: 'plain'` with the
   * same `text` as `response`. Port of Python's `domain/response.py`.
   */
  typed: BotResponse;
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

  let typed: BotResponse;
  let sources: string[] = [];
  let serviceQueries: ServiceQueryDispatch[] = [];

  switch (parsed.intent) {
    case 'remember':
      typed = await handleRemember(parsed.payload);
      break;

    case 'ask':
      ({ typed, sources, serviceQueries } = await handleAsk(parsed.payload, thread));
      break;

    case 'task':
      // Task mode = "delegate this to a paired agent". Reuses the
      // agentic-loop pipeline (so context enrichment via vault_search /
      // contacts / etc. still runs) but prepends a directive so the
      // LLM routes through `delegate_to_agent` instead of answering
      // itself. The user-facing thread already stored the original
      // text above (`addUserMessage`); the directive only travels
      // with the LLM round-trip.
      if (parsed.payload.trim() === '') {
        typed = plainResponse('What would you like the paired agent to do?');
      } else {
        ({ typed, sources, serviceQueries } = await handleAsk(
          wrapAsTaskPrompt(parsed.payload),
          thread,
        ));
      }
      break;

    case 'search':
      ({ typed, sources } = await handleSearch(parsed.payload));
      break;

    case 'service':
      ({ typed, serviceQueries } = await handleService(parsed.capability ?? '', parsed.payload));
      break;

    case 'service_approve':
      typed = await handleServiceApprove(parsed.taskId ?? '');
      break;

    case 'service_deny':
      typed = await handleServiceDeny(parsed.taskId ?? '', parsed.payload);
      break;

    case 'help':
      typed = handleHelp();
      break;

    case 'chat':
    default:
      ({ typed, sources, serviceQueries } = await handleAsk(parsed.payload, thread));
      break;
  }

  // The string body is always `typed.text` — every kind carries a
  // plain-language fallback so text-only channels don't have to know
  // the discriminator.
  const response = typed.text;

  // When a service query was dispatched (LLM `query_service` tool OR
  // `/service` slash command), post a single `'dina'` message tagged
  // with `metadata.lifecycle = {kind: 'service_query', status: 'pending', …}`.
  // The `WorkflowEventConsumer` patches the same message in place when
  // the response lands — eliminating the race where the LLM narrative
  // and the workflow-event push produced two messages for one query.
  // Brain ships the LLM ack as initial content; mobile renders the card
  // (inline component dispatches on `metadata.lifecycle.kind`).
  let msgId: string;
  if (serviceQueries.length > 0) {
    let lastId = '';
    for (const sq of serviceQueries) {
      const msg = addLifecycleMessage(thread, response, {
        kind: 'service_query',
        status: 'pending',
        taskId: sq.taskId,
        queryId: sq.queryId,
        capability: sq.capability,
        serviceName: sq.serviceName,
      });
      lastId = msg.id;
    }
    msgId = lastId;
  } else if (response !== '') {
    const msg = addDinaResponse(thread, response, sources.length > 0 ? sources : undefined);
    msgId = msg.id;
  } else {
    // Handler returned an empty response — the contract is "I posted
    // my own message(s) (approval card, ask_pending placeholder, …)
    // so don't append another bubble." Without this branch the chat
    // surfaced a stray empty dina row above the handler's own row,
    // and async /ask flows showed BOTH a "Working on it…" bubble AND
    // the resolved answer instead of the placeholder morphing in
    // place. Return id `''` because there's no orchestrator-owned
    // message to reference.
    msgId = '';
  }

  return {
    intent: parsed.intent,
    response,
    sources,
    messageId: msgId,
    typed,
  };
}

/**
 * Hook the bootstrap installs to drive the staging drain inline from
 * `/remember`. Without this, /remember just acks "Got it" — the drain
 * runs on its own ~10s cadence and the user never sees the resulting
 * persona / reminders. With it, /remember becomes the user-facing
 * round-trip: ingest → drain → confirm with persona + reminder list.
 *
 * Implementation lives in `apps/mobile/src/services/bootstrap.ts`
 * (production) or test harnesses (unit tests). The bootstrap's job is
 * to drive the drain until OUR staging row reaches `stored`; the
 * orchestrator then reads reminders off the in-memory reminder store
 * filtered by `source_item_id === stagingId` (the planner uses the
 * staging row's id as the reminder source id, so no separate
 * vault-item id lookup is needed).
 */
export interface RememberDrainResult {
  /** Persona the staged item resolved into. `null` when the drain
   *  didn't process the item (no scheduler wired) or it ended in
   *  pending_unlock / failed. */
  persona: string | null;
}

export type RememberDrainHook = (stagingId: string) => Promise<RememberDrainResult>;

let rememberDrainHook: RememberDrainHook | null = null;

/** Install the drain hook (called by bootstrap). Pass `null` to clear. */
export function setRememberDrainHook(hook: RememberDrainHook | null): void {
  rememberDrainHook = hook;
}

/** Reset for tests. */
export function resetRememberDrainHook(): void {
  rememberDrainHook = null;
}

export type RememberCoreClient = Pick<CoreClient, 'stagingIngest'>;

let rememberCoreClient: RememberCoreClient | null = null;

/**
 * Install the Core transport used by `/remember`. Mobile passes its
 * `InProcessTransport`; home-node-lite brain-server passes
 * `HttpCoreTransport`. The orchestrator must not import Core staging
 * internals directly, otherwise server and mobile remember paths drift.
 */
export function setRememberCoreClient(client: RememberCoreClient | null): void {
  rememberCoreClient = client;
}

/** Reset for tests / node disposal. */
export function resetRememberCoreClient(): void {
  rememberCoreClient = null;
}

/**
 * Format a persona name for user-facing reply text — capitalise +
 * replace underscores with spaces. Internal storage stays lowercase
 * `[a-z0-9_]+` (vault file names, classifier prompt list); chat
 * replies surface the prettier form so "Stored in finance vault."
 * reads as "Stored in Finance vault.".
 *
 *   formatPersonaDisplayName('general')        → 'General'
 *   formatPersonaDisplayName('trip_planning')  → 'Trip Planning'
 *
 * Mirrors `apps/mobile/src/hooks/usePersonas.ts::formatPersonaDisplayName`
 * so chat replies + Vault tab + persona detail header agree on the
 * same display style.
 */
function formatPersonaDisplayName(name: string): string {
  if (!name) return '';
  return name
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const REMINDER_EMOJI: Record<string, string> = {
  birthday: '🎂',
  appointment: '📅',
  payment_due: '💳',
  deadline: '⏰',
};

function formatReminderTime(dueMs: number): string {
  return new Date(dueMs).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatReminder(r: Reminder): string {
  const emoji = REMINDER_EMOJI[r.kind] ?? '🔔';
  return `[${r.short_id}] ${emoji} ${formatReminderTime(r.due_at)} — ${r.message}`;
}

/** Handle /remember: store text via staging ingest. */
async function handleRemember(text: string): Promise<BotResponse> {
  if (!text) return plainResponse('What would you like me to remember?');

  if (rememberCoreClient === null) {
    return plainResponse('Remember is still starting. Please try again in a moment.');
  }

  const { itemId, duplicate } = await rememberCoreClient.stagingIngest({
    source: 'user_remember',
    sourceId: `remember-${Date.now()}`,
    data: { summary: text, type: 'user_memory', body: text },
  });

  if (duplicate) return plainResponse('I already have that stored.');

  // Without a drain hook (test harnesses, early boot) acknowledge the
  // staged write — the drain still runs on its own cadence and
  // reminders land a few seconds later.
  if (rememberDrainHook === null) {
    return plainResponse(`Got it — I'll remember that.`);
  }

  // Drive the drain inline so the user-facing reply mirrors Python's
  // Telegram flow: "Stored in <persona> vault." + auto-generated
  // reminder list (when the item carried a temporal event).
  let drainResult: RememberDrainResult = { persona: null };
  try {
    drainResult = await rememberDrainHook(itemId);
  } catch {
    // Drain failures shouldn't break the user round-trip — fall back
    // to a staged ack so the user knows the item was accepted.
    return plainResponse(`Got it — I'll remember that.`);
  }

  const { persona } = drainResult;
  if (persona === null) {
    return plainResponse(`Got it — I'll remember that.`);
  }

  const lines: string[] = [`Stored in ${formatPersonaDisplayName(persona)} vault.`];

  // The reminder planner uses the staging row's id as the reminder's
  // `source_item_id` (see `drain.ts` → `handlePostPublish` → `planReminders`),
  // so we can filter by the staging id we already have — no need to
  // dig the published vault-item id out of the tick result.
  const reminders = listRemindersByPersona(persona)
    .filter((r) => r.source_item_id === itemId)
    .sort((a, b) => a.due_at - b.due_at);
  if (reminders.length > 0) {
    lines.push('');
    lines.push('Reminders set:');
    for (const r of reminders) lines.push(formatReminder(r));
  }
  return plainResponse(lines.join('\n'));
}

/** Handle /ask or detected question: reason pipeline. */
async function handleAsk(
  query: string,
  threadId: string,
): Promise<{ typed: BotResponse; sources: string[]; serviceQueries: ServiceQueryDispatch[] }> {
  if (!query) {
    return {
      typed: plainResponse('What would you like to know?'),
      sources: [],
      serviceQueries: [],
    };
  }

  // When an agentic handler is installed (via bootstrap's globalWiring),
  // route `/ask` through it — the handler runs the multi-turn tool-use
  // loop that can call geocode / search_provider_services / query_service.
  // When absent, fall back to the single-shot `reason()` pipeline so
  // `/ask` still works in test / early-boot paths.
  if (askHandler !== null) {
    const r = await askHandler(query, { threadId });
    return {
      typed: plainResponse(r.response),
      sources: r.sources,
      serviceQueries: r.serviceQueries ?? [],
    };
  }

  const result = await reason({
    query,
    persona: defaultPersona,
    provider: defaultProvider,
  });
  return { typed: plainResponse(result.answer), sources: result.sources, serviceQueries: [] };
}

/**
 * Wrap a `/task` payload with an inline directive that pushes the
 * agentic loop's LLM toward the `delegate_to_agent` tool instead of
 * answering directly. Caller is responsible for short-circuiting empty
 * payloads — this helper assumes a non-empty trimmed payload.
 *
 * Why an inline preamble (not a system-prompt edit): the system prompt
 * is a long, vault-aware document set up at boot. Editing it per-turn
 * means threading flags through `AskCommandHandler`. An inline preamble
 * is local to this call site and the LLM treats it with the same
 * obedience as a system instruction in practice. The user-visible
 * chat message is unchanged — `addUserMessage` already stored the
 * original text before this transform runs.
 */
function wrapAsTaskPrompt(payload: string): string {
  return [
    '[TASK MODE — the user invoked /task. You MUST call the `delegate_to_agent` tool',
    'with a `task_description` that captures their request. Resolve any contact names',
    'or vault references using the read tools FIRST, then pass an enriched',
    'description to the agent. Do NOT answer the user directly even if you think',
    'you can — Task mode means the user expects an agent to do this work.]',
    '',
    `User request: ${payload.trim()}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// /ask command handler hook — installed by bootstrap when the agentic
// reasoning loop is available. When null, handleAsk uses the single-shot
// fallback above.
// ---------------------------------------------------------------------------

/**
 * Context the orchestrator passes through to an installed
 * `AskCommandHandler` so the handler can route deferred / late-arriving
 * answers back to the correct chat thread (multi-thread chat tabs,
 * per-persona threads, Service Inbox, etc.). Optional for handlers that
 * do not need late delivery.
 */
export interface AskCommandContext {
  /**
   * The chat thread the user's `/ask` originated from. The handler
   * MUST use this id when posting any late answers, system notes, or
   * approval cards via `addDinaResponse` / `addSystemMessage` /
   * `addApprovalMessage`. Returning the synchronous `{response,
   * sources}` result still flows through `handleChat` and lands in
   * the same thread; this argument is for *out-of-band* posts that
   * happen after the handler returns.
   */
  threadId: string;
}

export type AskCommandHandler = (
  query: string,
  context?: AskCommandContext,
) => Promise<{
  response: string;
  sources: string[];
  /**
   * Service-query dispatches that ran during this turn. Each entry
   * becomes a `service_query` chat card (status `pending`) that the
   * `WorkflowEventConsumer` later patches in place when the response
   * lands. Surfacing this here lets the orchestrator skip
   * `addDinaResponse` for the LLM narrative — the card carries the
   * message — eliminating the prior race where two messages described
   * the same query.
   */
  serviceQueries?: ServiceQueryDispatch[];
}>;

let askHandler: AskCommandHandler | null = null;

export function setAskCommandHandler(h: AskCommandHandler | null): void {
  askHandler = h;
}

export function resetAskCommandHandler(): void {
  askHandler = null;
}

/** Handle /search: vault FTS only, no LLM. */
async function handleSearch(query: string): Promise<{ typed: BotResponse; sources: string[] }> {
  if (!query) {
    return { typed: plainResponse('What would you like to search for?'), sources: [] };
  }

  const items = await executeToolSearch(defaultPersona, query, 10);

  if (items.length === 0) {
    return { typed: plainResponse('No results found.'), sources: [] };
  }

  const lines = items.map((item, i) => `${i + 1}. ${item.content_l0}`);
  return {
    typed: plainResponse(`Found ${items.length} result(s):\n${lines.join('\n')}`),
    sources: items.map((i) => i.id),
  };
}

/** Handle /help: return available commands as a rich-text listing so
 *  channels that render markdown get the nicer layout. */
function handleHelp(): BotResponse {
  const commands = getAvailableCommands();
  return richResponse(commands.map((c) => `${c.command} — ${c.description}`).join('\n'));
}

// ---------------------------------------------------------------------------
// /service command (BRAIN-P1-W)
// ---------------------------------------------------------------------------

/**
 * Handler invoked when a `/service <capability> <text>` command is parsed.
 * The result is delivered asynchronously via a workflow event — this handler
 * returns a synchronous acknowledgement string AND, on a successful
 * dispatch, the dispatch metadata so the orchestrator can post a
 * lifecycle-tracked chat message that the WorkflowEventConsumer later
 * patches in place. Without `dispatch`, the orchestrator falls back to a
 * plain dina response (error / pre-send-failure path).
 *
 * `null` (the default) is swapped in by `setServiceCommandHandler` when
 * `ServiceQueryOrchestrator` is wired via `wireServiceOrchestrator`.
 */
export type ServiceCommandHandler = (
  capability: string,
  payload: string,
) => Promise<{ ack: string; dispatch?: ServiceQueryDispatch }>;

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

async function handleService(
  capability: string,
  payload: string,
): Promise<{ typed: BotResponse; serviceQueries: ServiceQueryDispatch[] }> {
  if (!capability) {
    return {
      typed: errorResponse('Which service? Usage: /service <capability> <question>'),
      serviceQueries: [],
    };
  }
  if (serviceHandler === null) {
    return {
      typed: plainResponse(`Service lookup for "${capability}" isn't wired up yet. (Coming soon.)`),
      serviceQueries: [],
    };
  }
  try {
    const { ack, dispatch } = await serviceHandler(capability, payload);
    return {
      typed: plainResponse(ack),
      serviceQueries: dispatch !== undefined ? [dispatch] : [],
    };
  } catch (err) {
    return {
      typed: errorResponse(`Couldn't start service query: ${(err as Error).message}`),
      serviceQueries: [],
    };
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

/**
 * Read the currently installed approve handler — used by inline
 * approval-card UI (5.65) so a tap on "Approve" can invoke the same
 * handler `/service_approve` would, without round-tripping a
 * synthetic user message through `handleChat`. Returns null when no
 * handler is wired (test harnesses, early-boot states).
 */
export function getServiceApproveCommandHandler(): ServiceApproveCommandHandler | null {
  return serviceApproveHandler;
}

async function handleServiceApprove(taskId: string): Promise<BotResponse> {
  if (!taskId) {
    return errorResponse('Usage: /service_approve <taskId>');
  }
  if (serviceApproveHandler === null) {
    return plainResponse(`Approval for "${taskId}" isn't wired up yet. (Coming soon.)`);
  }
  try {
    const { ack } = await serviceApproveHandler(taskId);
    return plainResponse(ack);
  } catch (err) {
    return errorResponse(formatApprovalError(taskId, err as Error));
  }
}

/**
 * Translate a Core HTTP error into an operator-friendly explanation.
 * Core transports surface non-2xx statuses as `CoreHttpError` with a
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

/** Read the currently installed deny handler — companion to
 *  `getServiceApproveCommandHandler`; used by 5.65 inline cards. */
export function getServiceDenyCommandHandler(): ServiceDenyCommandHandler | null {
  return serviceDenyHandler;
}

async function handleServiceDeny(taskId: string, reason: string): Promise<BotResponse> {
  if (!taskId) {
    return errorResponse('Usage: /service_deny <taskId> [reason]');
  }
  if (serviceDenyHandler === null) {
    return plainResponse(`Denial for "${taskId}" isn't wired up yet. (Coming soon.)`);
  }
  try {
    const { ack } = await serviceDenyHandler(taskId, reason);
    return plainResponse(ack);
  } catch (err) {
    return errorResponse(formatApprovalError(taskId, err as Error, 'deny'));
  }
}
