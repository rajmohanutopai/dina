/**
 * Shared post-processing for proposals produced outside the built-in Brain.
 *
 * Core calls this adapter before it accepts a connected/local/remote backend
 * result. It deliberately touches generated prose only. Structured memories,
 * reminder candidates, and routing decisions are validated by their dedicated
 * Core contracts and must not be silently rewritten by a prose filter.
 */

import { classifyTier } from '../guardian/density';
import { scanResponse, stripViolations } from '../guardian/guard_scan';
import { validateAgainstSchema } from '../service/capabilities/schema_validator';

import type { ReasoningOutputGuardInput, ReasoningOutputGuardResult } from '@dina/core';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function promptFrom(taskKind: ReasoningOutputGuardInput['taskKind'], input: unknown): string {
  const body = record(input);
  if (body === null) return '';
  if (typeof body.query === 'string') return body.query;
  if (typeof body.text === 'string') return body.text;
  if (taskKind !== 'service.respond') return '';

  const parts = [
    typeof body.capabilityId === 'string' ? body.capabilityId : '',
    typeof body.instructions === 'string' ? body.instructions : '',
  ];
  if (body.params !== undefined) {
    try {
      parts.push(JSON.stringify(body.params));
    } catch {
      // The request has already passed Core's JSON contract; keep this
      // defensive path deterministic if a non-standard caller invokes us.
    }
  }
  return parts
    .filter((part) => part !== '')
    .join('\n')
    .slice(0, 16 * 1024);
}

function reviewEvidenceWasUsed(input: ReasoningOutputGuardInput): boolean {
  const cited = new Set(input.evidenceIds);
  return (
    input.context?.items.some((item) => item.sourceType === 'review' && cited.has(item.sourceId)) ??
    false
  );
}

function toolsFor(input: ReasoningOutputGuardInput): string[] {
  return reviewEvidenceWasUsed(input) ? ['search_peerlens'] : [];
}

async function sanitizeText(
  text: string,
  input: ReasoningOutputGuardInput,
): Promise<string | null> {
  const evidenceCount =
    input.evidenceIds.length > 0 ? input.evidenceIds.length : (input.context?.items.length ?? 0);
  const scan = await scanResponse(text, {
    densityTier: classifyTier(evidenceCount),
    userPrompt: promptFrom(input.taskKind, input.input),
    toolsCalled: toolsFor(input),
  });
  const cleaned = stripViolations(text, scan).trim();
  return cleaned === '' ? null : cleaned;
}

async function sanitizeNamedFields(
  result: unknown,
  fields: readonly { name: string; required: boolean }[],
  input: ReasoningOutputGuardInput,
): Promise<ReasoningOutputGuardResult> {
  const body = record(result);
  if (body === null) return { ok: false, error: 'result is not an object' };
  const next = { ...body };
  for (const field of fields) {
    const value = next[field.name];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return { ok: false, error: `${field.name} is not text` };
    }
    const cleaned = await sanitizeText(value, input);
    if (cleaned === null) {
      if (!field.required) {
        Reflect.deleteProperty(next, field.name);
        continue;
      }
      return { ok: false, error: `${field.name} was removed by output policy` };
    }
    next[field.name] = cleaned;
  }
  return { ok: true, result: next };
}

type SanitizedJson = { ok: true; value: unknown } | { ok: false };

async function sanitizeJsonStrings(
  value: unknown,
  input: ReasoningOutputGuardInput,
): Promise<SanitizedJson> {
  if (typeof value === 'string') {
    const cleaned = await sanitizeText(value, input);
    return cleaned === null ? { ok: false } : { ok: true, value: cleaned };
  }
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (const child of value) {
      const cleaned = await sanitizeJsonStrings(child, input);
      if (!cleaned.ok) return cleaned;
      next.push(cleaned.value);
    }
    return { ok: true, value: next };
  }
  const body = record(value);
  if (body === null) return { ok: true, value };
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(body)) {
    const cleaned = await sanitizeJsonStrings(child, input);
    if (!cleaned.ok) return cleaned;
    next[key] = cleaned.value;
  }
  return { ok: true, value: next };
}

/**
 * Build the output guard used by every reasoning broker composition root.
 */
export function createReasoningOutputGuard(): (
  input: ReasoningOutputGuardInput,
) => Promise<ReasoningOutputGuardResult> {
  return async (input) => {
    switch (input.taskKind) {
      case 'answer.compose':
        return sanitizeNamedFields(
          input.result,
          [
            { name: 'answer', required: true },
            { name: 'uncertainty', required: false },
          ],
          input,
        );
      case 'review.summarize':
        return sanitizeNamedFields(
          input.result,
          [
            { name: 'summary', required: true },
            { name: 'densityDisclosure', required: false },
          ],
          input,
        );
      case 'service.respond': {
        const body = record(input.result);
        const request = record(input.input);
        if (
          body === null ||
          request === null ||
          record(body.result) === null ||
          record(request.responseSchema) === null
        ) {
          return { ok: false, error: 'service result is not an object' };
        }
        const schemaError = validateAgainstSchema(body.result, request.responseSchema);
        if (schemaError !== null) {
          return {
            ok: false,
            error: `service result violates the frozen response schema: ${schemaError}`,
          };
        }
        const cleaned = await sanitizeJsonStrings(body.result, input);
        if (!cleaned.ok) {
          return { ok: false, error: 'service result was removed by output policy' };
        }
        const cleanedSchemaError = validateAgainstSchema(cleaned.value, request.responseSchema);
        if (cleanedSchemaError !== null) {
          return {
            ok: false,
            error: `output policy broke the frozen response schema: ${cleanedSchemaError}`,
          };
        }
        return { ok: true, result: { ...body, result: cleaned.value } };
      }
      case 'memory.structure':
      case 'intent.route':
      case 'reminder.extract':
        return { ok: true, result: input.result };
    }
  };
}
