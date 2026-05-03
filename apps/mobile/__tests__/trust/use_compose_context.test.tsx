/**
 * Runner tests for `useComposeContext` — the LLM-driven compose-context
 * hook that reads the keystore-resident vault, runs the user's BYOK
 * LLM, and produces structured form prefill suggestions.
 *
 * Mocks `@dina/core/src/vault/crud::queryVault` so the tests pin the
 * runner's state machine without depending on a real persona/vault.
 * Injects the LLM provider via the `llmProvider` option (no need to
 * mock the keychain or the BYOK plumbing).
 */
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { Text } from 'react-native';

jest.mock('@dina/core/src/vault/crud', () => ({
  __esModule: true,
  queryVault: jest.fn(),
}));

import * as vaultCrud from '@dina/core/src/vault/crud';
import { useComposeContext } from '../../src/trust/runners/use_compose_context';
import type { ComposeContextResult } from '../../src/trust/compose_context';
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

function stubLLM(responseContent: string): {
  llm: LLMProvider;
  chat: jest.Mock<(messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>>;
} {
  const chat = jest.fn<(messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResponse>>();
  chat.mockResolvedValue({
    content: responseContent,
    toolCalls: [],
    model: 'stub',
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: 'end',
  });
  return {
    chat,
    llm: {
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
    },
  };
}

interface ProbeProps {
  enabled: boolean;
  subjectName?: string | null;
  persona?: string | null;
  category?: string | null;
  llmProvider?: LLMProvider | null;
}

function ComposeProbe(props: ProbeProps): React.ReactElement {
  const state = useComposeContext({
    enabled: props.enabled,
    subjectName: props.subjectName ?? 'Aeron chair',
    persona: props.persona ?? 'general',
    category: props.category ?? 'office_furniture',
    nowMs: NOW,
    llmProvider: props.llmProvider,
  });
  return (
    <Text testID="probe">
      {JSON.stringify({
        loading: state.isLoading,
        result: state.result,
      })}
    </Text>
  );
}

function readProbe(node: { children: ReadonlyArray<unknown> | string }): {
  loading: boolean;
  result: ComposeContextResult | null;
} {
  const text = typeof node.children === 'string' ? node.children : (node.children[0] as string);
  return JSON.parse(text);
}

async function flushAsync(): Promise<void> {
  // Two microtask drains: one for queryVault → llm.chat() resolution,
  // another for the setState that lands the result.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useComposeContext', () => {
  it('returns loading=false + result=null when disabled (controlled-mode)', async () => {
    const { getByTestId } = render(<ComposeProbe enabled={false} />);
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.loading).toBe(false);
    expect(probe.result).toBeNull();
    expect(queryVaultMock).not.toHaveBeenCalled();
  });

  it('returns empty result when subjectName is empty', async () => {
    const { getByTestId } = render(<ComposeProbe enabled={true} subjectName="" />);
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.loading).toBe(false);
    expect(probe.result).toEqual({ values: {}, sources: {} });
    expect(queryVaultMock).not.toHaveBeenCalled();
  });

  it('returns empty result when persona is empty', async () => {
    const { getByTestId } = render(<ComposeProbe enabled={true} persona="" />);
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.result).toEqual({ values: {}, sources: {} });
    expect(queryVaultMock).not.toHaveBeenCalled();
  });

  it('returns empty result when llmProvider is null (no provider configured)', async () => {
    queryVaultMock.mockReturnValue([
      {
        id: 'a',
        type: 'note',
        source: 'local',
        source_id: '',
        contact_did: '',
        summary: '',
        body: 'I use the Aeron chair every day for professional work',
        metadata: '',
        tags: '',
        timestamp: NOW - 6 * 60 * 60 * 1000,
        created_at: 0,
        updated_at: 0,
        deleted: 0,
        sender: '',
        sender_trust: '',
        source_type: '',
        confidence: '',
        retrieval_policy: '',
        contradicts: '',
        content_l0: 'Aeron chair note',
        content_l1: '',
        enrichment_status: '',
        enrichment_version: '',
      },
    ] as never);
    const { getByTestId } = render(
      <ComposeProbe enabled={true} llmProvider={null} />,
    );
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.loading).toBe(false);
    expect(probe.result).toEqual({ values: {}, sources: {} });
  });

  it('queries the vault and returns inferred values when LLM responds', async () => {
    queryVaultMock.mockReturnValue([
      {
        id: 'a',
        type: 'note',
        source: 'local',
        source_id: '',
        contact_did: '',
        summary: '',
        body: 'I use the Aeron chair every day for professional work',
        metadata: '',
        tags: '',
        timestamp: NOW - 6 * 60 * 60 * 1000,
        created_at: 0,
        updated_at: 0,
        deleted: 0,
        sender: '',
        sender_trust: '',
        source_type: '',
        confidence: '',
        retrieval_policy: '',
        contradicts: '',
        content_l0: 'Aeron chair note',
        content_l1: '',
        enrichment_status: '',
        enrichment_version: '',
      },
    ] as never);
    const { llm, chat } = stubLLM(
      JSON.stringify({ use_cases: ['home_office'], last_used_bucket: 'today' }),
    );
    const { getByTestId } = render(<ComposeProbe enabled={true} llmProvider={llm} />);
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.loading).toBe(false);
    expect(probe.result).not.toBeNull();
    expect(probe.result?.values.last_used_bucket).toBe('today');
    expect(probe.result?.values.use_cases).toEqual(['home_office']);
    expect(probe.result?.sources.last_used_bucket).toBeDefined();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('returns empty result when queryVault returns []', async () => {
    queryVaultMock.mockReturnValue([] as never);
    const { llm, chat } = stubLLM(JSON.stringify({}));
    const { getByTestId } = render(<ComposeProbe enabled={true} llmProvider={llm} />);
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.result).toEqual({ values: {}, sources: {} });
    // No vault items → don't waste an LLM call.
    expect(chat).not.toHaveBeenCalled();
  });

  it('handles queryVault throwing (e.g. locked persona) by returning empty', async () => {
    queryVaultMock.mockImplementation(() => {
      throw new Error('persona locked');
    });
    const { llm } = stubLLM(JSON.stringify({}));
    const { getByTestId } = render(<ComposeProbe enabled={true} llmProvider={llm} />);
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.loading).toBe(false);
    expect(probe.result).toEqual({ values: {}, sources: {} });
  });

  it('handles LLM chat() throwing by returning empty', async () => {
    queryVaultMock.mockReturnValue([
      {
        id: 'a',
        type: 'note',
        source: 'local',
        source_id: '',
        contact_did: '',
        summary: '',
        body: 'x',
        metadata: '',
        tags: '',
        timestamp: NOW - 6 * 60 * 60 * 1000,
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
      },
    ] as never);
    const chat = jest.fn().mockRejectedValue(new Error('rate limited'));
    const llm: LLMProvider = {
      name: 'stub',
      supportsStreaming: false,
      supportsToolCalling: false,
      supportsEmbedding: false,
      chat: chat as never,
      stream: async function* () {
        yield { type: 'done' };
      },
      embed: async () => ({
        embedding: new Float64Array(),
        model: 'stub',
        dimensions: 0,
      }),
    };
    const { getByTestId } = render(<ComposeProbe enabled={true} llmProvider={llm} />);
    await flushAsync();
    const probe = readProbe(getByTestId('probe').props);
    expect(probe.loading).toBe(false);
    expect(probe.result).toEqual({ values: {}, sources: {} });
  });

  it('does not call queryVault again when re-rendering with same inputs', async () => {
    queryVaultMock.mockReturnValue([] as never);
    const { llm } = stubLLM(JSON.stringify({}));
    const { rerender } = render(<ComposeProbe enabled={true} llmProvider={llm} />);
    await flushAsync();
    const callsAfterFirstRender = queryVaultMock.mock.calls.length;
    rerender(<ComposeProbe enabled={true} llmProvider={llm} />);
    await flushAsync();
    expect(queryVaultMock.mock.calls.length).toBe(callsAfterFirstRender);
  });

  it('re-queries when subjectName changes', async () => {
    queryVaultMock.mockReturnValue([] as never);
    const { llm } = stubLLM(JSON.stringify({}));
    const { rerender } = render(
      <ComposeProbe enabled={true} subjectName="Aeron chair" llmProvider={llm} />,
    );
    await flushAsync();
    const callsAfterFirst = queryVaultMock.mock.calls.length;
    rerender(<ComposeProbe enabled={true} subjectName="Steelcase chair" llmProvider={llm} />);
    await flushAsync();
    expect(queryVaultMock.mock.calls.length).toBe(callsAfterFirst + 1);
    const lastCall = queryVaultMock.mock.calls[queryVaultMock.mock.calls.length - 1];
    expect(lastCall[1]).toMatchObject({ text: 'Steelcase chair' });
  });
});
