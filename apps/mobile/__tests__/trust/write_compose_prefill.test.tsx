/**
 * Integration tests for the WriteScreen + compose-context prefill
 * end-to-end: hook fires on form open, fields populate, ✨ markers
 * surface, toggle copy reflects "Dina prefilled" state, user-touch
 * clears the markers.
 *
 * Mocks `queryVault` at the module boundary so the test can seed
 * synthetic vault items deterministically. Injects a stub LLMProvider
 * directly into WriteScreen via the `composeLLMProvider` test prop —
 * production resolves the BYOK provider on its own (`loadActiveProvider`
 * + `createLLMProvider`), but the test path swaps that for a canned
 * structured-JSON response so the prefill is deterministic.
 *
 * The other tests in `write.render.test.tsx` deliberately stay unaware
 * of the hook — they run with `composeContextEnabled: false` (or
 * queryVault returns empty by default) and pin pure form behaviour.
 */

import React from 'react';
import { render, act, fireEvent } from '@testing-library/react-native';

jest.mock('@dina/core/src/vault/crud', () => ({
  __esModule: true,
  queryVault: jest.fn(),
}));

import * as vaultCrud from '@dina/core/src/vault/crud';
import WriteScreen from '../../app/trust/write';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
} from '@dina/brain/src/llm/adapters/provider';

const queryVaultMock = vaultCrud.queryVault as jest.MockedFunction<typeof vaultCrud.queryVault>;

beforeEach(() => {
  queryVaultMock.mockReset();
});

const NOW = Date.parse('2026-05-02T12:00:00Z');

function makeVaultItem(overrides: Partial<{ id: string; body: string; timestamp: number }>) {
  return {
    id: overrides.id ?? 'a',
    type: 'note',
    source: 'local',
    source_id: '',
    contact_did: '',
    summary: '',
    body: overrides.body ?? '',
    metadata: '',
    tags: '',
    timestamp: overrides.timestamp ?? NOW,
    created_at: 0,
    updated_at: 0,
    deleted: 0,
    sender: '',
    sender_trust: '',
    source_type: '',
    confidence: '',
    retrieval_policy: '',
    contradicts: '',
    content_l0: '',
    content_l1: '',
    enrichment_status: '',
    enrichment_version: '',
  };
}

function stubLLM(content: string): LLMProvider {
  const chat = jest.fn<(messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>>();
  chat.mockResolvedValue({
    content,
    toolCalls: [],
    model: 'stub',
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: 'end',
  });
  return {
    name: 'stub',
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsEmbedding: false,
    chat,
    stream: async function* () {
      yield { type: 'done' };
    },
    embed: async () => ({
      embedding: new Float64Array(),
      model: 'stub',
      dimensions: 0,
    }),
  };
}

describe('WriteScreen + compose-context prefill', () => {
  // The form is now a 3-step wizard. Step 1 shows a prefill banner
  // when Dina populated any Step-2/3 field from the vault — a quiet
  // nudge that reaching Step 2 has value. Silent when nothing was
  // prefilled (Silence First).
  it('shows the prefill banner on Step 1 when Dina populated fields', async () => {
    queryVaultMock.mockReturnValue([
      makeVaultItem({
        id: 'a',
        body: 'I sit in this Aeron chair at the office every day',
        timestamp: NOW - 6 * 60 * 60 * 1000,
      }),
    ] as never);
    const llm = stubLLM(
      JSON.stringify({ use_cases: ['office'], last_used_bucket: 'today' }),
    );
    const { findByTestId, findByText } = render(
      <WriteScreen subjectTitle="Aeron chair" composeLLMProvider={llm} composePersonas={['general']} />,
    );
    const banner = await findByTestId('write-prefill-banner');
    expect(banner).toBeTruthy();
    const copy = await findByText(/Dina prefilled/);
    expect(copy).toBeTruthy();
  });

  it('hides the prefill banner when vault has no relevant items', async () => {
    queryVaultMock.mockReturnValue([] as never);
    const llm = stubLLM(JSON.stringify({}));
    const { queryByTestId } = render(
      <WriteScreen subjectTitle="Aeron chair" composeLLMProvider={llm} composePersonas={['general']} />,
    );
    // The compose-context runner is async; flush microtasks so any
    // would-be prefill has had a chance to fire before we assert
    // its absence.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryByTestId('write-prefill-banner')).toBeNull();
  });

  it('hides the prefill banner when no LLM provider is configured', async () => {
    queryVaultMock.mockReturnValue([
      makeVaultItem({
        id: 'a',
        body: 'home office every day',
        timestamp: NOW - 6 * 60 * 60 * 1000,
      }),
    ] as never);
    const { queryByTestId } = render(
      <WriteScreen subjectTitle="Aeron chair" composeLLMProvider={null} composePersonas={['general']} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryByTestId('write-prefill-banner')).toBeNull();
  });

  it('banner shows on Step 1 and the prefilled ✨ marker shows on the field in Step 2', async () => {
    queryVaultMock.mockReturnValue([
      makeVaultItem({
        id: 'a',
        body: 'home office for professional work daily',
        timestamp: NOW - 2 * 60 * 60 * 1000,
      }),
    ] as never);
    const llm = stubLLM(
      JSON.stringify({ use_cases: ['home_office'], last_used_bucket: 'today' }),
    );
    const { findByText, getByTestId } = render(
      <WriteScreen subjectTitle="Aeron chair" composeLLMProvider={llm} composePersonas={['general']} />,
    );
    // Step 1: banner is present.
    await findByText(/Dina prefilled/);
    // Step 2: navigate and confirm the prefilled label hint copy
    // appears on at least one field. The per-field hint flips from
    // the baseline copy ("When did you last interact with this?
    // Optional…") to a prefilled-aware copy ("Dina inferred this
    // from when you last mentioned it…") when the field is in the
    // prefilled set. Its presence pins both navigation AND the
    // per-field marker without depending on which specific fields
    // the test LLM happened to populate.
    fireEvent.press(getByTestId('write-additional-data-pill'));
    expect(await findByText(/Dina inferred this/)).toBeTruthy();
  });

  it('disabled (composeContextEnabled=false) → no vault read, no banner', async () => {
    const { queryByTestId } = render(
      <WriteScreen subjectTitle="Aeron chair" composeContextEnabled={false} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryByTestId('write-prefill-banner')).toBeNull();
    expect(queryVaultMock).not.toHaveBeenCalled();
  });
});
