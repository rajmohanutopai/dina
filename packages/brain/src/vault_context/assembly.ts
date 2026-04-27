/**
 * Vault context assembly — gather relevant items for LLM reasoning.
 *
 * Tool execution: vault search, progressive loading (L0→L1→L2).
 * Reasoning agent: multi-turn tool loop (max 6 turns).
 * User origin propagation: track who initiated the query.
 *
 * Source: brain/tests/test_vault_context.py
 */

import { queryVault, getItem, browseRecent } from '../../../core/src/vault/crud';
import { listPersonas } from '../../../core/src/persona/service';
import {
  getContact,
  resolveByName,
  findByAlias,
  listContacts,
} from '../../../core/src/contacts/directory';
import { listPending } from '../../../core/src/reminders/service';
import {
  searchTrustNetwork,
  type TrustSearchQuery,
  type SearchType,
} from '../../../core/src/trust/network_search';

export interface ContextItem {
  id: string;
  content_l0: string;
  content_l1?: string;
  body?: string;
  score: number;
  persona: string;
}

export interface AssembledContext {
  items: ContextItem[];
  tokenEstimate: number;
  personas: string[];
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export type ReasoningLLMProvider = (messages: LLMMessage[]) => Promise<LLMMessage>;

/** Maximum reasoning agent turns before forced stop. */
const MAX_REASONING_TURNS = 6;

/** Average tokens per character (rough estimate for context budgeting). */
const TOKENS_PER_CHAR = 0.25;

/** Default token budget when not specified. */
const DEFAULT_MAX_TOKENS = 8000;

/** Personas that are accessible by default. */
let accessiblePersonas: string[] = ['general'];

/** Injectable LLM provider for the reasoning agent. */
let reasoningProvider: ReasoningLLMProvider | null = null;

/** Set accessible personas (for testing / lifecycle integration). */
export function setAccessiblePersonas(personas: string[]): void {
  accessiblePersonas = [...personas];
}

/** Get accessible personas. */
export function getAccessiblePersonas(): string[] {
  return [...accessiblePersonas];
}

/** Register an LLM provider for the reasoning agent. */
export function registerReasoningProvider(provider: ReasoningLLMProvider): void {
  reasoningProvider = provider;
}

/** Reset the reasoning provider (for testing). */
export function resetReasoningProvider(): void {
  reasoningProvider = null;
}

/**
 * Tool declarations for the reasoning agent.
 */
const TOOL_DECLARATIONS: Array<{
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}> = [
  {
    name: 'list_personas',
    description:
      'List all available persona vaults the user has. Returns persona names and their types (default, sensitive, standard).',
    parameters: {},
  },
  {
    name: 'vault_search',
    description:
      "Search the user's vault for relevant memories, notes, and stored information. Returns ranked results with progressive detail levels.",
    parameters: { persona: 'string', query: 'string', limit: 'number' },
  },
  {
    name: 'browse_vault',
    description:
      'Browse recent items in a persona vault without a search query. Returns the most recently stored items.',
    parameters: { persona: 'string', limit: 'number' },
  },
  {
    name: 'vault_read',
    description:
      'Read the full content (L2 body) of a specific vault item by ID. Use after vault_search to get complete details.',
    parameters: { item_id: 'string' },
  },
  {
    name: 'contact_lookup',
    description:
      'Look up a contact by name, alias, or DID. Returns contact details, relationship, trust level, and sharing tier.',
    parameters: { query: 'string' },
  },
  {
    name: 'reminder_check',
    description: 'Check upcoming reminders for a person or topic within a time window.',
    parameters: { query: 'string', days_ahead: 'number' },
  },
  {
    name: 'search_trust_network',
    description:
      'Search the decentralized trust network for peer reviews about a person, product, or vendor. Returns aggregated trust scores and individual reviews.',
    parameters: { query: 'string', type: 'string' },
  },
];

/**
 * Get tool declarations for the reasoning agent.
 */
export function getToolDeclarations(): Array<{ name: string; description: string }> {
  return TOOL_DECLARATIONS.map(({ name, description }) => ({ name, description }));
}

/**
 * Propagate user origin through the reasoning chain.
 */
export function propagateUserOrigin(origin: string): string {
  if (!origin || origin.trim().length === 0) return 'system';
  const trimmed = origin.trim();
  if (trimmed === 'user' || trimmed === 'self' || trimmed === 'owner') return 'user';
  if (trimmed.startsWith('did:')) return trimmed;
  if (trimmed === 'system' || trimmed === 'cron' || trimmed === 'timer' || trimmed === 'sync')
    return 'system';
  return 'system';
}

/**
 * Execute a vault search tool call.
 */
export async function executeToolSearch(
  persona: string,
  query: string,
  limit?: number,
): Promise<ContextItem[]> {
  // Security: only search personas the user has access to
  if (!getAccessiblePersonas().includes(persona)) return [];

  const searchLimit = limit ?? 20;
  const results = queryVault(persona, { mode: 'fts5', text: query, limit: searchLimit });

  return results.map((item, index) => ({
    id: item.id,
    content_l0: item.content_l0 || item.summary || '',
    content_l1: index < 5 ? item.content_l1 || undefined : undefined,
    body: index < 1 ? item.body || undefined : undefined,
    score: 1.0 - index * 0.05,
    persona,
  }));
}

/**
 * Assemble vault context for a query across accessible personas.
 *
 * @param requestId — optional trace requestId, propagated to tool calls for audit correlation.
 *   Currently used for trace annotation; in production, callers should also
 *   bind this ID to BrainCoreClient via setRequestId() for HTTP header threading.
 */
export async function assembleContext(
  query: string,
  maxTokens?: number,
  requestId?: string,
): Promise<AssembledContext> {
  const budget = maxTokens ?? DEFAULT_MAX_TOKENS;
  const personas = getAccessiblePersonas();
  const allItems: ContextItem[] = [];

  // Per-persona hit counts — emitted as one structured line so the
  // simulator log can immediately tell whether /ask saw the right
  // vaults. A row stored under `personal` but accessible-list ==
  // ['general'] shows up here as `{persona: 'general', hits: 0}` and
  // no other persona — the smoking gun for the
  // "drain wrote, ask didn't see" class of dev-env bug.
  const perPersonaHits: Record<string, number> = {};

  for (const persona of personas) {
    const results = await executeToolSearch(persona, query, 20);
    perPersonaHits[persona] = results.length;
    allItems.push(...results);
  }
  // eslint-disable-next-line no-console
  console.info('[vault_context] assemble', {
    event: 'vault_context.searched',
    query_preview: query.slice(0, 80),
    personas_walked: personas,
    hits_per_persona: perPersonaHits,
    total_hits: allItems.length,
  });

  allItems.sort((a, b) => b.score - a.score);

  let tokenCount = 0;
  const selected: ContextItem[] = [];

  for (const item of allItems) {
    const itemTokens = estimateTokens(item);
    if (tokenCount + itemTokens > budget && selected.length > 0) break;
    selected.push(item);
    tokenCount += itemTokens;
  }

  return { items: selected, tokenEstimate: tokenCount, personas };
}

/**
 * Run a reasoning agent with multi-turn tool loop.
 *
 * The agent:
 * 1. Sends the query + context to the LLM
 * 2. If the LLM responds with tool calls, executes them and sends results back
 * 3. Repeats until the LLM produces a final answer or max turns reached
 *
 * When no LLM provider is registered, returns a context-based answer
 * built from the assembled context items.
 */
export async function runReasoningAgent(
  query: string,
  context: AssembledContext,
  maxTurns?: number,
): Promise<{ answer: string; sources: string[]; turnsUsed: number }> {
  const turnLimit = maxTurns ?? MAX_REASONING_TURNS;
  const sources: string[] = context.items.map((item) => item.id);

  // Without an LLM provider, return a context-based summary
  if (!reasoningProvider) {
    const answer = buildContextAnswer(query, context);
    return { answer, sources, turnsUsed: 0 };
  }

  // Build initial messages
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `You are Dina, a personal AI assistant. Answer the user's question using the provided vault context. Cite sources by item ID. Available tools: ${TOOL_DECLARATIONS.map((t) => t.name).join(', ')}.`,
    },
    {
      role: 'user',
      content: `Context:\n${formatContext(context)}\n\nQuestion: ${query}`,
    },
  ];

  let turnsUsed = 0;

  for (let turn = 0; turn < turnLimit; turn++) {
    turnsUsed++;
    const response = await reasoningProvider(messages);
    messages.push(response);

    // If no tool calls, the LLM has produced a final answer
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return { answer: response.content, sources, turnsUsed };
    }

    // Execute tool calls and add results
    for (const call of response.toolCalls) {
      const toolResult = await executeToolCall(call);
      messages.push({
        role: 'tool',
        content: JSON.stringify(toolResult),
        toolCallId: `${call.name}-${turn}`,
      });

      // Track new sources from tool results
      if (Array.isArray(toolResult)) {
        for (const item of toolResult) {
          if (item && typeof item === 'object' && 'id' in item) {
            sources.push(String(item.id));
          }
        }
      }
    }
  }

  // Max turns reached — extract answer from last assistant message
  const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
  return {
    answer:
      lastAssistant?.content ?? 'I could not find a complete answer within the reasoning limit.',
    sources: [...new Set(sources)],
    turnsUsed,
  };
}

/** Execute a single tool call. */
async function executeToolCall(call: ToolCall): Promise<unknown> {
  switch (call.name) {
    case 'list_personas':
      return executeListPersonas();

    case 'vault_search': {
      const query = String(call.args.query ?? '');
      const limit = Number(call.args.limit ?? 10);
      const named =
        typeof call.args.persona === 'string' && call.args.persona.trim() !== ''
          ? call.args.persona.trim()
          : null;
      if (named !== null) return executeToolSearch(named, query, limit);
      // Default — fan out across every accessible persona, merge by score.
      const merged: ContextItem[] = [];
      for (const persona of getAccessiblePersonas()) {
        merged.push(...(await executeToolSearch(persona, query, limit)));
      }
      merged.sort((a, b) => b.score - a.score);
      return merged.slice(0, limit);
    }

    case 'browse_vault': {
      const persona = String(call.args.persona ?? 'general');
      const limit = Number(call.args.limit ?? 10);
      return executeBrowseVault(persona, limit);
    }

    case 'vault_read': {
      const itemId = String(call.args.item_id ?? '');
      for (const persona of getAccessiblePersonas()) {
        const item = getItem(persona, itemId);
        if (item) return item;
      }
      return null;
    }

    case 'contact_lookup': {
      const query = String(call.args.query ?? '');
      return executeContactLookup(query);
    }

    case 'reminder_check': {
      const query = String(call.args.query ?? '');
      const daysAhead = Number(call.args.days_ahead ?? 7);
      return executeReminderCheck(query, daysAhead);
    }

    case 'search_trust_network': {
      const query = String(call.args.query ?? '');
      const searchType = String(call.args.type ?? 'entity_reviews') as SearchType;
      return executeTrustSearch(query, searchType);
    }

    default:
      return { error: `unknown tool: ${call.name}` };
  }
}

/** List accessible personas with their types. */
function executeListPersonas(): Array<{ name: string; tier: string; accessible: boolean }> {
  const accessible = new Set(getAccessiblePersonas());
  return listPersonas().map((p) => ({
    name: p.name,
    tier: p.tier,
    accessible: accessible.has(p.name),
  }));
}

/** Browse recent items in a persona vault without a search query. */
function executeBrowseVault(persona: string, limit: number): ContextItem[] {
  if (!getAccessiblePersonas().includes(persona)) {
    return []; // Persona not accessible — return empty
  }

  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const items = browseRecent(persona, now - oneWeek, now, limit);

  return items.map((item, index) => ({
    id: item.id,
    content_l0: item.content_l0 || item.summary || '',
    content_l1: index < 3 ? item.content_l1 || undefined : undefined,
    body: undefined, // browse returns summaries, not full bodies
    score: 1.0 - index * 0.05,
    persona,
  }));
}

/**
 * Look up a contact by name, alias, or DID.
 *
 * Returns contact details in a structured format suitable for LLM consumption.
 */
function executeContactLookup(query: string): Record<string, unknown> | null {
  if (!query) return null;

  // Try DID lookup first
  if (query.startsWith('did:')) {
    const contact = getContact(query);
    if (contact) return formatContactForLLM(contact);
  }

  // Try name lookup
  const byName = resolveByName(query);
  if (byName) return formatContactForLLM(byName);

  // Try alias lookup
  const byAlias = findByAlias(query);
  if (byAlias) return formatContactForLLM(byAlias);

  return null;
}

function formatContactForLLM(contact: {
  did: string;
  displayName: string;
  trustLevel: string;
  sharingTier: string;
  relationship: string;
  dataResponsibility: string;
  notes: string;
}): Record<string, unknown> {
  return {
    did: contact.did,
    name: contact.displayName,
    trust: contact.trustLevel,
    sharing: contact.sharingTier,
    relationship: contact.relationship,
    responsibility: contact.dataResponsibility,
    notes: contact.notes || undefined,
  };
}

/**
 * Check upcoming reminders, optionally filtered by a keyword query.
 *
 * Returns reminders due within the specified days-ahead window.
 */
function executeReminderCheck(
  query: string,
  daysAhead: number,
): Array<{ id: string; message: string; due_at: number; persona: string; kind: string }> {
  const now = Date.now();
  const windowEnd = now + daysAhead * 24 * 60 * 60 * 1000;
  const pending = listPending(windowEnd);

  // Filter by query if provided
  const filtered = query
    ? pending.filter((r) => r.message.toLowerCase().includes(query.toLowerCase()))
    : pending;

  return filtered.slice(0, 20).map((r) => ({
    id: r.id,
    message: r.message,
    due_at: r.due_at,
    persona: r.persona,
    kind: r.kind,
  }));
}

/** Build a context-based answer without LLM. */
function buildContextAnswer(query: string, context: AssembledContext): string {
  if (context.items.length === 0) {
    return "I don't have any relevant information in my memory about that.";
  }

  const summaries = context.items
    .slice(0, 5)
    .map((item) => `- ${item.content_l0}`)
    .filter((s) => s.length > 2);

  if (summaries.length === 0) {
    return "I found some related items but they don't contain enough detail to answer.";
  }

  return `Based on my memory:\n${summaries.join('\n')}`;
}

/** Format context items for the LLM system prompt. */
function formatContext(context: AssembledContext): string {
  return context.items
    .map((item) => {
      let text = `[${item.id}] ${item.content_l0}`;
      if (item.content_l1) text += `\n  Detail: ${item.content_l1}`;
      if (item.body) text += `\n  Full: ${item.body}`;
      return text;
    })
    .join('\n');
}

/**
 * Search the trust network for peer reviews about an entity.
 */
async function executeTrustSearch(
  query: string,
  type: SearchType,
): Promise<Record<string, unknown>> {
  try {
    const result = await searchTrustNetwork({ query, type, limit: 10 });
    return {
      query: result.query,
      aggregateScore: result.aggregateScore,
      totalReviews: result.totalReviews,
      fromLocalContacts: result.fromLocalContacts,
      fromNetwork: result.fromNetwork,
      reviews: result.reviews.slice(0, 5).map((r) => ({
        reviewer: r.reviewerName ?? r.reviewerDID,
        rating: r.rating,
        category: r.category,
        comment: r.comment,
      })),
    };
  } catch {
    return { error: 'Trust network search failed', query };
  }
}

/** Estimate token count for a context item. */
function estimateTokens(item: ContextItem): number {
  let chars = (item.content_l0 || '').length;
  if (item.content_l1) chars += item.content_l1.length;
  if (item.body) chars += item.body.length;
  return Math.max(1, Math.ceil(chars * TOKENS_PER_CHAR));
}
