/**
 * Telegram adapter (GAP.md row #25 closure — last Missing ✗).
 *
 * Telegram is Alonso's primary channel on the Python side; porting
 * the adapter unblocks the same surface on TS. This primitive is
 * the **parse + render half** — pure functions that translate
 * between the Telegram API's Update shape and Brain's internal
 * `IncomingMessage` / `OutboundMessage` types.
 *
 * **What's in here**:
 *
 *   - `parseUpdate(update)` → `ParsedTelegramUpdate` — normalises
 *     an `/update` from Bot API into one of: `text`, `command`,
 *     `callback`, `ignored`. Sender, chat id, text, command name
 *     + argv all extracted.
 *   - `renderSendMessage(spec)` → `TelegramSendMessageBody` — takes
 *     an outbound `{chatId, text, replyToMessageId?, replyMarkup?}`
 *     spec and produces the Telegram `sendMessage` JSON body.
 *   - `renderEditMessage(spec)` → `TelegramEditMessageBody` — same
 *     for `editMessageText`.
 *
 * **What's NOT in here**: HTTP calls to api.telegram.org. Those
 * live in the IO layer — the adapter just speaks JSON in + JSON out.
 *
 * **Markdown / HTML escaping**: Telegram's `MarkdownV2` requires
 * escaping 18 reserved characters. `escapeMarkdownV2(text)` is the
 * public helper; the render functions invoke it automatically when
 * `parseMode: 'MarkdownV2'` is set.
 *
 * **Commands**: Telegram commands arrive as `/name@botusername arg1
 * arg2` in the text. The parser strips the `@botusername` suffix
 * (when `botUsername` is provided) and splits the rest on whitespace.
 *
 * **Never throws** — malformed / unsupported updates map to
 * `{kind: 'ignored', reason}` so the caller can log + continue.
 *
 * Source: GAP.md (task 5.46 follow-up) — M5 Telegram-channel gate.
 */

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type?: string };
  date?: number;
  text?: string;
  entities?: ReadonlyArray<TelegramEntity>;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export type ParsedTelegramUpdate =
  | {
      kind: 'text';
      chatId: number;
      messageId: number;
      sender: NormalisedSender | null;
      text: string;
    }
  | {
      kind: 'command';
      chatId: number;
      messageId: number;
      sender: NormalisedSender | null;
      command: string;
      argv: string[];
      raw: string;
    }
  | {
      kind: 'callback';
      chatId: number;
      callbackId: string;
      sender: NormalisedSender | null;
      data: string;
    }
  | { kind: 'ignored'; reason: TelegramIgnoreReason };

export interface NormalisedSender {
  id: number;
  displayName: string;
  username: string | null;
  isBot: boolean;
}

export type TelegramIgnoreReason =
  | 'no_content'
  | 'no_text'
  | 'edited_message'
  | 'no_callback_data'
  | 'malformed';

export interface ParseUpdateOptions {
  /** Bot username for stripping `@botusername` suffix on commands. */
  botUsername?: string;
}

/**
 * Parse a Telegram Update envelope into a tagged union the Brain
 * handler can switch on.
 */
export function parseUpdate(
  update: TelegramUpdate,
  opts: ParseUpdateOptions = {},
): ParsedTelegramUpdate {
  if (!update || typeof update !== 'object') {
    return { kind: 'ignored', reason: 'malformed' };
  }

  if (update.edited_message) {
    return { kind: 'ignored', reason: 'edited_message' };
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    if (!cq.message || typeof cq.id !== 'string' || cq.id === '') {
      return { kind: 'ignored', reason: 'malformed' };
    }
    if (typeof cq.data !== 'string' || cq.data === '') {
      return { kind: 'ignored', reason: 'no_callback_data' };
    }
    return {
      kind: 'callback',
      chatId: cq.message.chat.id,
      callbackId: cq.id,
      sender: normaliseSender(cq.from),
      data: cq.data,
    };
  }

  const message = update.message;
  if (!message) return { kind: 'ignored', reason: 'no_content' };
  if (typeof message.text !== 'string' || message.text === '') {
    return { kind: 'ignored', reason: 'no_text' };
  }

  const sender = normaliseSender(message.from);
  const commandEntity = message.entities?.find(
    (e) => e.type === 'bot_command' && e.offset === 0,
  );
  if (commandEntity) {
    const commandRaw = message.text.slice(0, commandEntity.length);
    const after = message.text.slice(commandEntity.length).trim();
    const command = stripBotSuffix(commandRaw, opts.botUsername);
    const argv = after === '' ? [] : after.split(/\s+/);
    return {
      kind: 'command',
      chatId: message.chat.id,
      messageId: message.message_id,
      sender,
      command,
      argv,
      raw: message.text,
    };
  }

  return {
    kind: 'text',
    chatId: message.chat.id,
    messageId: message.message_id,
    sender,
    text: message.text,
  };
}

// ── Outbound rendering ─────────────────────────────────────────────────

export type TelegramParseMode = 'MarkdownV2' | 'HTML' | 'plain';

export interface SendMessageSpec {
  chatId: number;
  text: string;
  parseMode?: TelegramParseMode;
  replyToMessageId?: number;
  disableNotification?: boolean;
  /** Optional inline-keyboard markup — pass-through to Telegram. */
  replyMarkup?: Record<string, unknown>;
}

export interface TelegramSendMessageBody {
  chat_id: number;
  text: string;
  parse_mode?: 'MarkdownV2' | 'HTML';
  reply_to_message_id?: number;
  disable_notification?: boolean;
  reply_markup?: Record<string, unknown>;
}

export function renderSendMessage(spec: SendMessageSpec): TelegramSendMessageBody {
  validateSendSpec(spec);
  const text =
    spec.parseMode === 'MarkdownV2'
      ? escapeMarkdownV2(spec.text)
      : spec.text;
  const body: TelegramSendMessageBody = {
    chat_id: spec.chatId,
    text,
  };
  if (spec.parseMode && spec.parseMode !== 'plain') {
    body.parse_mode = spec.parseMode;
  }
  if (spec.replyToMessageId !== undefined) {
    body.reply_to_message_id = spec.replyToMessageId;
  }
  if (spec.disableNotification !== undefined) {
    body.disable_notification = spec.disableNotification;
  }
  if (spec.replyMarkup !== undefined) {
    body.reply_markup = spec.replyMarkup;
  }
  return body;
}

export interface EditMessageSpec {
  chatId: number;
  messageId: number;
  text: string;
  parseMode?: TelegramParseMode;
  replyMarkup?: Record<string, unknown>;
}

export interface TelegramEditMessageBody {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: 'MarkdownV2' | 'HTML';
  reply_markup?: Record<string, unknown>;
}

export function renderEditMessage(spec: EditMessageSpec): TelegramEditMessageBody {
  if (typeof spec?.chatId !== 'number' || !Number.isInteger(spec.chatId)) {
    throw new TypeError('renderEditMessage: chatId must be an integer');
  }
  if (typeof spec.messageId !== 'number' || !Number.isInteger(spec.messageId)) {
    throw new TypeError('renderEditMessage: messageId must be an integer');
  }
  if (typeof spec.text !== 'string' || spec.text === '') {
    throw new TypeError('renderEditMessage: text required');
  }
  const text =
    spec.parseMode === 'MarkdownV2' ? escapeMarkdownV2(spec.text) : spec.text;
  const body: TelegramEditMessageBody = {
    chat_id: spec.chatId,
    message_id: spec.messageId,
    text,
  };
  if (spec.parseMode && spec.parseMode !== 'plain') {
    body.parse_mode = spec.parseMode;
  }
  if (spec.replyMarkup !== undefined) {
    body.reply_markup = spec.replyMarkup;
  }
  return body;
}

/**
 * Escape MarkdownV2 reserved characters per
 * https://core.telegram.org/bots/api#markdownv2-style. The 18
 * reserved characters are `_ * [ ] ( ) ~ ` > # + - = | { } . !`.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ── Internals ──────────────────────────────────────────────────────────

function normaliseSender(user?: TelegramUser): NormalisedSender | null {
  if (!user || typeof user.id !== 'number') return null;
  const parts: string[] = [];
  if (user.first_name) parts.push(user.first_name);
  if (user.last_name) parts.push(user.last_name);
  const displayName =
    parts.length > 0
      ? parts.join(' ')
      : (user.username ?? `tg:${user.id}`);
  return {
    id: user.id,
    displayName,
    username: user.username ?? null,
    isBot: user.is_bot === true,
  };
}

function stripBotSuffix(
  command: string,
  botUsername: string | undefined,
): string {
  const at = command.indexOf('@');
  if (at === -1) return command;
  if (botUsername !== undefined) {
    const suffix = command.slice(at + 1).toLowerCase();
    if (suffix !== botUsername.toLowerCase()) {
      // Command is aimed at a different bot — return as-is so the
      // caller can ignore it if it wants, but we don't strip.
      return command;
    }
  }
  return command.slice(0, at);
}

function validateSendSpec(spec: SendMessageSpec): void {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('renderSendMessage: spec required');
  }
  if (typeof spec.chatId !== 'number' || !Number.isInteger(spec.chatId)) {
    throw new TypeError('renderSendMessage: chatId must be an integer');
  }
  if (typeof spec.text !== 'string' || spec.text === '') {
    throw new TypeError('renderSendMessage: text required');
  }
}
