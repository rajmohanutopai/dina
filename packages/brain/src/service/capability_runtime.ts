/**
 * Tier 1 capability runtime — `runCapability` (docs/SERVICE_PROVIDER_TIERS.md).
 *
 * The prompt-provider execution plane: the provider wrote a free-text
 * `instruction` ("Use my appointment notes to answer haircut questions.
 * If someone wants to book, ask me first."), keeps facts fresh by
 * talking to their own Dina (`/remember`), and THIS runtime turns an
 * inbound `service.query` into a schema-valid JSON result:
 *
 *   instruction + params + vault_search → agentic turn → parse →
 *   validate(result schema) → [native-schema synthesis retry] → result
 *
 * Safety properties:
 *   - READ-ONLY: the only tool is `vault_search`; Tier 1 execution can
 *     never mutate the vault or call out anywhere.
 *   - Persona-bounded: `vault_search` cannot escape
 *     `getAccessiblePersonas()` — locked personas return nothing.
 *   - Schema-bounded output: the runtime validates against the
 *     capability's result schema and retries ONCE through a native
 *     structured-output synthesis call; the Response Bridge's frozen
 *     `schemaSnapshot` validation (GAP-SH-03) remains the final gate.
 *   - As-of discipline: the prompt carries the instruction's age so the
 *     model prefers `unknown` + "please confirm with the provider" over
 *     stale-confident answers.
 *
 * This module is composition-free: callers supply the LLM. The glue
 * that resolves a workflow task → (instruction, schema) lives in
 * `tier1_runner.ts`.
 */

import { listPersonas } from '@dina/core';

import { runAgenticTurn, type AgenticLoopResult } from '../reasoning/agentic_loop';
import { ToolRegistry } from '../reasoning/tool_registry';
import { createVaultSearchTool } from '../reasoning/vault_tool';

import { validateAgainstSchema } from './capabilities/schema_validator';

import type { LLMProvider } from '../llm/adapters/provider';

export interface RunCapabilityArgs {
  /** Canonical capability name (e.g. `appointment_availability`). */
  capability: string;
  /** Query params — already validated against the published params schema. */
  params: unknown;
  /** The provider's instruction (`howToAnswer`). Required — no instruction, no Tier 1. */
  instruction: string;
  /** Unix ms when the instruction was last edited (as-of discipline). */
  instructionUpdatedAt?: number;
  /** JSON Schema the result must satisfy. Omitted → structural JSON only. */
  resultSchema?: Record<string, unknown>;
  /** Listing name, for the prompt ("you are answering for <name>"). */
  serviceName: string;
  /**
   * True when a `review`-policy query was personally approved by the
   * provider (`executeAndRespond` path). The instruction may say "ask
   * me first" — this flag tells the model the asking already happened.
   */
  operatorApproved?: boolean;
  /**
   * Wall-clock budget for this execution (ms). Derived from the query's
   * `ttl_seconds` by the tier1 runner — there is no point computing an
   * answer the requester has already given up on, and an unbounded LLM
   * call would wedge the single-claim local runner (busy forever).
   * On expiry the run throws and the task fails cleanly.
   */
  deadlineMs?: number;
  /**
   * Per-run vault pin (the listing's `vaultPersona`). INTERSECTED with
   * the runtime's base scope — a pin can only NARROW what this
   * execution may read, never widen it: pinning a sensitive/locked
   * persona yields an EMPTY scope, not access.
   */
  allowedPersonas?: readonly string[];
}

export interface CapabilityRuntimeOptions {
  /**
   * LLM resolver — called per execution so a provider configured (or
   * rotated) after boot is picked up. Return `null` when no AI is
   * configured; the run fails with a clear, requester-visible error.
   */
  getLLM: () => LLMProvider | null;
  /** Wall clock (ms). Injectable for tests. */
  nowMsFn?: () => number;
  /** Structured logger — metadata only, never vault content. */
  logger?: (entry: Record<string, unknown>) => void;
  /** Cap on agentic iterations. Default 6. */
  maxIterations?: number;
  /**
   * Vault scope for this runtime's `vault_search` — SECURITY BOUNDARY.
   * Tier 1 executions answer EXTERNAL strangers whose params reach the
   * model verbatim, and the system prompt is NOT a security boundary
   * against prompt injection. The DEFAULT scope is fail-closed:
   * personas whose registry tier is `sensitive` or `locked` are
   * excluded (mobile auto-opens them for the OWNER — "accessible" ≠
   * "shareable with a stranger"; dina_details.md §13.4). Override only
   * to NARROW further (e.g. pin a listing to one persona).
   */
  allowedPersonas?: () => readonly string[];
}

/**
 * Default Tier 1 vault scope: every registered persona that is NOT
 * sensitive/locked tier. Re-evaluated per call so persona changes
 * apply immediately. Exported for tests.
 */
export function defaultTier1PersonaScope(): readonly string[] {
  return listPersonas()
    .filter((p) => p.tier !== 'sensitive' && p.tier !== 'locked')
    .map((p) => p.name);
}

export interface CapabilityRuntime {
  run(args: RunCapabilityArgs): Promise<unknown>;
}

/** Render "N minutes/hours/days ago" for the as-of line. */
export function renderInstructionAge(updatedAtMs: number | undefined, nowMs: number): string {
  if (updatedAtMs === undefined || updatedAtMs <= 0 || updatedAtMs > nowMs) {
    return 'at an unknown time';
  }
  const deltaMin = Math.floor((nowMs - updatedAtMs) / 60_000);
  if (deltaMin < 1) return 'moments ago';
  if (deltaMin < 60) return `${deltaMin} minute${deltaMin === 1 ? '' : 's'} ago`;
  const deltaH = Math.floor(deltaMin / 60);
  if (deltaH < 48) return `${deltaH} hour${deltaH === 1 ? '' : 's'} ago`;
  const deltaD = Math.floor(deltaH / 24);
  return `${deltaD} days ago`;
}

/**
 * Tolerant JSON extraction — same discipline as the ask-retrieval
 * planner: strip code fences, take the outermost `{...}` span.
 */
export function extractJSONObject(raw: string): unknown | null {
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildSystemPrompt(args: RunCapabilityArgs, nowMs: number): string {
  const age = renderInstructionAge(args.instructionUpdatedAt, nowMs);
  const schemaBlock =
    args.resultSchema !== undefined
      ? `The result MUST be a single JSON object that validates against this JSON Schema:\n${JSON.stringify(args.resultSchema)}`
      : 'The result MUST be a single JSON object.';
  const approvedBlock = args.operatorApproved
    ? `\nThe provider has PERSONALLY REVIEWED AND APPROVED this specific request. If the instruction says to check with or ask the provider first, that step is already done — produce the affirmative result (e.g. a confirmed booking), not another request for confirmation.`
    : '';
  return `You answer service queries on behalf of "${args.serviceName}" — you are the provider's own Dina, answering an external customer's Dina.

THE PROVIDER'S INSTRUCTION (their own words, last updated ${age}):
"""
${args.instruction}
"""
${approvedBlock}

How to work:
- The provider keeps facts fresh by telling their Dina things — use the vault_search tool to look up current notes (availability, prices, hours, today's changes) before answering. Search with a few different phrasings if the first finds nothing.
- The instruction's age matters: if the answer depends on facts that may have changed since it was written and the vault has nothing fresher, do NOT guess — answer with the schema's honest fallback (e.g. status "unknown") and a message suggesting the customer confirm with the provider.

Hard rules:
- The result goes to an EXTERNAL requester. Include ONLY information this service is meant to share per the instruction. Never include unrelated personal details, names of other customers, or anything from the vault the instruction doesn't authorize.
- Never invent facts the instruction or vault doesn't support.
- Your FINAL message must be ONLY the JSON result object — no prose, no code fences.

${schemaBlock}`;
}

/** `null` when the candidate satisfies the capability's result contract. */
function validateCandidate(
  resultSchema: Record<string, unknown> | undefined,
  candidate: unknown,
): string | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'final answer is not a JSON object';
  }
  if (resultSchema === undefined) return null;
  return validateAgainstSchema(candidate, resultSchema, 'result');
}

/**
 * The schema's HONEST fallback when a run can't produce a real answer — an
 * explicit `status:"unknown"` plus a "check with the provider directly"
 * message. DETERMINISTIC: built in code, never by the model, so it cannot
 * fabricate slots/prices/times the vault never had (the whole point — see
 * the `max_iterations` branch in `run`). Returns `null` when the result
 * schema can't represent it; the caller then fails loudly rather than guess.
 *
 * The canonical capabilities follow the status-required + `unknown`-enum
 * convention (eta_query / price_check / appointment_availability), so this
 * validates for them; a bespoke schema lacking an `unknown` status → null.
 */
export function buildHonestUnknownResult(
  resultSchema: Record<string, unknown> | undefined,
  serviceName: string,
): unknown | null {
  const who = serviceName.trim() !== '' ? serviceName.trim() : 'the provider';
  const message = `I couldn't confirm this right now — please check with ${who} directly.`;
  const withMessage = { status: 'unknown', message };
  if (validateCandidate(resultSchema, withMessage) === null) return withMessage;
  // Schema may not allow a free-text `message` field — fall back to bare status.
  const bare = { status: 'unknown' };
  if (validateCandidate(resultSchema, bare) === null) return bare;
  return null;
}

/**
 * Force a final schema-valid result when the agentic loop GATHERED context but
 * never converged — the model kept tool-calling instead of answering (weaker
 * models, e.g. gemini flash, do this; withholding tools doesn't help because
 * the model re-emits a function call from the tool-call history). Re-asks via
 * NATIVE structured output (`responseSchema`), which CANNOT emit a function
 * call, feeding the gathered tool results as PLAIN TEXT in a fresh message (no
 * function-call history that providers reject when tools are absent).
 *
 * Anti-hallucination: the model may use ONLY the gathered facts; if they don't
 * answer the question it must return the honest "unknown" fallback. Returns the
 * parsed candidate (caller validates) or `null` on any failure.
 */
async function forceFinalAnswer(
  llm: LLMProvider,
  systemPrompt: string,
  toolCalls: AgenticLoopResult['toolCalls'],
  args: RunCapabilityArgs,
  signal: AbortSignal,
): Promise<unknown | null> {
  const gathered = toolCalls
    .map((t) => {
      if (!t.outcome.success) return '';
      try {
        return JSON.stringify((t.outcome as { result: unknown }).result);
      } catch {
        return '';
      }
    })
    .filter((s) => s !== '')
    .join('\n');
  const ask = `You searched the provider's notes for this "${args.capability}" query but did not produce a final answer. Here is everything you found:
${gathered === '' ? '(nothing relevant was found)' : gathered}

Query params (JSON): ${JSON.stringify(args.params ?? {})}

Produce the FINAL result now as a single JSON object that validates against the schema. Use ONLY the facts above — if they do not answer the question, return the honest fallback: status "unknown" with a short message telling the customer to confirm with the provider. Never invent specifics (slots, prices, times). JSON only.`;
  try {
    const synth = await llm.chat([{ role: 'user', content: ask }], {
      systemPrompt,
      temperature: 0,
      maxTokens: 1024,
      signal,
      ...(args.resultSchema !== undefined ? { responseSchema: args.resultSchema } : {}),
    });
    return extractJSONObject(synth.content);
  } catch {
    return null;
  }
}

/** Build the Tier 1 capability runtime. */
export function buildCapabilityRuntime(options: CapabilityRuntimeOptions): CapabilityRuntime {
  const nowMsFn = options.nowMsFn ?? Date.now;
  const log =
    options.logger ??
    (() => {
      /* silent */
    });
  const maxIterations = options.maxIterations ?? 6;

  return {
    async run(args: RunCapabilityArgs): Promise<unknown> {
      if (args.instruction.trim() === '') {
        throw new Error(`runCapability(${args.capability}): instruction is empty`);
      }
      const llm = options.getLLM();
      if (llm === null) {
        throw new Error(
          `runCapability(${args.capability}): no AI provider configured on this node`,
        );
      }
      const nowMs = nowMsFn();
      const systemPrompt = buildSystemPrompt(args, nowMs);
      const userMessage = `Incoming service query.\nCapability: ${args.capability}\nParams (JSON, verbatim):\n${JSON.stringify(args.params ?? {})}\n\nAnswer per your system instructions. Final message = the JSON result object only.`;

      // SECURITY: the vault tool is hard-scoped (default: non-sensitive,
      // non-locked personas). The stranger's params reach the model
      // verbatim, so the prompt's "Hard rules" are guidance, not a
      // boundary — the scope is. A per-run pin (the listing's
      // `vaultPersona`) INTERSECTS the base scope: narrowing only.
      const baseScope = options.allowedPersonas ?? defaultTier1PersonaScope;
      const runScope = (): readonly string[] => {
        const base = baseScope();
        if (args.allowedPersonas === undefined) return base;
        const pin = new Set(args.allowedPersonas);
        return base.filter((p) => pin.has(p));
      };
      const tools = new ToolRegistry();
      tools.register(createVaultSearchTool({ allowedPersonas: runScope }));

      // Deadline: there is no point computing an answer the requester's
      // TTL has already abandoned, and a hung provider fetch must not
      // wedge the single-claim runner. runAgenticTurn + chat both honor
      // AbortSignal.
      const controller = new AbortController();
      const deadlineTimer =
        args.deadlineMs !== undefined && args.deadlineMs > 0
          ? setTimeout(() => controller.abort(), args.deadlineMs)
          : null;

      try {
        const turn = await runAgenticTurn({
          provider: llm,
          tools,
          systemPrompt,
          userMessage,
          options: { maxIterations, temperature: 0.2, signal: controller.signal },
        });
        log({
          event: 'capability_runtime.turn',
          capability: args.capability,
          finish: turn.finishReason,
          tool_calls: turn.toolCalls.length,
        });
        if (turn.finishReason === 'provider_error') {
          throw new Error(
            `runCapability(${args.capability}): provider error — ${turn.providerErrorMessage ?? 'unknown'}`,
          );
        }

        const candidate = extractJSONObject(turn.answer);
        const candidateErr = validateCandidate(args.resultSchema, candidate);
        if (candidateErr === null) return candidate;
        log({
          event: 'capability_runtime.invalid_first_pass',
          capability: args.capability,
          finish: turn.finishReason,
          error: candidateErr,
        });

        // A turn that did NOT complete (the agentic loop hit its iteration /
        // tool-call cap — typically because vault_search kept coming back
        // empty so the model re-searched to the cap) has no substance to
        // re-emit. Do NOT ask the model to "produce its best answer" here —
        // that's exactly how a facts-free run fabricates slots/prices the
        // vault never had. Instead degrade DETERMINISTICALLY to the schema's
        // honest "unknown — confirm with the provider" fallback: graceful for
        // the requester (it gets a usable answer instead of "couldn't reach"),
        // zero hallucination (no model call). Fail loudly only when the
        // schema can't represent that honest answer.
        if (turn.finishReason !== 'completed') {
          if (turn.finishReason === 'max_iterations' || turn.finishReason === 'max_tool_calls') {
            // The loop GATHERED context (vault_search results) but never
            // emitted a final answer — the model kept tool-calling to the
            // cap (weaker models do this). Before degrading, give it ONE
            // shot to synthesize from what it already found, via native
            // structured output (can't emit a function call) over the
            // gathered tool results as plain text. Anti-hallucination: the
            // prompt restricts it to the gathered facts and instructs the
            // honest "unknown" fallback when they don't answer the query.
            const forced = await forceFinalAnswer(
              llm,
              systemPrompt,
              turn.toolCalls,
              args,
              controller.signal,
            );
            const forcedErr = validateCandidate(args.resultSchema, forced);
            if (forced !== null && forcedErr === null) {
              log({
                event: 'capability_runtime.forced_answer',
                capability: args.capability,
                finish: turn.finishReason,
                tool_calls: turn.toolCalls.length,
              });
              return forced;
            }
            log({
              event: 'capability_runtime.forced_answer_invalid',
              capability: args.capability,
              finish: turn.finishReason,
              error: forcedErr ?? 'no candidate',
            });
            // Forced synthesis failed too — degrade DETERMINISTICALLY to the
            // schema's honest "unknown — confirm with the provider" fallback:
            // graceful for the requester, zero hallucination (no further model
            // call). Fail loudly only when the schema can't represent it.
            const honest = buildHonestUnknownResult(args.resultSchema, args.serviceName);
            if (honest !== null) {
              log({
                event: 'capability_runtime.degraded_to_unknown',
                capability: args.capability,
                finish: turn.finishReason,
              });
              return honest;
            }
          }
          throw new Error(
            `runCapability(${args.capability}): agentic turn ended without an answer (${turn.finishReason})`,
          );
        }

        // One synthesis retry through NATIVE structured output (Gemini /
        // OpenAI responseSchema). No tools on this call — providers
        // reject tool+schema combos — so the substance must already be
        // in the first-pass answer; we hand it back with the validation
        // error and ask for a conforming re-emit.
        const correction = `Your previous answer for this ${args.capability} query was not valid against the result schema.\nPrevious answer:\n${turn.answer}\nValidation error: ${candidateErr}\n\nRe-emit the SAME substance as a single JSON object that validates against the schema. JSON only.`;
        const synth = await llm.chat([{ role: 'user', content: correction }], {
          systemPrompt,
          temperature: 0,
          maxTokens: 1024,
          signal: controller.signal,
          ...(args.resultSchema !== undefined ? { responseSchema: args.resultSchema } : {}),
        });
        const retried = extractJSONObject(synth.content);
        const retriedErr = validateCandidate(args.resultSchema, retried);
        if (retriedErr === null) return retried;
        throw new Error(
          `runCapability(${args.capability}): result failed schema validation after retry — ${retriedErr}`,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(
            `runCapability(${args.capability}): execution exceeded its ${args.deadlineMs}ms deadline`,
          );
        }
        throw err;
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      }
    },
  };
}
