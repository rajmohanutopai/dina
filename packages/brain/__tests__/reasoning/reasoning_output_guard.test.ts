import { createReasoningOutputGuard } from '../../src/reasoning/reasoning_output_guard';

import type { ReasoningOutputGuardInput } from '@dina/core';

function guardInput(overrides: Partial<ReasoningOutputGuardInput> = {}): ReasoningOutputGuardInput {
  return {
    taskKind: 'answer.compose',
    input: { query: 'Which chair should I choose?' },
    context: {
      projectionId: 'context-projection',
      purpose: 'answer the owner',
      items: [
        {
          sourceId: 'memory-back-pain',
          sourceType: 'memory',
          text: 'Lower back pain',
        },
      ],
      scrubbed: true,
      sensitivity: 'sensitive',
      expiresAtMs: 60_000,
    },
    result: {
      answer: 'Choose adjustable lumbar support.',
      evidenceIds: ['memory-back-pain'],
    },
    evidenceIds: ['memory-back-pain'],
    ...overrides,
  };
}

describe('createReasoningOutputGuard', () => {
  const guard = createReasoningOutputGuard();

  test('removes unsafe prose while retaining a supported answer', async () => {
    const result = await guard(
      guardInput({
        result: {
          answer: "Choose adjustable lumbar support. I'm always here for you.",
          evidenceIds: ['memory-back-pain'],
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: {
        answer: 'Choose adjustable lumbar support.',
        evidenceIds: ['memory-back-pain'],
      },
    });
  });

  test('rejects a proposal when policy removes its required prose', async () => {
    await expect(
      guard(
        guardInput({
          result: {
            answer: "I'm always here for you.",
            evidenceIds: ['memory-back-pain'],
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'answer was removed by output policy',
    });
  });

  test('drops an unsafe optional field without rejecting the safe answer', async () => {
    const result = await guard(
      guardInput({
        result: {
          answer: 'Choose adjustable lumbar support.',
          uncertainty: 'Is there anything else I can help with?',
          evidenceIds: ['memory-back-pain'],
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: {
        answer: 'Choose adjustable lumbar support.',
        evidenceIds: ['memory-back-pain'],
      },
    });
  });

  test('allows trust language only when cited evidence is a review', async () => {
    const result = {
      answer: 'This chair has a reliability rating of 9.',
      evidenceIds: ['review-chair'],
    };
    const context = {
      projectionId: 'context-projection',
      purpose: 'answer the owner',
      items: [
        {
          sourceId: 'review-chair',
          sourceType: 'review' as const,
          text: 'Review-backed reliability score',
        },
        {
          sourceId: 'memory-back-pain',
          sourceType: 'memory' as const,
          text: 'Lower back pain',
        },
      ],
      scrubbed: true,
      sensitivity: 'sensitive' as const,
      expiresAtMs: 60_000,
    };

    await expect(
      guard(
        guardInput({
          context,
          result,
          evidenceIds: ['review-chair'],
        }),
      ),
    ).resolves.toEqual({ ok: true, result });

    await expect(
      guard(
        guardInput({
          context,
          result: { ...result, evidenceIds: ['memory-back-pain'] },
          evidenceIds: ['memory-back-pain'],
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'answer was removed by output policy',
    });
  });

  test('recursively guards service text while preserving JSON null values', async () => {
    const result = await guard(
      guardInput({
        taskKind: 'service.respond',
        input: {
          capabilityId: 'com.example.status',
          params: { orderId: '42' },
          serviceName: 'Example status',
          ttlSeconds: 60,
          responseSchema: {
            type: 'object',
            required: ['status', 'eta', 'rows'],
            properties: {
              status: { type: 'string' },
              eta: { type: ['string', 'null'] },
              rows: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['message'],
                  properties: { message: { type: 'string' } },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        result: {
          result: {
            status: 'Ready. Is there anything else I can help with?',
            eta: null,
            rows: [{ message: 'Collect after 4pm.' }],
          },
          evidenceIds: ['memory-back-pain'],
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: {
        result: {
          status: 'Ready.',
          eta: null,
          rows: [{ message: 'Collect after 4pm.' }],
        },
        evidenceIds: ['memory-back-pain'],
      },
    });
  });

  test('rejects a service proposal that violates its frozen result schema', async () => {
    await expect(
      guard(
        guardInput({
          taskKind: 'service.respond',
          input: {
            capabilityId: 'eta_query',
            params: {},
            serviceName: 'Bus 42',
            ttlSeconds: 60,
            responseSchema: {
              type: 'object',
              required: ['eta_minutes'],
              properties: { eta_minutes: { type: 'integer', minimum: 0 } },
              additionalProperties: false,
            },
          },
          result: {
            result: { eta_minutes: 'soon' },
          },
          evidenceIds: [],
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error:
        'service result violates the frozen response schema: params.eta_minutes: must be an integer',
    });
  });

  test('does not rewrite structured memory proposals', async () => {
    const proposal = {
      persona: 'general',
      subject: { kind: 'person', label: 'Emma' },
      facts: [{ text: "I'm always here for you.", confidence: 0.7 }],
      reminderCandidates: [],
    };

    await expect(
      guard(
        guardInput({
          taskKind: 'memory.structure',
          input: { text: "I'm always here for you." },
          result: proposal,
          evidenceIds: [],
        }),
      ),
    ).resolves.toEqual({ ok: true, result: proposal });
  });
});
