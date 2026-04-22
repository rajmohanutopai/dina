/**
 * T4.8/4.9 — Chat command parser: /remember, /ask, question detection.
 *
 * Source: ARCHITECTURE.md Tasks 4.8, 4.9
 */

import { parseCommand, isQuestion, getAvailableCommands } from '../../src/chat/command_parser';

describe('Chat Command Parser', () => {
  describe('explicit slash commands', () => {
    it('/remember stores the payload', () => {
      const cmd = parseCommand("/remember Emma's birthday is March 15");
      expect(cmd.intent).toBe('remember');
      expect(cmd.payload).toBe("Emma's birthday is March 15");
      expect(cmd.explicit).toBe(true);
    });

    it('/ask routes to ask intent', () => {
      const cmd = parseCommand("/ask When is Emma's birthday?");
      expect(cmd.intent).toBe('ask');
      expect(cmd.payload).toBe("When is Emma's birthday?");
      expect(cmd.explicit).toBe(true);
    });

    it('/search routes to search intent', () => {
      const cmd = parseCommand('/search meeting notes');
      expect(cmd.intent).toBe('search');
      expect(cmd.payload).toBe('meeting notes');
    });

    it('/help returns help intent with empty payload', () => {
      const cmd = parseCommand('/help');
      expect(cmd.intent).toBe('help');
      expect(cmd.payload).toBe('');
    });

    it('unknown slash command → chat', () => {
      const cmd = parseCommand('/unknown something');
      expect(cmd.intent).toBe('chat');
    });

    it('preserves original text', () => {
      const cmd = parseCommand('/remember test');
      expect(cmd.originalText).toBe('/remember test');
    });

    it('handles extra whitespace in payload', () => {
      const cmd = parseCommand('/remember   lots of   spaces  ');
      expect(cmd.intent).toBe('remember');
      expect(cmd.payload).toBe('lots of   spaces');
    });

    it('case-insensitive command', () => {
      const cmd = parseCommand('/REMEMBER uppercase');
      expect(cmd.intent).toBe('remember');
    });
  });

  describe('implicit question detection', () => {
    it('question mark → ask', () => {
      const cmd = parseCommand('Is Alice coming to the party?');
      expect(cmd.intent).toBe('ask');
      expect(cmd.explicit).toBe(false);
    });

    it('starts with "when" → ask', () => {
      const cmd = parseCommand("When is Emma's birthday");
      expect(cmd.intent).toBe('ask');
    });

    it('starts with "what" → ask', () => {
      const cmd = parseCommand('What does Alice like');
      expect(cmd.intent).toBe('ask');
    });

    it('starts with "who" → ask', () => {
      const cmd = parseCommand('Who was at the meeting');
      expect(cmd.intent).toBe('ask');
    });

    it('starts with "how" → ask', () => {
      const cmd = parseCommand('How do I reset my password');
      expect(cmd.intent).toBe('ask');
    });

    it('starts with "does" → ask', () => {
      const cmd = parseCommand('Does Bob like coffee');
      expect(cmd.intent).toBe('ask');
    });

    it('starts with "can" → ask', () => {
      const cmd = parseCommand('Can you find my meeting notes');
      expect(cmd.intent).toBe('ask');
    });

    it('statement → chat (not a question)', () => {
      const cmd = parseCommand('Remember to call Alice');
      expect(cmd.intent).toBe('chat');
    });
  });

  describe('edge cases', () => {
    it('empty string → chat', () => {
      expect(parseCommand('').intent).toBe('chat');
    });

    it('whitespace only → chat', () => {
      expect(parseCommand('   ').intent).toBe('chat');
    });

    it('regular chat message → chat', () => {
      const cmd = parseCommand('Hello Dina, how are you today?');
      expect(cmd.intent).toBe('ask'); // ends with ?
    });

    it('statement without question marks → chat', () => {
      const cmd = parseCommand('I had a great day');
      expect(cmd.intent).toBe('chat');
    });
  });

  describe('isQuestion', () => {
    it('question mark → true', () => expect(isQuestion('Is this a test?')).toBe(true));
    it('"when" → true', () => expect(isQuestion('When is it')).toBe(true));
    it('"what" → true', () => expect(isQuestion('What happened')).toBe(true));
    it('statement → false', () => expect(isQuestion('Nice weather today')).toBe(false));
    it('"should" → true', () => expect(isQuestion('Should I bring a gift')).toBe(true));
  });

  describe('getAvailableCommands', () => {
    it('returns command list with descriptions', () => {
      const commands = getAvailableCommands();
      expect(commands.length).toBeGreaterThanOrEqual(4);
      expect(commands.map((c) => c.command)).toContain('/help');
      expect(commands.every((c) => c.description.length > 0)).toBe(true);
    });
  });
});
