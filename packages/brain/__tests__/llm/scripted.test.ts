/**
 * Scripted LLM provider — the deterministic canned-response stand-in for E2E.
 * First matching rule wins (substring, case-insensitive, over system prompt +
 * messages); empty match is the fallback; strict mode fails loud on a miss.
 */

import { ScriptedLLMProvider, buildScriptedProvider } from '../../src/llm/adapters/scripted';

import type { ChatMessage } from '../../src/llm/adapters/provider';

const user = (content: string): ChatMessage => ({ role: 'user', content });

describe('ScriptedLLMProvider', () => {
  it('returns the first rule whose match substring appears in the messages', async () => {
    const p = buildScriptedProvider({
      rules: [
        { match: 'route 42', content: '{"eta_minutes":7}' },
        { match: '', content: '{}' },
      ],
    });
    const res = await p.chat([user('What is the ETA for Route 42 at Castro?')]);
    expect(res.content).toBe('{"eta_minutes":7}');
    expect(res.finishReason).toBe('end');
    expect(res.model).toBe('scripted');
  });

  it('matches case-insensitively and against the system prompt', async () => {
    const p = buildScriptedProvider({ rules: [{ match: 'DISPATCHER', content: 'ok' }] });
    const res = await p.chat([user('hi')], { systemPrompt: 'You are the live dispatcher.' });
    expect(res.content).toBe('ok');
  });

  it('uses the empty-match rule as a fallback', async () => {
    const p = buildScriptedProvider({
      rules: [
        { match: 'never', content: 'no' },
        { match: '', content: 'fallback' },
      ],
    });
    expect((await p.chat([user('anything')])).content).toBe('fallback');
  });

  it('emits tool_use with the scripted tool calls', async () => {
    const p = buildScriptedProvider({
      rules: [
        {
          match: 'search',
          content: '',
          toolCalls: [{ name: 'vault_search', arguments: { query: 'x' } }],
        },
      ],
    });
    const res = await p.chat([user('please search')]);
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ name: 'vault_search', arguments: { query: 'x' } }]);
  });

  it('throws in strict mode (default) when no rule matches', async () => {
    const p = new ScriptedLLMProvider({ rules: [{ match: 'nope', content: 'x' }] });
    await expect(p.chat([user('unmatched')])).rejects.toThrow(/no rule matched/);
  });

  it('returns {} in non-strict mode when no rule matches', async () => {
    const p = new ScriptedLLMProvider({ rules: [{ match: 'nope', content: 'x' }], strict: false });
    expect((await p.chat([user('unmatched')])).content).toBe('{}');
  });

  it('does not support streaming or embedding (fail loud)', async () => {
    const p = buildScriptedProvider({ rules: [{ match: '', content: '{}' }] });
    expect(p.supportsEmbedding).toBe(false);
    await expect(p.embed('x')).rejects.toThrow(/not supported/);
  });
});
