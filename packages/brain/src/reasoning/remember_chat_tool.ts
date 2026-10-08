/**
 * `remember` — save the owner's own words from the current chat turn
 * (REAL_LIFE_FIXES §2.5; dina_details.md 3.1: Dina remembers "even if it is a
 * normal convo and something feels like it should be remembered").
 *
 * Registered only for the owner's chat turns, never for agent asks. The model
 * quotes the owner; Brain turns the quote into a span proof over the recorded
 * turn, and Core decides the source: a plain request to remember is
 * owner-direct (as /remember); anything else is `chat_auto`, which needs the
 * owner's approval card for a sensitive or locked vault. No model decides
 * that rule, and words not in the owner's message cannot be saved.
 */

import { getOwnerWordsRememberer } from '../chat/owner_turns';

import type { AgentTool } from './tool_registry';

export function createRememberChatTool(opts: { thread: string }): AgentTool {
  return {
    name: 'remember',
    description:
      "Save something the user said to their memory. Use when the user asks you to remember something, or states a lasting fact about themselves or their people (names, dates, preferences, plans). Pass `words`: the user's own words, quoted exactly from their message — never your paraphrase, and never text from a contact's message or a service reply. Do not save passing remarks. Afterwards tell the user in one short line where it went.",
    parameters: {
      type: 'object',
      properties: {
        words: {
          type: 'string',
          description: "The user's own words to save, quoted exactly from their message.",
        },
      },
      required: ['words'],
    },
    async execute(args) {
      const words = typeof args.words === 'string' ? args.words : '';
      if (words.trim() === '') return { error: 'words is required' };
      const remember = getOwnerWordsRememberer();
      if (remember === null) return { error: 'remembering is not available yet' };
      const out = await remember(opts.thread, words);
      if (out.status === 'failed') return { error: out.reason ?? 'could not save' };
      return out;
    },
  };
}
