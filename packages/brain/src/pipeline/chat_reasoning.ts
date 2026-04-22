/**
 * Chat reasoning pipeline — vault-grounded question answering.
 *
 * Full pipeline:
 *   0. preScreenMessage — Anti-Her check (Law 4: never simulate companionship)
 *   1. assembleContext — search vault across accessible personas
 *   2. checkCloudGate — PII scrub if sensitive persona + cloud LLM
 *   3. LLM reasoning — answer the question using scrubbed context
 *   4. scanResponse + stripViolations — guard scan the answer
 *   5. rehydrateResponse — restore PII tokens in the final answer
 *   6. analyzeDensity + applyDisclosure — trust density caveat
 *
 * This is the integration point of nearly every Brain module.
 *
 * Source: ARCHITECTURE.md Task 3.25
 */

import { assembleContext, type AssembledContext } from '../vault_context/assembly';
import { checkCloudGate, rehydrateResponse } from '../llm/cloud_gate';
import { scanResponse, stripViolations } from '../guardian/guard_scan';
import { preScreenMessage } from '../guardian/anti_her_classify';
import { generateHumanRedirect } from '../guardian/anti_her';
import { analyzeDensity, applyDisclosure, type DensityTier } from '../guardian/density';
import { TraceBuilder, type ReasoningTrace } from './reasoning_trace';

export interface ReasoningRequest {
  query: string;
  persona: string;
  provider: string; // 'claude' | 'openai' | 'local' | 'none'
  maxTokens?: number;
  /** Contact names to suggest when Anti-Her redirect triggers. */
  contactSuggestions?: string[];
  /**
   * Optional BrainCoreClient for request-ID threading.
   * When provided, the trace's requestId is bound to the client's
   * X-Request-ID header before any downstream HTTP calls to Core.
   */
  coreClient?: { setRequestId(id: string | null): void };
}

export interface ReasoningResult {
  answer: string;
  sources: string[];
  persona: string;
  scrubbed: boolean;
  guardViolations: number;
  stripped: boolean;
  /** Trust density tier of the vault context backing this answer. */
  densityTier: DensityTier;
  /** LLM provider used for reasoning (null if no LLM). */
  model: string | null;
  /** Number of vault context items used in the answer. */
  vaultContextUsed: number;
  /** Set when Anti-Her pre-screening triggered a redirect. */
  antiHerRedirect?: boolean;
  /** The Anti-Her category that triggered the redirect. */
  antiHerCategory?: string;
  /** Structured execution trace for audit/debugging. */
  trace: ReasoningTrace;
}

/** Injectable LLM reasoning function. */
export type ReasoningLLM = (query: string, context: string) => Promise<string>;

let reasoningLLM: ReasoningLLM | null = null;

/** Register the reasoning LLM. */
export function registerReasoningLLM(llm: ReasoningLLM): void {
  reasoningLLM = llm;
}

/** Reset (for testing). */
export function resetReasoningLLM(): void {
  reasoningLLM = null;
}

/**
 * Run the full chat reasoning pipeline.
 *
 * Returns a vault-grounded, PII-safe, guard-scanned answer.
 */
export async function reason(req: ReasoningRequest): Promise<ReasoningResult> {
  const trace = new TraceBuilder();

  // Bind trace requestId to BrainCoreClient for HTTP header threading
  if (req.coreClient) {
    req.coreClient.setRequestId(trace.getRequestId());
  }

  // 0. Anti-Her pre-screening (Law 4: never simulate emotional companionship)
  const preScreen = await preScreenMessage(req.query);
  trace.step('anti_her_screen', {
    category: preScreen.category,
    triggered: preScreen.shouldRedirect,
    confidence: preScreen.confidence,
  });

  if (preScreen.shouldRedirect) {
    const redirect = generateHumanRedirect(req.contactSuggestions ?? []);
    return {
      answer: redirect,
      sources: [],
      persona: req.persona,
      scrubbed: false,
      guardViolations: 0,
      stripped: false,
      densityTier: 'zero',
      model: null,
      vaultContextUsed: 0,
      antiHerRedirect: true,
      antiHerCategory: preScreen.category,
      trace: trace.build(),
    };
  }

  // 1. Assemble vault context (pass requestId for audit correlation)
  const context = await assembleContext(req.query, req.maxTokens, trace.getRequestId());
  const sources = context.items.map((item) => item.id);
  trace.step('context_assembly', {
    itemCount: context.items.length,
    personas: context.personas,
    tokenEstimate: context.tokenEstimate,
    requestId: trace.getRequestId(),
  });

  // No context → short-circuit
  if (context.items.length === 0 && !reasoningLLM) {
    return {
      answer: "I don't have any relevant information about that in my memory.",
      sources: [],
      persona: req.persona,
      scrubbed: false,
      guardViolations: 0,
      stripped: false,
      densityTier: 'zero',
      model: null,
      vaultContextUsed: 0,
      trace: trace.build(),
    };
  }

  // 2. Build context text for LLM
  const contextText = formatContextForLLM(context);
  const fullPrompt = `Context:\n${contextText}\n\nQuestion: ${req.query}`;

  // 3. Cloud gate — PII scrub if needed
  const gate = checkCloudGate(fullPrompt, req.persona, req.provider);
  trace.step('cloud_gate', {
    allowed: gate.allowed,
    scrubbed: gate.scrubbed,
    provider: req.provider,
  });

  if (!gate.allowed) {
    const density = analyzeDensity(context);
    return {
      answer: applyDisclosure(buildContextOnlyAnswer(context), density),
      sources,
      persona: req.persona,
      scrubbed: false,
      guardViolations: 0,
      stripped: false,
      densityTier: density.tier,
      model: null,
      vaultContextUsed: context.items.length,
      trace: trace.build(),
    };
  }

  // 4. LLM reasoning
  let rawAnswer: string;
  if (reasoningLLM) {
    rawAnswer = await reasoningLLM(req.query, gate.scrubbedText ?? fullPrompt);
    trace.step('llm_reasoning', { provider: req.provider, usedLLM: true });
  } else {
    rawAnswer = buildContextOnlyAnswer(context);
    trace.step('llm_reasoning', { usedLLM: false, fallback: 'context_only' });
  }

  // 5. Density analysis — compute BEFORE guard scan to enable tier-aware severity
  const density = analyzeDensity(context);
  trace.step('density_analysis', { tier: density.tier, itemCount: density.itemCount });

  // 6. Guard scan — density-tier aware: hallucinated trust in zero/single data is 'block'
  const scanResult = await scanResponse(rawAnswer, {
    persona: req.persona,
    piiScrubbed: gate.scrubbed,
    densityTier: density.tier,
  });
  let finalAnswer = rawAnswer;
  let stripped = false;
  trace.step('guard_scan', {
    violationCount: scanResult.violations.length,
    safe: scanResult.safe,
    categories: scanResult.violations.map((v) => v.category),
  });

  if (scanResult.violations.length > 0) {
    finalAnswer = stripViolations(rawAnswer, scanResult);
    stripped = true;
  }

  // 7. Rehydrate PII tokens if scrubbed
  if (gate.scrubbed && gate.vault) {
    finalAnswer = rehydrateResponse(finalAnswer, gate.vault);
    trace.step('pii_rehydrate', { rehydrated: true });
  }

  // 8. Apply density disclosure caveat
  finalAnswer = applyDisclosure(finalAnswer, density);

  return {
    answer: finalAnswer,
    sources,
    persona: req.persona,
    scrubbed: gate.scrubbed,
    guardViolations: scanResult.violations.length,
    stripped,
    densityTier: density.tier,
    model: reasoningLLM ? (req.provider !== 'none' ? req.provider : null) : null,
    vaultContextUsed: context.items.length,
    trace: trace.build(),
  };
}

/** Format context items for the LLM prompt. */
function formatContextForLLM(context: AssembledContext): string {
  if (context.items.length === 0) return '(no relevant context found)';

  return context.items
    .map((item) => {
      let text = `[${item.id}] ${item.content_l0}`;
      if (item.content_l1) text += `\n  ${item.content_l1}`;
      if (item.body) text += `\n  ${item.body}`;
      return text;
    })
    .join('\n');
}

/** Build a context-only answer without LLM. */
function buildContextOnlyAnswer(context: AssembledContext): string {
  if (context.items.length === 0) {
    return "I don't have any relevant information about that in my memory.";
  }

  const summaries = context.items
    .slice(0, 5)
    .map((item) => `- ${item.content_l0}`)
    .filter((s) => s.length > 2);

  return `Based on my memory:\n${summaries.join('\n')}`;
}
