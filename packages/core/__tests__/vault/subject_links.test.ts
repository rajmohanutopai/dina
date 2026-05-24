/**
 * Phase D matrix — vault_item_subjects (the structured recall edge).
 *
 * Covers the recall-link invariants the identity redesign relies on:
 *   - round-trip: link a person to an item → recall the item by person
 *   - idempotency on (item_id, person_id)
 *   - dangling-link safety: a subject row pointing at a missing item is
 *     skipped, never throws (cross-file: person lives in identity.sqlite,
 *     subjects in the persona vault — no SQL FK, so this CAN happen)
 *   - persona scoping: a person's subjects in one persona vault do NOT
 *     leak into another persona's recall
 *
 * Exercised against `InMemoryVaultRepository` (the contract-equivalent
 * of the SQLite repo; the SQLite path is covered end-to-end by the
 * brain post_publish + reminder_planner suites).
 */

import { makeVaultItem } from '@dina/test-harness';

import { InMemoryVaultRepository } from '../../src/vault/repository';

describe('vault_item_subjects — recall edge (Phase D)', () => {
  it('links a person to an item and recalls it by person', () => {
    const repo = new InMemoryVaultRepository();
    const item = makeVaultItem({ summary: 'loves eggs and bacon', content_l0: 'loves eggs and bacon' });
    repo.storeItemSync(item);
    repo.linkSubjectSync(item.id, 'person-quixote', { source: 'manual', confidence: 'high' });

    expect(repo.getItemIdsForPersonSync('person-quixote')).toEqual([item.id]);
    const recalled = repo.getItemsForPersonSync('person-quixote', 5);
    expect(recalled.map((i) => i.id)).toEqual([item.id]);
    expect(recalled[0].summary).toBe('loves eggs and bacon');
  });

  it('is idempotent on (item_id, person_id) — no duplicate link', () => {
    const repo = new InMemoryVaultRepository();
    const item = makeVaultItem({ summary: 'note' });
    repo.storeItemSync(item);
    repo.linkSubjectSync(item.id, 'person-a');
    repo.linkSubjectSync(item.id, 'person-a', { confidence: 'high' });
    expect(repo.getItemIdsForPersonSync('person-a')).toEqual([item.id]);
  });

  it('ignores empty ids', () => {
    const repo = new InMemoryVaultRepository();
    repo.linkSubjectSync('', 'person-a');
    repo.linkSubjectSync('item-1', '');
    expect(repo.getItemIdsForPersonSync('person-a')).toEqual([]);
    expect(repo.getItemIdsForPersonSync('')).toEqual([]);
  });

  it('dangling subject link (no matching item) is skipped, never throws', () => {
    const repo = new InMemoryVaultRepository();
    // Link a person to an item id that was never stored (or was deleted).
    repo.linkSubjectSync('ghost-item', 'person-a');
    // getItemIds still reports the raw link…
    expect(repo.getItemIdsForPersonSync('person-a')).toEqual(['ghost-item']);
    // …but materialising items skips the missing one without throwing.
    expect(() => repo.getItemsForPersonSync('person-a', 5)).not.toThrow();
    expect(repo.getItemsForPersonSync('person-a', 5)).toEqual([]);
  });

  it('a deleted item is excluded from person recall', () => {
    const repo = new InMemoryVaultRepository();
    const item = makeVaultItem({ summary: 'note' });
    repo.storeItemSync(item);
    repo.linkSubjectSync(item.id, 'person-a');
    repo.deleteItemSync(item.id);
    expect(repo.getItemsForPersonSync('person-a', 5)).toEqual([]);
  });

  it('persona scoping — a person’s subjects in one vault do not leak into another', () => {
    // Each persona has its OWN vault repo; person_id is global identity
    // metadata. Recall must be scoped to the persona being queried.
    const health = new InMemoryVaultRepository();
    const work = new InMemoryVaultRepository();
    const healthItem = makeVaultItem({ summary: 'allergic to penicillin' });
    health.storeItemSync(healthItem);
    health.linkSubjectSync(healthItem.id, 'person-emma');

    // The same person has no subjects in the work vault.
    expect(health.getItemsForPersonSync('person-emma', 5).map((i) => i.summary)).toEqual([
      'allergic to penicillin',
    ]);
    expect(work.getItemsForPersonSync('person-emma', 5)).toEqual([]);
  });

  it('respects the limit + newest-linked-first ordering', () => {
    const repo = new InMemoryVaultRepository();
    const a = makeVaultItem({ summary: 'first' });
    const b = makeVaultItem({ summary: 'second' });
    repo.storeItemSync(a);
    repo.storeItemSync(b);
    repo.linkSubjectSync(a.id, 'person-a');
    repo.linkSubjectSync(b.id, 'person-a');
    // Newest-linked first.
    expect(repo.getItemsForPersonSync('person-a', 5).map((i) => i.summary)).toEqual([
      'second',
      'first',
    ]);
    // Limit honoured.
    expect(repo.getItemsForPersonSync('person-a', 1).map((i) => i.summary)).toEqual(['second']);
  });
});
