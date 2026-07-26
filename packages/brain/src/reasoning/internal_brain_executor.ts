/**
 * Adapter from Core reasoning claims to Dina's built-in Brain pipeline.
 *
 * The executor is intentionally reasoning-only. It consumes the projection in
 * the claim and returns a proposal; it has no Core storage handle or effect
 * surface. Core still validates the result and performs any commit.
 */

import {
  classifyProviderErrorKind,
  providerErrorMessageForKind,
} from '../llm/provider_error_classify';
import { reasonWithPreparedContext, type ReasoningLLM } from '../pipeline/chat_reasoning';

import type { LLMProvider } from '../llm/adapters/provider';
import type {
  ReasoningBackendExecutor,
  ReasoningClaim,
  ReasoningExecutionProposal,
} from '@dina/core';

export interface InternalBrainExecutorOptions {
  provider: string;
  persona?: string;
  /** Explicit worker-local LLM; avoids cross-node process-global registration. */
  llm?: ReasoningLLM;
}

export interface InternalBrainErrorClassification {
  message: string;
  retryable: boolean;
}

function inputRecord(claim: ReasoningClaim): Record<string, unknown> {
  if (claim.input === null || typeof claim.input !== 'object' || Array.isArray(claim.input)) {
    throw new Error('invalid internal Brain input');
  }
  return claim.input as Record<string, unknown>;
}

function tokenEstimate(texts: readonly string[]): number {
  return Math.ceil(texts.reduce((total, text) => total + text.length, 0) / 4);
}

/**
 * Create the built-in backend executor.
 *
 * Only `answer.compose` is enabled today. Other task kinds stay unavailable
 * rather than being approximated with an incompatible prompt.
 */
export function createInternalBrainExecutor(
  options: InternalBrainExecutorOptions,
): ReasoningBackendExecutor {
  return async (claim, execution): Promise<ReasoningExecutionProposal> => {
    if (claim.taskKind !== 'answer.compose') {
      throw new Error(`internal Brain does not implement ${claim.taskKind}`);
    }
    const input = inputRecord(claim);
    if (typeof input.query !== 'string' || input.query.trim() === '') {
      throw new Error('invalid answer.compose query');
    }
    const projected = claim.context?.items ?? [];
    const result = await reasonWithPreparedContext(
      {
        query: input.query,
        persona: options.persona ?? 'general',
        provider: options.provider,
      },
      {
        items: projected.map((item) => ({
          id: item.sourceId,
          content_l0: item.text,
          score: item.confidence ?? 1,
          persona: options.persona ?? 'projected',
        })),
        tokenEstimate: tokenEstimate(projected.map((item) => item.text)),
        personas: projected.length === 0 ? [] : [options.persona ?? 'projected'],
      },
      {
        toolsCalled: projected.some((item) => item.sourceType === 'review')
          ? ['search_peerlens']
          : [],
        ...(options.llm === undefined ? {} : { llm: options.llm }),
        ...(execution?.signal === undefined ? {} : { signal: execution.signal }),
      },
    );
    const evidenceIds = result.sources.filter((sourceId) =>
      claim.allowedEvidenceIds.includes(sourceId),
    );
    return {
      result: {
        answer: result.answer,
        ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
      },
      ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
    };
  };
}

/** Adapt the shared provider interface to the bounded reasoning executor. */
export function createProviderReasoningLLM(provider: LLMProvider): ReasoningLLM {
  return async (query, context, options) => {
    const response = await provider.chat([{ role: 'user', content: query }], {
      systemPrompt: context,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.finishReason === 'error' || response.content.trim() === '') {
      throw new Error(`reasoning provider ${provider.name} returned no answer`);
    }
    return response.content;
  };
}

/**
 * Reduce provider/SDK failures to a bounded, prompt-safe durable error.
 * Unknown failures stay terminal because retrying an unclassified model error
 * can repeat costs or invalid requests indefinitely.
 */
export function classifyInternalBrainError(error: unknown): InternalBrainErrorClassification {
  const raw = error instanceof Error ? error.message : String(error);
  const kind = classifyProviderErrorKind(raw);
  if (kind === null) {
    return {
      message: 'The configured Dina Brain could not complete this reasoning request.',
      retryable: false,
    };
  }
  return {
    message: providerErrorMessageForKind(kind),
    retryable: kind === 'rate_limited' || kind === 'timeout' || kind === 'network',
  };
}
