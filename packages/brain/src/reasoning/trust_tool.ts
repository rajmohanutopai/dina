/**
 * `search_trust_network` agentic tool — verified peer reviews and
 * vendor/product reputation via the Trust Network AppView.
 *
 * The `VAULT_CONTEXT` system prompt points the agent here whenever
 * the user asks about buying, comparing, or evaluating a product or
 * vendor. Under the hood this does TWO complementary AppView calls:
 *
 *   1. `com.dina.trust.search` — full-text / faceted search across
 *      attestation records. Returns raw rows (sentiment, confidence,
 *      author DID, tags, timestamp). Good for "what do people say
 *      about X".
 *   2. `com.dina.trust.resolve` — aggregate trust level + recommendation
 *      for a subject (DID / product / domain / organization). Good
 *      for "is this vendor trustworthy?"
 *
 * The tool shape lets the LLM choose which of the two it wants by
 * passing a `subject` (→ resolve) OR a `query` (→ search). Passing
 * both does both and packs the result together. Passing neither is a
 * tool-call error.
 *
 * Source: brain/src/service/vault_context.py::_search_trust_network —
 * Python uses `self._core.search_trust_network(...)` which proxies to
 * the AppView. TS goes direct to AppView via the shared client
 * already wired into the agentic loop (same `appViewClient` instance
 * `search_provider_services` uses).
 */

import type { AgentTool } from './tool_registry';
import type {
  AppViewClient,
  ResolveTrustResponse,
  SearchTrustResponse,
} from '../appview_client/http';

/** Minimum AppView surface the tool needs — lets tests swap a stub in
 *  without building the full `AppViewClient`. */
export interface TrustAppViewClient
  extends Pick<AppViewClient, 'resolveTrust' | 'searchTrust'> {}

export interface SearchTrustNetworkToolOptions {
  appViewClient: TrustAppViewClient;
  /** Logger — receives `{event, error?, path?}` entries on AppView
   *  failures. Helps diagnose simulator-time issues where the trust
   *  endpoint is reachable but a record is missing. */
  logger?: (entry: Record<string, unknown>) => void;
  /** DID of the requester — forwarded to `resolveTrust` so the graph-
   *  context block is populated (shortest path, mutual connections).
   *  Leave unset when anonymous. */
  requesterDid?: string;
}

/**
 * Factory — returns an `AgentTool` the reasoning loop can register.
 * Tool name is `search_trust_network` to match the `VAULT_CONTEXT`
 * prompt's enumeration.
 */
export function createSearchTrustNetworkTool(
  options: SearchTrustNetworkToolOptions,
): AgentTool {
  const { appViewClient, logger, requesterDid } = options;
  return {
    name: 'search_trust_network',
    description:
      "Search verified peer reviews and vendor/product reputation in the Trust Network. Pass `subject` (a JSON string like `{\"type\":\"product\",\"domain\":\"amazon.com\",\"productId\":\"B0...\"}` or `{\"type\":\"did\",\"did\":\"did:plc:...\"}` or `{\"type\":\"organization\",\"domain\":\"nytimes.com\"}`) for an aggregate trust score + recommendation. Pass `query` (free text like 'standing desk reviews') + optional `subjectType` / `domain` / `sentiment` / `minConfidence` for raw attestation rows. At least one of subject or query is required.",
    parameters: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description:
            'JSON-stringified subject reference — triggers com.dina.trust.resolve. Examples: `{"type":"did","did":"did:plc:xyz"}`, `{"type":"product","domain":"amazon.com","productId":"B0CNYXFWDL"}`, `{"type":"organization","domain":"nytimes.com"}`.',
        },
        query: {
          type: 'string',
          description:
            'Free-text search against attestation content — triggers com.dina.trust.search.',
        },
        subjectType: {
          type: 'string',
          description:
            "Filter search to one subject type. One of: 'did', 'content', 'product', 'dataset', 'organization', 'claim'.",
        },
        domain: {
          type: 'string',
          description: 'Filter search + resolve to a specific domain (e.g. "amazon.com").',
        },
        sentiment: {
          type: 'string',
          description: "Filter search to 'positive', 'neutral', or 'negative' attestations.",
        },
        minConfidence: {
          type: 'string',
          description:
            "Minimum attestation confidence — 'speculative' | 'moderate' | 'high' | 'certain'. Filters out speculative reviews.",
        },
        context: {
          type: 'string',
          description:
            "Why the agent is resolving — influences the recommendation. One of: 'before-transaction', 'before-interaction', 'content-verification', 'product-evaluation', 'general-lookup'. Defaults to 'general-lookup'.",
        },
        limit: {
          type: 'number',
          description: 'Max search results to return (AppView caps at 100).',
        },
      },
      // NB: JSON Schema doesn't have a direct "one-of-these-two"
      // required constraint — we enforce that at runtime in execute().
      required: [],
    },
    async execute(args): Promise<{
      subject?: ResolveTrustResponse;
      search?: SearchTrustResponse;
      note?: string;
    }> {
      const subject = typeof args.subject === 'string' && args.subject !== '' ? args.subject : '';
      const query = typeof args.query === 'string' && args.query !== '' ? args.query : '';
      if (subject === '' && query === '') {
        throw new Error('search_trust_network: pass at least one of `subject` or `query`');
      }

      const out: { subject?: ResolveTrustResponse; search?: SearchTrustResponse; note?: string } = {};

      if (subject !== '') {
        try {
          out.subject = await appViewClient.resolveTrust({
            subject,
            ...(requesterDid !== undefined ? { requesterDid } : {}),
            ...(typeof args.domain === 'string' && args.domain !== '' ? { domain: args.domain } : {}),
            ...(typeof args.context === 'string' && isResolveContext(args.context)
              ? { context: args.context }
              : {}),
          });
        } catch (err) {
          logger?.({
            event: 'trust.resolve_failed',
            error: err instanceof Error ? err.message : String(err),
            subject,
          });
          out.note = 'Trust Network lookup failed — no verified peer data available for that subject.';
        }
      }

      if (query !== '') {
        try {
          out.search = await appViewClient.searchTrust({
            q: query,
            ...(typeof args.subjectType === 'string' && isSubjectType(args.subjectType)
              ? { subjectType: args.subjectType }
              : {}),
            ...(typeof args.domain === 'string' && args.domain !== '' ? { domain: args.domain } : {}),
            ...(typeof args.sentiment === 'string' && isSentiment(args.sentiment)
              ? { sentiment: args.sentiment }
              : {}),
            ...(typeof args.minConfidence === 'string' && isConfidence(args.minConfidence)
              ? { minConfidence: args.minConfidence }
              : {}),
            ...(typeof args.limit === 'number' && args.limit > 0
              ? { limit: Math.min(args.limit, 100) }
              : {}),
          });
        } catch (err) {
          logger?.({
            event: 'trust.search_failed',
            error: err instanceof Error ? err.message : String(err),
            query,
          });
          // Only override `note` if nothing else already set it.
          if (out.note === undefined) {
            out.note = 'Trust Network search failed — no verified peer data for that query.';
          }
        }
      }

      return out;
    },
  };
}

function isResolveContext(
  value: string,
): value is
  | 'before-transaction'
  | 'before-interaction'
  | 'content-verification'
  | 'product-evaluation'
  | 'general-lookup' {
  return (
    value === 'before-transaction' ||
    value === 'before-interaction' ||
    value === 'content-verification' ||
    value === 'product-evaluation' ||
    value === 'general-lookup'
  );
}

function isSubjectType(
  value: string,
): value is 'did' | 'content' | 'product' | 'dataset' | 'organization' | 'claim' {
  return (
    value === 'did' ||
    value === 'content' ||
    value === 'product' ||
    value === 'dataset' ||
    value === 'organization' ||
    value === 'claim'
  );
}

function isSentiment(value: string): value is 'positive' | 'neutral' | 'negative' {
  return value === 'positive' || value === 'neutral' || value === 'negative';
}

function isConfidence(
  value: string,
): value is 'speculative' | 'moderate' | 'high' | 'certain' {
  return (
    value === 'speculative' || value === 'moderate' || value === 'high' || value === 'certain'
  );
}
