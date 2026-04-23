/**
 * Vault browser data hook — persona list, search, item detail.
 *
 * Provides:
 *   - Persona list with open/locked state and item counts
 *   - Full-text search within a persona's vault
 *   - Item detail with tiered content (L0 headline, L1 summary, L2 body)
 *   - Item metadata (type, source, timestamp, sender, trust)
 *
 * Source: ARCHITECTURE.md Task 9.12
 */

import { listPersonas, isPersonaOpen, type PersonaState } from '@dina/core/src/persona/service';
import {
  queryVault,
  getItem,
  storeItem,
  clearVaults,
  vaultItemCount,
} from '@dina/core/src/vault/crud';
import type { VaultItem, SearchQuery } from '@dina/test-harness';

export interface PersonaListItem {
  name: string;
  tier: string;
  isOpen: boolean;
  itemCount: number;
  description: string;
}

export interface VaultSearchResult {
  id: string;
  type: string;
  summary: string;
  contentL0: string;
  timestamp: number;
  sender: string;
  persona: string;
}

export interface VaultItemDetail {
  id: string;
  type: string;
  source: string;
  summary: string;
  contentL0: string;
  contentL1: string;
  body: string;
  timestamp: number;
  sender: string;
  senderTrust: string;
  tags: string;
  metadata: string;
  enrichmentStatus: string;
  hasEmbedding: boolean;
}

/**
 * Get all personas with their vault status for the browser sidebar.
 */
export function getPersonaList(): PersonaListItem[] {
  return listPersonas().map((p) => ({
    name: p.name,
    tier: p.tier,
    isOpen: p.isOpen,
    itemCount: p.isOpen ? countItems(p.name) : 0,
    description: p.description,
  }));
}

/**
 * Search within a persona's vault.
 */
export function searchVault(persona: string, query: string, limit?: number): VaultSearchResult[] {
  if (!isPersonaOpen(persona)) return [];
  if (!query.trim()) return [];

  const searchQuery: SearchQuery = {
    mode: 'fts5',
    text: query,
    limit: limit ?? 20,
  };

  const items = queryVault(persona, searchQuery);
  return items.map((item) => toSearchResult(item, persona));
}

/**
 * Get item detail for the detail view.
 */
export function getItemDetail(persona: string, itemId: string): VaultItemDetail | null {
  if (!isPersonaOpen(persona)) return null;

  const item = getItem(persona, itemId);
  if (!item) return null;

  return toItemDetail(item);
}

/**
 * Get tiered content for progressive display.
 * L0: one-line headline (always shown)
 * L1: paragraph summary (shown on tap)
 * L2: full body (shown on expand)
 */
export function getTieredContent(
  persona: string,
  itemId: string,
): {
  l0: string;
  l1: string;
  l2: string;
  hasL1: boolean;
  hasL2: boolean;
} | null {
  const item = getItem(persona, itemId);
  if (!item) return null;

  return {
    l0: item.content_l0 || item.summary,
    l1: item.content_l1 || '',
    l2: item.body || '',
    hasL1: (item.content_l1?.length ?? 0) > 0,
    hasL2: (item.body?.length ?? 0) > 0,
  };
}

/**
 * Get the type distribution for a persona (for filter chips).
 */
/**
 * Get the type distribution for a persona (for filter chips).
 * Note: In production with SQLCipher, this would use SELECT type, COUNT(*) GROUP BY type.
 * The in-memory implementation cannot enumerate all items via search,
 * so this returns an empty array until the native backend is wired.
 */
export function getTypeDistribution(_persona: string): Array<{ type: string; count: number }> {
  // Cannot enumerate all items via FTS search (wildcard not supported).
  // Will be implemented when NativeVaultDB provides SQL GROUP BY.
  return [];
}

/**
 * Check if a persona is browsable (open).
 */
export function isPersonaBrowsable(persona: string): boolean {
  return isPersonaOpen(persona);
}

/** Count items in a persona vault. */
function countItems(persona: string): number {
  return vaultItemCount(persona);
}

/** Map VaultItem to search result. */
function toSearchResult(item: VaultItem, persona: string): VaultSearchResult {
  return {
    id: item.id,
    type: item.type,
    summary: item.summary,
    contentL0: item.content_l0 || item.summary,
    timestamp: item.timestamp,
    sender: item.sender,
    persona,
  };
}

/** Map VaultItem to detail view. */
function toItemDetail(item: VaultItem): VaultItemDetail {
  return {
    id: item.id,
    type: item.type,
    source: item.source,
    summary: item.summary,
    contentL0: item.content_l0 || item.summary,
    contentL1: item.content_l1,
    body: item.body,
    timestamp: item.timestamp,
    sender: item.sender,
    senderTrust: item.sender_trust,
    tags: item.tags,
    metadata: item.metadata,
    enrichmentStatus: item.enrichment_status,
    hasEmbedding: !!item.embedding && item.embedding.length > 0,
  };
}
