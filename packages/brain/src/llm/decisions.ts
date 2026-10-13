/**
 * Decisions — fixed-choice questions answered with probabilities.
 *
 * Small checks (is this sentence an offer of company? which of these
 * categories?) do not need a model that writes text. A decision backend
 * takes a `state` and typed questions and returns, per question, a
 * probability (yes/no) or a probability per option. It cannot write text
 * back into a reply.
 *
 * Backends, in order of preference (see docs/REAL_LIFE_FIXES_2.md §18):
 *   1. Jev (TypeSafe) through OpenRouter's decisions endpoint — the default
 *      when the node has an OpenRouter key. Every call asks OpenRouter for
 *      zero data retention and no data collection.
 *   2. An on-device decision model (Laya CoreML on iPhone) — later.
 *   3. None: the caller uses its own model-based check instead.
 *
 * Callers reach a backend only through `LLMRouter.decide`, the same door
 * as every model call: the consent gate runs and the state is PII-scrubbed
 * before it leaves the Home Node.
 */

/** A yes/no question: `noul` in the answer is the probability of yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

/** One of several options, each described by its criterion. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion;

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };

export interface DecisionRequest {
  questions: Record<string, DecisionQuestion>;
  /** The context the questions are about. Scrubbed before it leaves. */
  state: Record<string, string>;
}

export type DecisionAnswers = Record<string, DecisionAnswer>;

/** A backend answers every question or throws; it never half-answers. */
export interface DecisionBackend {
  readonly name: string;
  decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionAnswers>;
}

export const JEV_MODEL = 'typesafe/jev-1.13';
const OPENROUTER_ORIGIN = 'https://openrouter.ai';

/**
 * Jev through OpenRouter (`POST /api/alpha/decisions`). The endpoint is
 * alpha: any error, or an answer missing for a question, throws so the
 * caller falls back to its own check.
 */
export function createOpenRouterJevBackend(options: {
  apiKey: string;
  /** An OpenRouter base URL (`…/api/v1`); only its origin is used. */
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): DecisionBackend {
  const origin = originOf(options.baseUrl) ?? OPENROUTER_ORIGIN;
  const fetchFn = options.fetchFn ?? fetch;
  const model = options.model ?? JEV_MODEL;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    name: 'jev',
    async decide(request, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetchFn(`${origin}/api/alpha/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          questions: request.questions,
          state: request.state,
          provider: { zdr: true, data_collection: 'deny' },
        }),
        signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`jev: HTTP ${res.status}`);
      const body = (await res.json()) as { answers?: Record<string, unknown> };
      return parseAnswers(request, body.answers);
    },
  };
}

/** Check every question got an answer of its own type; throw otherwise. */
export function parseAnswers(request: DecisionRequest, raw: unknown): DecisionAnswers {
  if (raw === null || typeof raw !== 'object') throw new Error('jev: no answers');
  const out: DecisionAnswers = {};
  for (const [key, question] of Object.entries(request.questions)) {
    const a = (raw as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (a === undefined || a === null) throw new Error('jev: an answer is missing');
    if (question.type === 'noul') {
      if (typeof a.noul !== 'number' || !Number.isFinite(a.noul)) throw new Error('jev: bad noul answer');
      out[key] = { type: 'noul', noul: a.noul };
    } else {
      if (typeof a.choice !== 'string' || !(a.choice in question.criteria)) throw new Error('jev: bad choice answer');
      const probabilities = (a.probabilities ?? {}) as Record<string, number>;
      out[key] = {
        type: 'choice',
        choice: a.choice,
        confidence: typeof a.confidence === 'number' ? a.confidence : 0,
        probabilities,
      };
    }
  }
  return out;
}

function originOf(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined || baseUrl === '') return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}
