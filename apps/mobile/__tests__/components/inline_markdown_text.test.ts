/**
 * Tokenizer unit tests for `InlineMarkdownText`.
 *
 * Only the pure `__tokenizeForTest` is exercised — rendering needs an
 * RN runtime, which jest in this workspace doesn't load (matches the
 * `safe_url.test.ts` pattern: pure-string helpers tested at the unit
 * level, render paths verified manually on the sim).
 */

import { __tokenizeForTest as tokenize } from '../../src/components/InlineMarkdownText';

describe('InlineMarkdownText tokenizer', () => {
  test('plain text → single text token', () => {
    expect(tokenize('hello world')).toEqual([{ kind: 'text', value: 'hello world' }]);
  });

  test('bold span — the LLM emphasis the user actually sees', () => {
    // Mirrors the screenshot: `**Acme Inc**` should not leak literal **.
    expect(tokenize('you work at **Acme Inc**.')).toEqual([
      { kind: 'text', value: 'you work at ' },
      { kind: 'bold', value: 'Acme Inc' },
      { kind: 'text', value: '.' },
    ]);
  });

  test('bold spans numbers / dates', () => {
    expect(tokenize('runs around **138/88**.')).toEqual([
      { kind: 'text', value: 'runs around ' },
      { kind: 'bold', value: '138/88' },
      { kind: 'text', value: '.' },
    ]);
  });

  test('italic single-asterisk span', () => {
    expect(tokenize('really *important* point')).toEqual([
      { kind: 'text', value: 'really ' },
      { kind: 'italic', value: 'important' },
      { kind: 'text', value: ' point' },
    ]);
  });

  test('code backtick span', () => {
    expect(tokenize('the `vault_search` tool')).toEqual([
      { kind: 'text', value: 'the ' },
      { kind: 'code', value: 'vault_search' },
      { kind: 'text', value: ' tool' },
    ]);
  });

  test('multiple bold spans in one paragraph', () => {
    expect(tokenize('**A** and **B**')).toEqual([
      { kind: 'bold', value: 'A' },
      { kind: 'text', value: ' and ' },
      { kind: 'bold', value: 'B' },
    ]);
  });

  test('paragraph break stays as plain text (RN <Text> renders \\n)', () => {
    // No paragraph token — newlines pass through so RN's wrap handles them.
    expect(tokenize('para one\n\npara **two**')).toEqual([
      { kind: 'text', value: 'para one\n\npara ' },
      { kind: 'bold', value: 'two' },
    ]);
  });

  test('empty marker (`****`) does not match', () => {
    expect(tokenize('a **** b')).toEqual([{ kind: 'text', value: 'a **** b' }]);
  });

  test('unbalanced ** falls through as literal', () => {
    // The user's screenshot bug was exactly this: literal ** in output.
    // If somehow only one ** is present, we shouldn't half-match.
    expect(tokenize('Acme** Inc')).toEqual([{ kind: 'text', value: 'Acme** Inc' }]);
  });

  test('span cannot cross a newline (paragraph isolation)', () => {
    // The `[^*\n]` class in TOKEN_RE prevents bold spans from spanning
    // a paragraph break — matches how iMessage / Slack parse.
    expect(tokenize('**bold\nspan**')).toEqual([
      { kind: 'text', value: '**bold\nspan**' },
    ]);
  });

  test('mixed bold + code in one message', () => {
    expect(tokenize('Stored in **Work** via `vault.store`.')).toEqual([
      { kind: 'text', value: 'Stored in ' },
      { kind: 'bold', value: 'Work' },
      { kind: 'text', value: ' via ' },
      { kind: 'code', value: 'vault.store' },
      { kind: 'text', value: '.' },
    ]);
  });
});
