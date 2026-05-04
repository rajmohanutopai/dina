/**
 * Chat command parser — detect intent from user text input.
 *
 * Commands:
 *   /remember <text>                    → store a memory in the vault
 *   /ask <question>                     → search vault + reason about a question
 *   /search <query>                     → vault search (FTS only, no LLM)
 *   /service <capability> <free text>   → route to a public service (Bus Driver)
 *   /help                               → show available commands
 *
 * Implicit intent detection:
 *   Questions (who/what/when/where/why/how/is/are/does/did/can/will)
 *   → treated as /ask unless the text is clearly a statement.
 *
 * Source: ARCHITECTURE.md Tasks 4.8, 4.9 + BUS_DRIVER_IMPLEMENTATION.md BRAIN-P1-W01.
 */

export type ChatIntent =
  | 'remember'
  | 'ask'
  | 'task'
  | 'search'
  | 'service'
  | 'service_approve'
  | 'service_deny'
  | 'help'
  | 'chat';

export interface ParsedCommand {
  intent: ChatIntent;
  payload: string;
  explicit: boolean; // true if slash command, false if detected
  originalText: string;
  /**
   * Present only for `intent === 'service'`. The first token after `/service`
   * names the capability (e.g. `eta_query`); the remaining text is `payload`.
   */
  capability?: string;
  /**
   * Present only for `intent === 'service_approve'` or `'service_deny'`.
   * The workflow task id the operator is acting on. For `service_deny`, any
   * free-text reason lives in `payload`.
   */
  taskId?: string;
}

/** Question-starting words (case-insensitive). */
const QUESTION_STARTERS = new Set([
  'who',
  'what',
  'when',
  'where',
  'why',
  'how',
  'is',
  'are',
  'was',
  'were',
  'does',
  'did',
  'do',
  'can',
  'could',
  'will',
  'would',
  'should',
  'has',
  'have',
  'had',
]);

/**
 * Parse user input into a structured command.
 *
 * 1. Check for explicit slash commands (/remember, /ask, /search, /help)
 * 2. Detect question intent from natural language
 * 3. Default to 'chat' (general conversation)
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed) {
    return { intent: 'chat', payload: '', explicit: false, originalText: text };
  }

  // 1. Explicit slash commands
  if (trimmed.startsWith('/')) {
    return parseSlashCommand(trimmed);
  }

  // 2. Question detection
  if (isQuestion(trimmed)) {
    return { intent: 'ask', payload: trimmed, explicit: false, originalText: text };
  }

  // 3. Default: chat
  return { intent: 'chat', payload: trimmed, explicit: false, originalText: text };
}

/**
 * Parse an explicit slash command.
 */
function parseSlashCommand(text: string): ParsedCommand {
  const parts = text.match(/^\/(\S+)\s*(.*)/s);
  if (!parts) {
    return { intent: 'chat', payload: text, explicit: false, originalText: text };
  }

  const [, command, rest] = parts;
  const payload = rest.trim();

  switch (command.toLowerCase()) {
    case 'remember':
      return { intent: 'remember', payload, explicit: true, originalText: text };
    case 'ask':
      return { intent: 'ask', payload, explicit: true, originalText: text };
    case 'task':
      return { intent: 'task', payload, explicit: true, originalText: text };
    case 'search':
      return { intent: 'search', payload, explicit: true, originalText: text };
    case 'service':
      return parseServiceCommand(payload, text);
    case 'service_approve':
      return parseServiceApproveCommand(payload, text);
    case 'service_deny':
      return parseServiceDenyCommand(payload, text);
    case 'help':
      return { intent: 'help', payload: '', explicit: true, originalText: text };
    default:
      // Unknown command → treat as chat
      return { intent: 'chat', payload: text, explicit: false, originalText: text };
  }
}

/**
 * Parse a `/service <capability> <free text>` command.
 *
 * Valid: capability is a non-empty identifier (letters, digits, `_`, `.`, `-`).
 * Free text is optional — a bare `/service eta_query` is a valid probe.
 *
 * Invalid inputs (no capability, or capability contains spaces/special
 * characters) fall back to `intent: 'chat'` so the user is not silently
 * misrouted.
 */
function parseServiceCommand(payload: string, originalText: string): ParsedCommand {
  const trimmed = payload.trim();
  if (trimmed === '') {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  // First whitespace-delimited token is the capability; the rest is payload.
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  const capability = match[1];
  const rest = (match[2] ?? '').trim();

  if (!isValidCapabilityName(capability)) {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }

  return {
    intent: 'service',
    payload: rest,
    explicit: true,
    originalText,
    capability,
  };
}

/**
 * Capability names mirror AT-Proto NSID conventions: letters, digits, and
 * the separators `_ . -`. This is intentionally stricter than what the wire
 * will accept — we reject suspicious-looking input at the chat boundary.
 */
function isValidCapabilityName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.\-]*$/.test(name);
}

/**
 * Parse a `/service_approve <taskId>` command.
 *
 * Valid: taskId is a non-empty identifier (letters, digits, `_ . -`). Any
 * trailing text after the first token is ignored — operators sometimes type
 * a note after the id (e.g. `/service_approve approval-u1 looks fine`); we
 * silently drop it rather than misroute.
 *
 * Invalid inputs (missing taskId, or taskId with shell-injection-shaped
 * characters) fall back to `intent: 'chat'` so the user is not silently
 * misrouted.
 */
function parseServiceApproveCommand(payload: string, originalText: string): ParsedCommand {
  const trimmed = payload.trim();
  if (trimmed === '') {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  const match = trimmed.match(/^(\S+)(?:\s+[\s\S]*)?$/);
  if (!match) {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  const taskId = match[1];
  if (!isValidTaskId(taskId)) {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  return {
    intent: 'service_approve',
    payload: '',
    explicit: true,
    originalText,
    taskId,
  };
}

/**
 * Workflow task ids are caller-generated strings. Accept the character set
 * produced by `ServiceHandler.createApprovalTask` (`approval-<uuid>`) and
 * other internal generators (`svc-exec-<uuid>`), plus conservative separators.
 * Reject anything that looks like shell-injection / path traversal.
 */
function isValidTaskId(id: string): boolean {
  return /^[A-Za-z0-9_.\-]+$/.test(id);
}

/**
 * Parse a `/service_deny <taskId> [reason]` command.
 *
 * Unlike `/service_approve`, trailing text after the taskId is preserved as
 * the deny reason (surfaced to the requester in the `unavailable` response
 * payload and recorded in the cancel audit event). An empty reason is
 * allowed — the default handler substitutes `denied_by_operator`.
 */
function parseServiceDenyCommand(payload: string, originalText: string): ParsedCommand {
  const trimmed = payload.trim();
  if (trimmed === '') {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  const taskId = match[1];
  const reason = (match[2] ?? '').trim();
  if (!isValidTaskId(taskId)) {
    return { intent: 'chat', payload: originalText, explicit: false, originalText };
  }
  return {
    intent: 'service_deny',
    payload: reason,
    explicit: true,
    originalText,
    taskId,
  };
}

/**
 * Detect if text is a question.
 *
 * Heuristics:
 * - Ends with '?'
 * - Starts with a question word (who/what/when/where/why/how/is/are/...)
 */
export function isQuestion(text: string): boolean {
  if (text.endsWith('?')) return true;

  const firstWord = text.split(/\s+/)[0]?.toLowerCase();
  if (firstWord && QUESTION_STARTERS.has(firstWord)) return true;

  return false;
}

/**
 * Get the list of available commands for /help.
 */
export function getAvailableCommands(): Array<{ command: string; description: string }> {
  return [
    { command: '/remember <text>', description: 'Store a memory in your vault' },
    {
      command: '/ask <question>',
      description: 'Ask a question — searches your vault and reasons about it',
    },
    { command: '/search <query>', description: 'Search your vault (keyword search, no LLM)' },
    {
      command: '/service <capability> <text>',
      description: 'Ask a public service — e.g. /service eta_query when will bus 42 reach me?',
    },
    {
      command: '/service_approve <taskId>',
      description: 'Approve a pending service-approval task (moves it into execution)',
    },
    {
      command: '/service_deny <taskId> [reason]',
      description: 'Deny a pending service-approval task (sends `unavailable` to requester)',
    },
    { command: '/help', description: 'Show available commands' },
  ];
}
