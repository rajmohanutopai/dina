/**
 * WS-6.3 — per-task context projection (§13.5, §11.3, FR-P3).
 *
 * The rule under test is "project per task, never a runner union". Its failure
 * mode is quiet: a union grows every time a capability is added, and nobody
 * editing the manifest sees the connection to what a DIFFERENT capability now
 * receives. So most of these tests are about what does NOT come out.
 *
 * The projection is also checked downstream by `contextScopeViolation`. That
 * one is a fail-closed backstop and its own comment says a producer must
 * scrub; these tests are about the producer finally existing, so the backstop
 * is not the only thing between the vault and a runner.
 */

import { projectContextForCapability } from '../../src/plugins/context_projection';

import type { PluginDataScope } from '@dina/protocol';

const SCOPE: PluginDataScope = {
  categories: ['orders', 'suppliers'],
  personas: ['work'],
  max_context_items: 3,
};

const ALLOWED = ['title', 'supplier_did'];

function item(category: string, persona: string, fields: Record<string, unknown> = {}) {
  return { category, persona, fields: { title: 'a thing', ...fields } };
}

describe('the projection is built from ONE capability’s declared scope', () => {
  it('passes items in a declared category and persona', () => {
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: [item('orders', 'work')],
    });
    expect(projected.items).toEqual([{ category: 'orders', fields: { title: 'a thing' } }]);
    expect(projected.excluded).toEqual([]);
  });

  /**
   * The union failure, stated directly. A plugin whose OTHER capability reads
   * health data must not widen what this one receives — and the only thing
   * standing between those two facts is that the projection reads one
   * capability's scope.
   */
  it('excludes a category this capability did not declare', () => {
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: [item('orders', 'work'), item('health', 'work')],
    });
    expect(projected.items).toHaveLength(1);
    expect(projected.excluded).toEqual([
      { reason: 'category_not_declared', category: 'health', persona: 'work' },
    ]);
  });

  it('excludes a persona this capability did not declare', () => {
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: [item('orders', 'health')],
    });
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0]?.reason).toBe('persona_not_declared');
  });

  it('gives NO context to a capability that declared no scope', () => {
    // Not "a safe default" and not "whatever is lying around". The manifest is
    // where a plugin says what it needs, and silence there is an answer.
    const projected = projectContextForCapability({
      scope: undefined,
      allowedFields: ALLOWED,
      candidates: [item('orders', 'work'), item('suppliers', 'work')],
    });
    expect(projected.items).toEqual([]);
    expect(projected.excluded).toHaveLength(2);
  });

  it('treats an ABSENT persona list differently from an EMPTY one', () => {
    // Absent means no persona restriction was declared, which the manifest
    // validator permits. Empty is a declaration of none. Reading the second as
    // the first would silently widen every capability that wrote `personas: []`.
    const noRestriction = projectContextForCapability({
      scope: { categories: ['orders'], max_context_items: 3 },
      allowedFields: ALLOWED,
      candidates: [item('orders', 'anything')],
    });
    expect(noRestriction.items).toHaveLength(1);

    const declaredNone = projectContextForCapability({
      scope: { categories: ['orders'], personas: [], max_context_items: 3 },
      allowedFields: ALLOWED,
      candidates: [item('orders', 'anything')],
    });
    expect(declaredNone.items).toEqual([]);
  });
});

describe('fields are copied IN by name, never scrubbed out', () => {
  /**
   * A deny-list leaks every key nobody thought of, and the keys nobody thinks
   * of are exactly the ones a new vault feature adds. So the test is not "does
   * it remove the bad field" but "does it carry only the named ones".
   */
  it('carries only the allow-listed fields', () => {
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: [
        item('orders', 'work', {
          supplier_did: 'did:plc:chairmaker',
          card_number: '4111111111111111',
          internal_note: 'margin is thin',
        }),
      ],
    });
    expect(projected.items[0]?.fields).toEqual({
      title: 'a thing',
      supplier_did: 'did:plc:chairmaker',
    });
  });

  it('carries nothing at all when the allow-list is empty', () => {
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: [],
      candidates: [item('orders', 'work', { supplier_did: 'did:plc:x' })],
    });
    expect(projected.items).toEqual([{ category: 'orders', fields: {} }]);
  });

  it('a field added to the vault tomorrow is excluded by default', () => {
    // The property that makes an allow-list worth the inconvenience: this
    // passes without anyone editing this file when a new field appears.
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: [item('orders', 'work', { some_future_field: 'sensitive' })],
    });
    expect(JSON.stringify(projected.items)).not.toContain('sensitive');
  });
});

describe('the item cap is the declared one', () => {
  it('stops at max_context_items and says what it dropped', () => {
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: Array.from({ length: 10 }, () => item('orders', 'work')),
    });
    expect(projected.items).toHaveLength(3);
    expect(projected.excluded).toHaveLength(7);
    expect(projected.excluded.every((e) => e.reason === 'over_item_cap')).toBe(true);
  });

  it('treats an undeclared ceiling as ZERO, not as unlimited', () => {
    // Matching the downstream backstop's reading. The generous interpretation
    // here would be the one place the two disagree, and the disagreement would
    // show up as a runner receiving context the checker then rejects.
    const projected = projectContextForCapability({
      scope: { categories: ['orders'], personas: ['work'] },
      allowedFields: ALLOWED,
      candidates: [item('orders', 'work')],
    });
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0]?.reason).toBe('over_item_cap');
  });
});

describe('the projection satisfies the downstream backstop', () => {
  it('produces an ARRAY, which is the shape the checker requires', () => {
    // `contextScopeViolation` refuses a non-array because it cannot be
    // measured against max_context_items. A producer that emitted an object
    // would be refused at dispatch, every time, for every plugin.
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: [item('orders', 'work')],
    });
    expect(Array.isArray(projected.items)).toBe(true);
  });

  it('never exceeds the cap the checker will measure against', () => {
    const projected = projectContextForCapability({
      scope: SCOPE,
      allowedFields: ALLOWED,
      candidates: Array.from({ length: 50 }, () => item('orders', 'work')),
    });
    expect(projected.items.length).toBeLessThanOrEqual(SCOPE.max_context_items ?? 0);
  });
});
