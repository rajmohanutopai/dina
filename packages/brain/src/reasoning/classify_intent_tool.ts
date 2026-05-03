/**
 * `classify_intent` tool — LLM-callable wrapper around the existing
 * pre-loop `IntentClassifier`. The agent uses it when its
 * understanding of the user's query has shifted mid-loop and the
 * original first-turn classification no longer fits.
 *
 * **Why both pre-loop AND tool.** The `IntentClassifier` already runs
 * once at /ask entry — that's the soft routing nudge that primes
 * the system prompt (sources / relevant_personas / temporal /
 * reasoning_hint). For multi-turn queries where the agent's plan
 * evolves (it called `search_vault`, found something unexpected, now
 * wants to re-route), exposing the same classifier as a tool lets
 * the agent reclassify on demand. Soft priming, not hard
 * shortlisting (design doc §9.3).
 *
 * **Output format.** Identical to what `IntentClassifier.classify`
 * returns — the agent sees the same shape it saw in the first-turn
 * priming block. No translation, no information loss.
 */

import type { AgentTool } from './tool_registry';
import type { IntentClassifier } from './intent_classifier';

const CLASSIFY_INTENT_DESCRIPTION = [
  'Re-evaluate routing for a query when your understanding has evolved (e.g. you gathered new context from other tools and need to reroute).',
  'Returns sources (vault / trust_network / provider_services / general_knowledge), relevant_personas, toc_evidence, temporal stance, and a one-sentence reasoning_hint.',
  'This is a soft routing nudge — you can still call any other tool regardless of the result.',
  'You typically do NOT need to call this for the first turn (the initial classification is already in the system prompt). Use it for multi-step queries where your plan has shifted.',
].join(' ');

const CLASSIFY_INTENT_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'The query to re-classify — typically the rephrased / refined version of the user request after gathering context.',
    },
  },
  required: ['query'],
} as const;

/**
 * Build the `classify_intent` tool bound to a shared `IntentClassifier`.
 * The host typically passes the same instance the pre-loop classifier
 * uses so re-classification stays cheap (router cache + same lite tier).
 */
export function createClassifyIntentTool(opts: {
  classifier: IntentClassifier;
}): AgentTool {
  return {
    name: 'classify_intent',
    description: CLASSIFY_INTENT_DESCRIPTION,
    parameters: CLASSIFY_INTENT_PARAMETERS as unknown as Record<string, unknown>,
    async execute(args: Record<string, unknown>): Promise<unknown> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query.length === 0) {
        // Mirror IntentClassifier.classify('')'s behaviour — return
        // the conservative default rather than erroring. The agent
        // can still proceed.
        return {
          sources: ['vault'],
          relevant_personas: [],
          toc_evidence: {},
          temporal: '',
          reasoning_hint: 'Empty query — defaulted to vault.',
        };
      }
      // IntentClassifier.classify already swallows every error and
      // returns a default — we don't need a try/catch here.
      return await opts.classifier.classify(query);
    },
  };
}
