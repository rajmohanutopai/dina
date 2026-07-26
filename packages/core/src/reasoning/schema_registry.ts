/**
 * Server-owned schemas for connected-Brain work.
 *
 * Wire callers choose a task kind, not an arbitrary schema. Core maps that
 * kind to these versioned contracts and validates both input and output.
 */

import { validateAgainstSchema, type SchemaValidationResult } from '../plugins/schema_validate';

import type { ReasoningTaskKind } from './domain';

export interface ReasoningSchemaContract {
  taskKind: ReasoningTaskKind;
  requestSchemaId: string;
  requestSchema: Readonly<Record<string, unknown>>;
  resultSchemaId: string;
  resultSchema: Readonly<Record<string, unknown>>;
  maxInputBytes: number;
  maxResultBytes: number;
  maxDepth: number;
  maxProperties: number;
}

export interface JsonResourceCheck {
  ok: boolean;
  bytes: number;
  depth: number;
  properties: number;
  error?: string;
}

const TEXT_8K = { type: 'string', minLength: 1, maxLength: 8192 } as const;
const TEXT_32K = { type: 'string', minLength: 1, maxLength: 32768 } as const;
const EVIDENCE_IDS = {
  type: 'array',
  maxItems: 128,
  items: { type: 'string', minLength: 1, maxLength: 256 },
} as const;

const CONTRACTS: Readonly<Record<ReasoningTaskKind, ReasoningSchemaContract>> = {
  'answer.compose': {
    taskKind: 'answer.compose',
    requestSchemaId: 'dina.reasoning.answer.compose.input.v1',
    requestSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: TEXT_8K,
        responseStyle: { type: 'string', maxLength: 128 },
      },
      additionalProperties: false,
    },
    resultSchemaId: 'dina.reasoning.answer.compose.result.v1',
    resultSchema: {
      type: 'object',
      required: ['answer'],
      properties: {
        answer: TEXT_32K,
        evidenceIds: EVIDENCE_IDS,
        uncertainty: { type: 'string', maxLength: 2048 },
      },
      additionalProperties: false,
    },
    maxInputBytes: 16 * 1024,
    maxResultBytes: 64 * 1024,
    maxDepth: 12,
    maxProperties: 512,
  },
  'memory.structure': {
    taskKind: 'memory.structure',
    requestSchemaId: 'dina.reasoning.memory.structure.input.v1',
    requestSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: TEXT_8K,
        preferredPersona: { type: 'string', maxLength: 128 },
      },
      additionalProperties: false,
    },
    resultSchemaId: 'dina.reasoning.memory.structure.result.v1',
    resultSchema: {
      type: 'object',
      required: ['persona', 'subject', 'facts', 'reminderCandidates'],
      properties: {
        persona: { type: 'string', minLength: 1, maxLength: 128 },
        subject: {
          type: 'object',
          required: ['kind', 'label'],
          properties: {
            kind: { type: 'string', minLength: 1, maxLength: 128 },
            label: { type: 'string', minLength: 1, maxLength: 512 },
          },
          additionalProperties: false,
        },
        facts: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            required: ['text', 'confidence'],
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 4096 },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            additionalProperties: false,
          },
        },
        reminderCandidates: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            required: ['text', 'dueAtMs'],
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 2048 },
              dueAtMs: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    maxInputBytes: 16 * 1024,
    maxResultBytes: 64 * 1024,
    maxDepth: 12,
    maxProperties: 1024,
  },
  'intent.route': {
    taskKind: 'intent.route',
    requestSchemaId: 'dina.reasoning.intent.route.input.v1',
    requestSchema: {
      type: 'object',
      required: ['text', 'availableLanes'],
      properties: {
        text: TEXT_8K,
        availableLanes: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      additionalProperties: false,
    },
    resultSchemaId: 'dina.reasoning.intent.route.result.v1',
    resultSchema: {
      type: 'object',
      required: ['lane', 'confidence'],
      properties: {
        lane: { type: 'string', minLength: 1, maxLength: 128 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string', maxLength: 1024 },
      },
      additionalProperties: false,
    },
    maxInputBytes: 16 * 1024,
    maxResultBytes: 8 * 1024,
    maxDepth: 8,
    maxProperties: 256,
  },
  'service.respond': {
    taskKind: 'service.respond',
    requestSchemaId: 'dina.reasoning.service.respond.input.v1',
    requestSchema: {
      type: 'object',
      required: ['capabilityId', 'params', 'serviceName', 'ttlSeconds', 'responseSchema'],
      properties: {
        capabilityId: { type: 'string', minLength: 1, maxLength: 256 },
        params: { type: 'object' },
        instructions: { type: 'string', maxLength: 16384 },
        serviceName: { type: 'string', maxLength: 512 },
        serviceUri: { type: 'string', maxLength: 2048 },
        ttlSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
        responseSchema: { type: 'object' },
        responseSchemaHash: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
        operatorApproved: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    resultSchemaId: 'dina.reasoning.service.respond.result.v1',
    resultSchema: {
      type: 'object',
      required: ['result'],
      properties: {
        result: { type: 'object' },
        evidenceIds: EVIDENCE_IDS,
      },
      additionalProperties: false,
    },
    maxInputBytes: 64 * 1024,
    maxResultBytes: 64 * 1024,
    maxDepth: 16,
    maxProperties: 2048,
  },
  'review.summarize': {
    taskKind: 'review.summarize',
    requestSchemaId: 'dina.reasoning.review.summarize.input.v1',
    requestSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: TEXT_8K,
        subjectLabel: { type: 'string', maxLength: 512 },
      },
      additionalProperties: false,
    },
    resultSchemaId: 'dina.reasoning.review.summarize.result.v1',
    resultSchema: {
      type: 'object',
      required: ['summary', 'evidenceIds'],
      properties: {
        summary: TEXT_32K,
        evidenceIds: EVIDENCE_IDS,
        densityDisclosure: { type: 'string', maxLength: 2048 },
      },
      additionalProperties: false,
    },
    maxInputBytes: 16 * 1024,
    maxResultBytes: 64 * 1024,
    maxDepth: 12,
    maxProperties: 1024,
  },
  'reminder.extract': {
    taskKind: 'reminder.extract',
    requestSchemaId: 'dina.reasoning.reminder.extract.input.v1',
    requestSchema: {
      type: 'object',
      required: ['text', 'referenceTimeMs'],
      properties: {
        text: TEXT_8K,
        referenceTimeMs: { type: 'integer', minimum: 0 },
        timezone: { type: 'string', minLength: 1, maxLength: 128 },
        preferredPersona: { type: 'string', minLength: 1, maxLength: 128 },
      },
      additionalProperties: false,
    },
    resultSchemaId: 'dina.reasoning.reminder.extract.result.v1',
    resultSchema: {
      type: 'object',
      required: ['reminders'],
      properties: {
        reminders: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            required: ['text', 'dueAtMs'],
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 2048 },
              dueAtMs: { type: 'integer', minimum: 0 },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    maxInputBytes: 16 * 1024,
    maxResultBytes: 32 * 1024,
    maxDepth: 12,
    maxProperties: 512,
  },
};

export function getReasoningSchemaContract(taskKind: ReasoningTaskKind): ReasoningSchemaContract {
  return CONTRACTS[taskKind];
}

export function getReasoningResultSchema(schemaId: string): unknown | null {
  for (const contract of Object.values(CONTRACTS)) {
    if (contract.resultSchemaId === schemaId) return contract.resultSchema;
  }
  return null;
}

export function inspectJsonResources(
  value: unknown,
  limits: Pick<ReasoningSchemaContract, 'maxDepth' | 'maxProperties'> & {
    maxBytes: number;
  },
): JsonResourceCheck {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { ok: false, bytes: 0, depth: 0, properties: 0, error: 'not JSON serializable' };
  }
  if (encoded === undefined) {
    return { ok: false, bytes: 0, depth: 0, properties: 0, error: 'not a JSON value' };
  }
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes > limits.maxBytes) {
    return { ok: false, bytes, depth: 0, properties: 0, error: 'JSON byte limit exceeded' };
  }

  const seen = new Set<object>();
  let maxDepth = 0;
  let properties = 0;
  const visit = (item: unknown, depth: number): string | null => {
    maxDepth = Math.max(maxDepth, depth);
    if (maxDepth > limits.maxDepth) return 'JSON depth limit exceeded';
    if (item === null || typeof item !== 'object') {
      if (
        item === undefined ||
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        (typeof item === 'number' && !Number.isFinite(item))
      ) {
        return 'unsupported JSON value';
      }
      return null;
    }
    if (seen.has(item)) return 'cyclic JSON value';
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const error = visit(child, depth + 1);
        if (error !== null) return error;
      }
    } else {
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) return 'non-plain JSON object';
      for (const key of Object.keys(item)) {
        properties += 1;
        if (properties > limits.maxProperties) return 'JSON property limit exceeded';
        const error = visit((item as Record<string, unknown>)[key], depth + 1);
        if (error !== null) return error;
      }
    }
    seen.delete(item);
    return null;
  };
  const error = visit(value, 1);
  return { ok: error === null, bytes, depth: maxDepth, properties, ...(error ? { error } : {}) };
}

export function validateReasoningInput(
  contract: ReasoningSchemaContract,
  input: unknown,
): SchemaValidationResult {
  const resources = inspectJsonResources(input, {
    maxBytes: contract.maxInputBytes,
    maxDepth: contract.maxDepth,
    maxProperties: contract.maxProperties,
  });
  if (!resources.ok) return { ok: false, error: resources.error };
  return validateAgainstSchema(input, contract.requestSchema);
}

export function validateReasoningResult(
  contract: ReasoningSchemaContract,
  result: unknown,
): SchemaValidationResult {
  const resources = inspectJsonResources(result, {
    maxBytes: contract.maxResultBytes,
    maxDepth: contract.maxDepth,
    maxProperties: contract.maxProperties,
  });
  if (!resources.ok) return { ok: false, error: resources.error };
  return validateAgainstSchema(result, contract.resultSchema);
}
