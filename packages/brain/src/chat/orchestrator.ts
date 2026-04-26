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
import { listByPersona as listRemindersByPersona, type Reminder } from '../../../core/src/reminders/service';
import { CoreHttpError } from '../errors';
import {
  plainResponse,
  richResponse,
  errorResponse,
  type BotResponse,
} from './response_types';

export interface ChatResponse {
  intent: ChatIntent;
  /**
   * Plain-language rendering of the response. Every channel gets this
   * — text-only transports (CLI, legacy chat UIs) display it verbatim.
   * For typed kinds, `response` is the same as `typed.text`.
   */
  response: string;
  sources: string[];
  messageId: string;
  /**
   * Structured envelope carrying the `kind` discriminator + per-kind
   * payload (trust score, contact list, confirmation dialog, etc.).
   * Mobile UI reads this to render native card components; legacy
   * readers that only know the plain string ignore it.
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

  switch (parsed.intent) {
    case 'remember':
      typed = await handleRemember(parsed.payload);
      break;

    case 'ask':
      ({ typed, sources } = await handleAsk(parsed.payload, thread));
      break;

    case 'search':
      ({ typed, sources } = await handleSearch(parsed.payload));
      break;

    case 'service':
      typed = await handleService(parsed.capability ?? '', parsed.payload);
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
      ({ typed, sources } = await handleAsk(parsed.payload, thread));
      break;
  }

  // The string body is always `typed.text` — every kind carries a
  // plain-language fallback so text-only channels don't have to know
  // the discriminator.
  const response = typed.text;

  // Store response
  const msg = addDinaResponse(thread, response, sources.length > 0 ? sources : undefined);

  return {
    intent: parsed.intent,
    response,
    sources,
    messageId: msg.id,
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

  const { id, duplicate } = ingest({
    source: 'user_remember',
    source_id: `remember-${Date.now()}`,
    data: { summary: text, type: 'user_memory', body: text },
  });

  if (duplicate) return plainResponse('I already have that stored.');

  // Without a drain hook (test harnesses, early boot) keep the legacy
  // ack — the drain still runs on its own cadence and reminders land
  // a few seconds later.
  if (rememberDrainHook === null) {
    return plainResponse(`Got it — I'll remember that. (${id})`);
  }

  // Drive the drain inline so the user-facing reply mirrors Python's
  // Telegram flow: "Stored in <persona> vault." + auto-generated
  // reminder list (when the item carried a temporal event).
  let drainResult: RememberDrainResult = { persona: null };
  try {
    drainResult = await rememberDrainHook(id);
  } catch {
    // Drain failures shouldn't break the user round-trip — fall back
    // to the legacy ack so the user knows the item is staged.
    return plainResponse(`Got it — I'll remember that. (${id})`);
  }

  const { persona } = drainResult;
  if (persona === null) {
    return plainResponse(`Got it — I'll remember that. (${id})`);
  }

  const lines: string[] = [`Stored in ${persona} vault.`];

  // The reminder planner uses the staging row's id as the reminder's
  // `source_item_id` (see `drain.ts` → `handlePostPublish` → `planReminders`),
  // so we can filter by the staging id we already have — no need to
  // dig the published vault-item id out of the tick result.
  const reminders = listRemindersByPersona(persona)
    .filter((r) => r.source_item_id === id)
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
): Promise<{ typed: BotResponse; sources: string[] }> {
  if (!query) {
    return { typed: plainResponse('What would you like to know?'), sources: [] };
  }

  // When an agentic handler is installed (via bootstrap's globalWiring),
  // route `/ask` through it — the handler runs the multi-turn tool-use
  // loop that can call geocode / search_provider_services / query_service.
  // When absent, fall back to the single-shot `reason()` pipeline so
  // `/ask` still works in test / early-boot paths.
  if (askHandler !== null) {
    const r = await askHandler(query, { threadId });
    // Agentic answers are plain prose today. When a future handler
    // produces a structured kind (e.g. a trust-flagged purchase
    // dialog), upgrade this branch to read a richer shape from the
    // handler result.
    return { typed: plainResponse(r.response), sources: r.sources };
  }

  const result = await reason({
    query,
    persona: defaultPersona,
    provider: defaultProvider,
  });
  return { typed: plainResponse(result.answer), sources: result.sources };
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
 * per-persona threads, Service Inbox, etc.). Optional for backward
 * compatibility with handlers that ignore late delivery.
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
) => Promise<{ response: string; sources: string[] }>;

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

async function handleService(capability: string, payload: string): Promise<BotResponse> {
  if (!capability) {
    return errorResponse('Which service? Usage: /service <capability> <question>');
  }
  if (serviceHandler === null) {
    // Orchestrator not yet wired. Tell the user we heard them and
    // acknowledge the capability — the actual query flow lands in BRAIN-P1-Q.
    return plainResponse(
      `Service lookup for "${capability}" isn't wired up yet. (Coming soon.)`,
    );
  }
  try {
    const { ack } = await serviceHandler(capability, payload);
    return plainResponse(ack);
  } catch (err) {
    return errorResponse(`Couldn't start service query: ${(err as Error).message}`);
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
