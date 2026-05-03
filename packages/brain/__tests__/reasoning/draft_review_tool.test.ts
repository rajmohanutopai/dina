/**
 * Unit tests for the `draft_review` tool factory.
 *
 * The tool replaces the older mobile-side regex pre-empt
 * (`parseReviewDraftIntent`). The agentic loop's LLM picks the tool
 * from the user's natural-language query; the tool delegates to a
 * host-registered `ReviewDraftStarter` (mobile wires
 * `startReviewDraft`).
 *
 * These specs pin the tool's contract independently of any host:
 *   - validates `subject_phrase` (non-empty, trims whitespace).
 *   - returns `{ ok: false }` when no starter is wired (server-side
 *     bot, headless demo).
 *   - calls the registered starter with the trimmed phrase and
 *     surfaces its `draftId` back to the agent.
 *   - failure inside the starter surfaces as `{ ok: false, reason }`
 *     rather than throwing.
 *   - tool description + parameters schema are LLM-facing — pin their
 *     shape so a refactor doesn't silently break tool-calling.
 */

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  createDraftReviewTool,
  setReviewDraftStarter,
  getReviewDraftStarter,
} from '../../src/reasoning/draft_review_tool';

afterEach(() => {
  setReviewDraftStarter(null);
});

describe('createDraftReviewTool', () => {
  it('exposes the LLM-facing name + description + JSON Schema', () => {
    const tool = createDraftReviewTool();
    expect(tool.name).toBe('draft_review');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { subject_phrase: { type: 'string' } },
      required: ['subject_phrase'],
    });
  });

  it('returns ok:false when subject_phrase is missing', async () => {
    const tool = createDraftReviewTool();
    const out = (await tool.execute({})) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/subject_phrase/i);
  });

  it('returns ok:false when subject_phrase is empty / whitespace', async () => {
    const tool = createDraftReviewTool();
    expect(((await tool.execute({ subject_phrase: '' })) as { ok: boolean }).ok).toBe(false);
    expect(((await tool.execute({ subject_phrase: '   ' })) as { ok: boolean }).ok).toBe(false);
  });

  it('returns ok:false when no starter is wired (server / headless host)', async () => {
    const tool = createDraftReviewTool();
    setReviewDraftStarter(null);
    const out = (await tool.execute({ subject_phrase: 'Aeron Chair' })) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/starter is not wired/i);
  });

  it('calls the registered starter with the trimmed phrase + surfaces draftId', async () => {
    const captured: string[] = [];
    setReviewDraftStarter(async (phrase) => {
      captured.push(phrase);
      return { draftId: 'draft-xyz' };
    });
    const tool = createDraftReviewTool();
    const out = (await tool.execute({ subject_phrase: '  Aeron Chair  ' })) as {
      ok: boolean;
      draftId?: string;
      message?: string;
    };
    expect(captured).toEqual(['Aeron Chair']);
    expect(out.ok).toBe(true);
    expect(out.draftId).toBe('draft-xyz');
    // Message should hint the agent NOT to repeat the draft contents.
    expect(out.message).toMatch(/draft is ready/i);
    expect(out.message).toMatch(/do not repeat|in the card/i);
  });

  it('returns ok:false when the starter throws', async () => {
    setReviewDraftStarter(async () => {
      throw new Error('boom');
    });
    const tool = createDraftReviewTool();
    const out = (await tool.execute({ subject_phrase: 'Aeron Chair' })) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('boom');
  });

  it('setReviewDraftStarter / getReviewDraftStarter round-trip', () => {
    expect(getReviewDraftStarter()).toBeNull();
    const fn = async () => ({ draftId: 'a' });
    setReviewDraftStarter(fn);
    expect(getReviewDraftStarter()).toBe(fn);
    setReviewDraftStarter(null);
    expect(getReviewDraftStarter()).toBeNull();
  });
});
