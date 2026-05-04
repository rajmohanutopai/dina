/**
 * People extraction pipeline — detect names, link to contacts, merge duplicates.
 *
 * For each vault item:
 * 1. Extract person mentions from summary + body
 * 2. Resolve each mention to a known contact (by name, alias, or surface)
 * 3. Create relationship links (item → contact)
 * 4. Merge duplicates (same person mentioned multiple times)
 *
 * Source: ARCHITECTURE.md Task 10.4
 */

import {
  resolveMultiple,
  deduplicatePersons,
  extractPersonLinks,
  type ResolvedPerson,
  type PersonLink,
} from '../person/linking';
import { findByAlias } from '../../../core/src/contacts/directory';

export interface PersonMention {
  name: string;
  contactDID?: string;
  role?: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'name_match' | 'llm_extraction';
}

export interface ExtractionResult {
  itemId: string;
  mentions: PersonMention[];
  linkedContacts: string[];
  unresolved: string[];
}

/**
 * Extract people from a vault item's text content.
 *
 * Runs two passes:
 * 1. Regex-based name matching against known contacts (fast, high confidence)
 * 2. LLM-based extraction for new/unrecognized names (if provider available)
 *
 * Returns all detected mentions with resolution status.
 */
export async function extractPeople(
  itemId: string,
  text: string,
  knownPeople: ResolvedPerson[],
): Promise<ExtractionResult> {
  const mentions: PersonMention[] = [];
  const linkedDIDs = new Set<string>();
  const unresolvedNames = new Set<string>();

  // Pass 1: regex-based name matching against known contacts
  const nameMatches = resolveMultiple(text, knownPeople);
  const deduped = deduplicatePersons(nameMatches);

  for (const person of deduped) {
    const contact = findByAlias(person.name);
    mentions.push({
      name: person.name,
      contactDID: contact?.did,
      confidence: 'high',
      source: 'name_match',
    });
    if (contact) {
      linkedDIDs.add(contact.did);
    }
  }

  // Pass 2: LLM-based extraction for additional names
  try {
    const llmLinks = await extractPersonLinks(text);
    for (const link of llmLinks) {
      // Skip if already found by name matching
      if (mentions.some((m) => m.name.toLowerCase() === link.name.toLowerCase())) {
        continue;
      }

      // Try to resolve via contact alias
      const contact = findByAlias(link.name);
      mentions.push({
        name: link.name,
        contactDID: contact?.did,
        role: link.role_phrase,
        confidence: link.confidence,
        source: 'llm_extraction',
      });

      if (contact) {
        linkedDIDs.add(contact.did);
      } else {
        unresolvedNames.add(link.name);
      }
    }
  } catch {
    // LLM extraction failed — proceed with name-match results only
  }

  return {
    itemId,
    mentions,
    linkedContacts: [...linkedDIDs],
    unresolved: [...unresolvedNames],
  };
}

/**
 * Batch extract people from multiple vault items.
 *
 * Returns one ExtractionResult per item.
 */
export async function extractPeopleBatch(
  items: Array<{ id: string; text: string }>,
  knownPeople: ResolvedPerson[],
): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];
  for (const item of items) {
    results.push(await extractPeople(item.id, item.text, knownPeople));
  }
  return results;
}

/**
 * Merge extraction results across multiple items for the same contact.
 *
 * Aggregates all items that mention a contact into a single entry.
 */
export function mergeByContact(results: ExtractionResult[]): Map<string, string[]> {
  const contactToItems = new Map<string, string[]>();

  for (const result of results) {
    for (const did of result.linkedContacts) {
      let items = contactToItems.get(did);
      if (!items) {
        items = [];
        contactToItems.set(did, items);
      }
      if (!items.includes(result.itemId)) {
        items.push(result.itemId);
      }
    }
  }

  return contactToItems;
}
