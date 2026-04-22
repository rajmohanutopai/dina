/**
 * telegram_adapter tests (GAP.md #25 closure).
 */

import {
  escapeMarkdownV2,
  parseUpdate,
  renderEditMessage,
  renderSendMessage,
  type TelegramUpdate,
} from '../src/brain/telegram_adapter';

function textMessageUpdate(text: string, entities: Array<{ type: string; offset: number; length: number }> = []): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 42, first_name: 'Alice', last_name: 'Smith', username: 'alice', is_bot: false },
      chat: { id: -100, type: 'private' },
      text,
      entities,
    },
  };
}

describe('parseUpdate — input handling', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['non-object', 'bogus'],
  ] as const)('%s → ignored malformed', (_l, bad) => {
    const r = parseUpdate(bad as unknown as TelegramUpdate);
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toBe('malformed');
  });

  it('edited_message → ignored', () => {
    const r = parseUpdate({
      edited_message: {
        message_id: 1,
        chat: { id: 1 },
        text: 'hi',
      },
    });
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toBe('edited_message');
  });

  it('message without text → ignored no_text', () => {
    const r = parseUpdate({
      message: { message_id: 1, chat: { id: 1 } },
    });
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toBe('no_text');
  });

  it('empty envelope → ignored no_content', () => {
    const r = parseUpdate({});
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toBe('no_content');
  });
});

describe('parseUpdate — text messages', () => {
  it('plain text → kind=text with sender info', () => {
    const r = parseUpdate(textMessageUpdate('Hello Dina'));
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.text).toBe('Hello Dina');
      expect(r.chatId).toBe(-100);
      expect(r.messageId).toBe(10);
      expect(r.sender).toEqual({
        id: 42,
        displayName: 'Alice Smith',
        username: 'alice',
        isBot: false,
      });
    }
  });

  it('sender without names falls back to username', () => {
    const update: TelegramUpdate = {
      message: {
        message_id: 1,
        from: { id: 7, username: 'onlyusername' },
        chat: { id: 1 },
        text: 'hi',
      },
    };
    const r = parseUpdate(update);
    if (r.kind === 'text') expect(r.sender?.displayName).toBe('onlyusername');
  });

  it('sender with only first_name works', () => {
    const update: TelegramUpdate = {
      message: {
        message_id: 1,
        from: { id: 7, first_name: 'Alice' },
        chat: { id: 1 },
        text: 'hi',
      },
    };
    const r = parseUpdate(update);
    if (r.kind === 'text') expect(r.sender?.displayName).toBe('Alice');
  });

  it('no sender → sender is null', () => {
    const update: TelegramUpdate = {
      message: { message_id: 1, chat: { id: 1 }, text: 'anon' },
    };
    const r = parseUpdate(update);
    if (r.kind === 'text') expect(r.sender).toBeNull();
  });
});

describe('parseUpdate — commands', () => {
  it('/help with no argv', () => {
    const r = parseUpdate(
      textMessageUpdate('/help', [{ type: 'bot_command', offset: 0, length: 5 }]),
    );
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command).toBe('/help');
      expect(r.argv).toEqual([]);
      expect(r.raw).toBe('/help');
    }
  });

  it('/search foo bar → argv splits on whitespace', () => {
    const r = parseUpdate(
      textMessageUpdate('/search foo bar baz', [
        { type: 'bot_command', offset: 0, length: 7 },
      ]),
    );
    if (r.kind === 'command') {
      expect(r.command).toBe('/search');
      expect(r.argv).toEqual(['foo', 'bar', 'baz']);
    }
  });

  it('/help@myBot — strips bot suffix when username matches', () => {
    const r = parseUpdate(
      textMessageUpdate('/help@myBot extra', [
        { type: 'bot_command', offset: 0, length: 11 },
      ]),
      { botUsername: 'myBot' },
    );
    if (r.kind === 'command') {
      expect(r.command).toBe('/help');
      expect(r.argv).toEqual(['extra']);
    }
  });

  it('/help@otherBot — keeps suffix when username mismatches', () => {
    const r = parseUpdate(
      textMessageUpdate('/help@otherBot', [
        { type: 'bot_command', offset: 0, length: 14 },
      ]),
      { botUsername: 'myBot' },
    );
    if (r.kind === 'command') {
      expect(r.command).toBe('/help@otherBot');
    }
  });

  it('/help@anyBot — strips suffix when botUsername not configured', () => {
    const r = parseUpdate(
      textMessageUpdate('/help@anyBot', [
        { type: 'bot_command', offset: 0, length: 12 },
      ]),
    );
    if (r.kind === 'command') {
      expect(r.command).toBe('/help');
    }
  });

  it('command entity not at offset 0 → treated as text', () => {
    // "hello /help" — bot_command entity at offset 6.
    const r = parseUpdate(
      textMessageUpdate('hello /help', [
        { type: 'bot_command', offset: 6, length: 5 },
      ]),
    );
    expect(r.kind).toBe('text');
  });
});

describe('parseUpdate — callback queries', () => {
  it('valid callback → kind=callback', () => {
    const r = parseUpdate({
      callback_query: {
        id: 'cb-1',
        from: { id: 42, first_name: 'Alice' },
        message: { message_id: 5, chat: { id: -100 }, text: 'menu' },
        data: 'action:confirm',
      },
    });
    expect(r.kind).toBe('callback');
    if (r.kind === 'callback') {
      expect(r.callbackId).toBe('cb-1');
      expect(r.data).toBe('action:confirm');
      expect(r.chatId).toBe(-100);
      expect(r.sender?.displayName).toBe('Alice');
    }
  });

  it('callback without data → ignored no_callback_data', () => {
    const r = parseUpdate({
      callback_query: {
        id: 'cb-1',
        message: { message_id: 5, chat: { id: 1 } },
      },
    });
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toBe('no_callback_data');
  });

  it('callback without message → ignored malformed', () => {
    const r = parseUpdate({
      callback_query: { id: 'cb-1', data: 'x' },
    });
    if (r.kind === 'ignored') expect(r.reason).toBe('malformed');
  });
});

describe('renderSendMessage', () => {
  it('plain text → chat_id + text + default no parse_mode', () => {
    const body = renderSendMessage({ chatId: 100, text: 'hello' });
    expect(body).toEqual({ chat_id: 100, text: 'hello' });
  });

  it('MarkdownV2 escapes reserved chars', () => {
    const body = renderSendMessage({
      chatId: 100,
      text: 'Bill: $5.00',
      parseMode: 'MarkdownV2',
    });
    expect(body.parse_mode).toBe('MarkdownV2');
    expect(body.text).toBe('Bill: $5\\.00');
  });

  it('HTML mode leaves text unchanged + sets parse_mode', () => {
    const body = renderSendMessage({
      chatId: 1,
      text: '<b>bold</b>',
      parseMode: 'HTML',
    });
    expect(body.text).toBe('<b>bold</b>');
    expect(body.parse_mode).toBe('HTML');
  });

  it('plain parseMode does NOT set parse_mode on the body', () => {
    const body = renderSendMessage({
      chatId: 1,
      text: 'x',
      parseMode: 'plain',
    });
    expect(body.parse_mode).toBeUndefined();
  });

  it('optional fields pass through when provided', () => {
    const body = renderSendMessage({
      chatId: 1,
      text: 'hi',
      replyToMessageId: 99,
      disableNotification: true,
      replyMarkup: { inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] },
    });
    expect(body.reply_to_message_id).toBe(99);
    expect(body.disable_notification).toBe(true);
    expect(body.reply_markup).toBeDefined();
  });

  it.each([
    ['null spec', null],
    ['empty text', { chatId: 1, text: '' }],
    ['missing chatId', { text: 'x' }],
    ['non-integer chatId', { chatId: 1.5, text: 'x' }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      renderSendMessage(bad as unknown as Parameters<typeof renderSendMessage>[0]),
    ).toThrow();
  });
});

describe('renderEditMessage', () => {
  it('produces edit body with chat_id + message_id + text', () => {
    const body = renderEditMessage({ chatId: 1, messageId: 5, text: 'updated' });
    expect(body).toEqual({ chat_id: 1, message_id: 5, text: 'updated' });
  });

  it('MarkdownV2 escapes + sets parse_mode', () => {
    const body = renderEditMessage({
      chatId: 1,
      messageId: 5,
      text: 'Total: $1.00',
      parseMode: 'MarkdownV2',
    });
    expect(body.text).toBe('Total: $1\\.00');
    expect(body.parse_mode).toBe('MarkdownV2');
  });

  it.each([
    ['missing chatId', { messageId: 5, text: 'x' }],
    ['missing messageId', { chatId: 1, text: 'x' }],
    ['empty text', { chatId: 1, messageId: 5, text: '' }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      renderEditMessage(bad as unknown as Parameters<typeof renderEditMessage>[0]),
    ).toThrow();
  });
});

describe('escapeMarkdownV2', () => {
  it('escapes every reserved character', () => {
    const reserved = '_*[]()~`>#+-=|{}.!';
    const escaped = escapeMarkdownV2(reserved);
    for (const ch of reserved) {
      expect(escaped).toContain(`\\${ch}`);
    }
  });

  it('leaves non-reserved text unchanged', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world');
  });

  it('escapes parenthesised emphasis correctly', () => {
    expect(escapeMarkdownV2('(hi)')).toBe('\\(hi\\)');
  });
});
