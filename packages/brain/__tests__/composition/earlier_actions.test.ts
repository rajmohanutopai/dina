/**
 * PH-S14 (docs/STATE_MACHINES.md): an owner chat turn carries what earlier
 * turns did, from their receipts. The history held Dina's earlier "I've sent
 * Sancho your message" without the tool result behind it, so the model read
 * it as unsupported and told the owner the message was never sent. Found on
 * the simulator, 2026-11-08.
 */

import { addMessage, resetThreads } from '../../src/chat/thread';
import { earlierActionsBlock, storeTurnReceipts } from '../../src/chat/turn_receipts';
import { buildAgenticExecuteFn } from '../../src/composition/ask_coordinator';
import { ToolRegistry } from '../../src/reasoning/tool_registry';

import type { AgenticAskPipeline } from '../../src/composition/agentic_ask';
import type { ActionReceipt } from '../../src/guardian/action_claims';

const SENT: ActionReceipt = {
  action: 'send',
  status: 'done',
  targets: ['Sancho'],
  object: "I'm coming tomorrow morning.",
};

function pipeline(prompts: string[]): AgenticAskPipeline {
  return {
    provider: {
      name: 'fake',
      chat: async (_messages: unknown, options?: { systemPrompt?: string }) => {
        prompts.push(options?.systemPrompt ?? '');
        return {
          content: 'Here you go.',
          toolCalls: [],
          model: 'fake',
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'stop',
        };
      },
    } as never,
    tools: new ToolRegistry(),
    buildToolsForAsk: () => new ToolRegistry(),
    ownerDid: 'did:plc:owner',
    router: {} as never,
    handlerOptions: {},
  } as AgenticAskPipeline;
}

beforeEach(() => resetThreads());
afterAll(() => resetThreads());

describe('earlierActionsBlock', () => {
  it('lists each earlier action as done, in Core’s words', () => {
    const block = earlierActionsBlock([SENT]);
    expect(block).toContain('Do not take it back');
    expect(block).toContain('- Already sent to Sancho earlier: "I\'m coming tomorrow morning."');
  });

  it('is empty with nothing done', () => {
    expect(earlierActionsBlock([])).toBe('');
  });
});

describe('an owner chat turn', () => {
  it('tells the model what earlier turns did', async () => {
    addMessage('main', 'user', "tell Sancho I'm coming tomorrow morning");
    storeTurnReceipts('main', "tell Sancho I'm coming tomorrow morning", [SENT]);
    addMessage('main', 'dina', "I've sent Sancho your message.");
    addMessage('main', 'user', 'Who owes me something?');

    const prompts: string[] = [];
    const exec = buildAgenticExecuteFn({ pipeline: pipeline(prompts), systemPrompt: 'x' });
    await exec({
      id: 'o1',
      question: 'Who owes me something?',
      requesterDid: 'did:plc:owner',
      conversation: 'main',
    });
    expect(prompts[0]).toContain('Already sent to Sancho earlier');
  });

  it('says nothing when earlier turns did nothing', async () => {
    addMessage('main', 'user', 'What time is it in Lisbon?');
    addMessage('main', 'dina', 'About 3 pm.');
    addMessage('main', 'user', 'And in Porto?');
    const prompts: string[] = [];
    const exec = buildAgenticExecuteFn({ pipeline: pipeline(prompts), systemPrompt: 'x' });
    await exec({
      id: 'o2',
      question: 'And in Porto?',
      requesterDid: 'did:plc:owner',
      conversation: 'main',
    });
    expect(prompts[0]).not.toContain('Done earlier in this conversation');
  });
});
