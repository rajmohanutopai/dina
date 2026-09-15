/**
 * THE CONTEXT PROJECTOR (PLUGIN_ARCHITECTURE §11, §13.5, FR-P3).
 *
 * Two rules with quiet failure modes, which is why most of these tests are
 * about what does NOT come out:
 *
 *   "project per task, never a runner union" — a union grows every time a
 *   capability is added, and nobody editing the manifest sees the connection
 *   to what a DIFFERENT capability now receives; and
 *
 *   "a manifest cannot request the fields it wants to exfiltrate" — the field
 *   list is Dina's table, so a manifest that names a category gets whatever
 *   Dina says that category means, narrowed by the action class.
 *
 * The projection is also checked downstream by `contextScopeViolation`. That
 * one is a fail-closed backstop whose own comment says a producer must scrub;
 * these are about the producer meeting its contract by construction, so the
 * backstop never has a reason to fire.
 */

import { createPersona, resetPersonaState } from '../../src/persona/service';
import {
  projectContextForCapability,
  projectInvocationContext,
  projectedCategories,
  projectionDigest,
} from '../../src/plugins/context_projection';
import { clearContextSources, setContextSource } from '../../src/plugins/context_sources';
import { templateFieldsFor } from '../../src/plugins/context_templates';
import { contextScopeViolation } from '../../src/plugins/dispatch';

import type { ContextCandidate } from '../../src/plugins/context_sources';
import type { PluginCapabilityDecl, PluginDataScope } from '@dina/protocol';

const NOW = Date.parse('2026-09-15T10:00:00Z');

const SCOPE: PluginDataScope = {
  categories: ['business_registry', 'address'],
  max_context_items: 3,
};

/** A GSTIN passes the regulated scan; the PAN inside it is not at a word boundary. */
const GSTIN = '27AAPFU0939F1ZV';

function registration(over: Partial<ContextCandidate['fields']> = {}): ContextCandidate {
  return {
    category: 'business_registry',
    fields: {
      role: 'self',
      legal_name: 'Utopai Furniture LLP',
      registration_scheme: 'gstin',
      registration_value: GSTIN,
      ...over,
    },
  };
}

function project(candidates: ContextCandidate[], actionClass = 'write', scope: PluginDataScope | undefined = SCOPE) {
  return projectContextForCapability({ scope, actionClass, candidates, nowMs: NOW });
}

beforeEach(() => {
  clearContextSources();
  resetPersonaState();
});

afterEach(() => {
  clearContextSources();
  resetPersonaState();
});

describe('the scope is ONE capability’s, never a runner union', () => {
  it('passes an item in a declared category', () => {
    const projected = project([registration()]);
    expect(projected.items).toEqual([
      {
        category: 'business_registry',
        fields: {
          role: 'self',
          legal_name: 'Utopai Furniture LLP',
          registration_scheme: 'gstin',
          registration_value: GSTIN,
        },
      },
    ]);
    expect(projected.excluded).toEqual([]);
  });

  it('refuses a category this capability did not declare, even when the PLUGIN did', () => {
    const projected = project([{ category: 'contact', fields: { role: 'counterparty' } }]);
    expect(projected.items).toEqual([]);
    expect(projected.excluded).toEqual([
      { reason: 'category_not_declared', category: 'contact', persona: '' },
    ]);
  });

  it('a capability that declared NO scope receives nothing at all', () => {
    // Called directly: `project`'s default scope would stand in for the very
    // `undefined` this test is about.
    const projected = projectContextForCapability({
      scope: undefined,
      actionClass: 'write',
      candidates: [registration()],
      nowMs: NOW,
    });
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0].reason).toBe('category_not_declared');
  });

  it('an undeclared max_context_items means ZERO, not unlimited', () => {
    const projected = project([registration()], 'write', { categories: ['business_registry'] });
    expect(projected.items).toEqual([]);
    expect(projected.excluded).toEqual([
      { reason: 'over_item_cap', category: 'business_registry', persona: '' },
    ]);
  });

  it('holds back past the cap, and a refused candidate never spends a slot', () => {
    const projected = project(
      [
        { category: 'contact', fields: { role: 'counterparty' } },
        registration(),
        registration({ registration_value: '29AAPFU0939F1Z6' }),
        registration({ registration_value: '07AAPFU0939F1ZQ' }),
        registration({ registration_value: '19AAPFU0939F1ZO' }),
      ],
      'write',
      { categories: ['business_registry'], max_context_items: 3 },
    );
    expect(projected.items).toHaveLength(3);
    // The contact was refused for its category, not counted against the cap.
    expect(projected.excluded.map((e) => e.reason)).toEqual(['category_not_declared', 'over_item_cap']);
  });
});

describe('the FIELDS are Dina’s, narrowed by the action class', () => {
  it('a lookup gets the registration; only a document gets the name on it', () => {
    const lookup = project([registration()], 'read');
    expect(Object.keys(lookup.items[0].fields).sort()).toEqual([
      'registration_scheme',
      'registration_value',
      'role',
    ]);
    const document = project([registration()], 'write');
    expect(Object.keys(document.items[0].fields)).toContain('legal_name');
  });

  it('a street line reaches a document and never a rate lookup', () => {
    const address: ContextCandidate = {
      category: 'address',
      fields: {
        role: 'self',
        line1: '12 Nehru Road',
        city: 'Bengaluru',
        region: 'Karnataka',
        postal_code: '560001',
        country: 'IN',
      },
    };
    expect(project([address], 'read').items[0].fields.line1).toBeUndefined();
    expect(project([address], 'read').items[0].fields.postal_code).toBe('560001');
    expect(project([address], 'write').items[0].fields.line1).toBe('12 Nehru Road');
  });

  it('a field the template does not name cannot travel, however a source labels it', () => {
    const projected = project([
      registration({ bank_account: '50100112233445', internal_note: 'owes us for June' }),
    ]);
    expect(projected.items[0].fields.bank_account).toBeUndefined();
    expect(projected.items[0].fields.internal_note).toBeUndefined();
  });

  it('an action class the table does not name projects nothing', () => {
    // `payment` is blocked long before a projection, and the table says so by
    // omission rather than by listing fields nothing will ever read.
    expect(templateFieldsFor('business_registry', 'payment')).toEqual([]);
    const projected = project([registration()], 'payment');
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0].reason).toBe('category_not_projectable');
  });

  it('a category Dina has no template for projects nothing', () => {
    const projected = project([{ category: 'delivery', fields: { state: 'dispatched' } }], 'write', {
      categories: ['delivery'],
      max_context_items: 4,
    });
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0].reason).toBe('category_not_projectable');
  });
});

describe('a value that does not fit its class is DROPPED, never coerced', () => {
  it('a kind outside its enumerated set does not travel', () => {
    const projected = project([registration({ registration_scheme: 'whatever-i-like' })]);
    expect(projected.items[0].fields.registration_scheme).toBeUndefined();
    expect(projected.items[0].fields.registration_value).toBe(GSTIN);
    expect(projected.droppedFields).toBe(1);
  });

  it('an object in a text slot does not travel — a payload can hold only strings', () => {
    const projected = project([registration({ legal_name: { deeply: { nested: 'secret' } } })]);
    expect(projected.items[0].fields.legal_name).toBeUndefined();
    expect(JSON.stringify(projected.items)).not.toContain('secret');
  });

  it('a timestamp becomes a bucket — the instant itself never leaves', () => {
    setContextSource('contact', () => [
      {
        category: 'contact',
        fields: {
          role: 'counterparty',
          display_name: 'ChairMaker',
          channel_kind: 'phone',
          trust_level: 'verified',
          known_since_class: NOW - 3 * 24 * 60 * 60 * 1000,
        },
      },
    ]);
    const projection = projectInvocationContext({
      capability: capabilityOf({ data_scope: { categories: ['contact'], max_context_items: 2 } }),
      subject: { contactDid: 'did:plc:chairmaker99' },
      nowMs: NOW,
    });
    expect(projection.items[0].fields.known_since_class).toBe('this_week');
    expect(JSON.stringify(projection.items)).not.toContain(String(NOW - 3 * 24 * 60 * 60 * 1000));
  });

  it('a text value is bounded and stripped of control and bidi characters', () => {
    const projected = project([
      registration({ legal_name: `Utopai\u0000\u202e Furniture\n\nLLP${'x'.repeat(400)}` }),
    ]);
    const name = projected.items[0].fields.legal_name;
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toContain('Utopai Furniture LLP');
    // The control character and the bidi override are both gone.
    expect(name.includes('\u0000')).toBe(false);
    expect(name.includes('\u202e')).toBe(false);
  });

  it('an item whose every field was dropped is excluded rather than sent empty', () => {
    const projected = project([
      { category: 'business_registry', fields: { role: 7, legal_name: null, registration_scheme: 'nope' } },
    ]);
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0].reason).toBe('no_projectable_fields');
  });
});

describe('nothing regulated travels — the producer meets the backstop’s contract', () => {
  it('a GSTIN passes, because it is what a filing prints', () => {
    expect(project([registration()]).items[0].fields.registration_value).toBe(GSTIN);
  });

  it('a bare PAN in the same slot is dropped — the scan does not care which field it is in', () => {
    const projected = project([
      registration({ registration_scheme: 'pan', registration_value: 'AAPFU0939F' }),
    ]);
    expect(projected.items[0].fields.registration_value).toBeUndefined();
    expect(projected.items[0].fields.registration_scheme).toBe('pan');
    expect(projected.droppedFields).toBe(1);
  });

  it('a card number a store happens to hold in a name field is dropped', () => {
    const projected = project([registration({ legal_name: 'Utopai 4111 1111 1111 1111' })]);
    expect(projected.items[0].fields.legal_name).toBeUndefined();
  });
});

/**
 * The producer's contract with the backstop, asserted against the BACKSTOP
 * ITSELF rather than argued in a comment. `contextScopeViolation` refuses a
 * context that is too deep, too large, over the item cap, or carrying
 * regulated content; none of those can fire on this module's output, and the
 * day one of those bounds moves this is what says so.
 */
describe('the projector cannot build a context the envelope would refuse', () => {
  it('stays silent on a full-sized projection at the manifest ceiling', () => {
    const cap = 25; // PLUGIN_CAPS.MAX_CONTEXT_ITEMS
    const long = 'Utopai Furniture Private Limited '.repeat(20);
    const candidates = Array.from({ length: cap }, (_, i) => ({
      category: 'address',
      fields: {
        role: 'counterparty',
        line1: `${long}${i}`,
        line2: long,
        city: long,
        region: long,
        postal_code: `56000${i}`,
        country: 'IN',
      },
    }));
    const projected = projectContextForCapability({
      scope: { categories: ['address'], max_context_items: cap },
      actionClass: 'write',
      candidates,
      nowMs: NOW,
    });
    expect(projected.items).toHaveLength(cap);
    expect(contextScopeViolation(projected.items, cap)).toBeNull();
  });

  it('stays silent on adversarial values a store might hold', () => {
    const projected = project([
      registration({ legal_name: 'AAPFU0939F', registration_value: '4111 1111 1111 1111' }),
      { category: 'address', fields: { role: 'self', line1: '2345', city: '67890123', country: 'IN' } },
      { category: 'address', fields: { role: 'counterparty', line1: 'sk-abcdefghijklmnopqrst', country: 'IN' } },
    ], 'write', { categories: ['business_registry', 'address'], max_context_items: 5 });
    expect(contextScopeViolation(projected.items, 5)).toBeNull();
    const asJson = JSON.stringify(projected.items);
    expect(asJson).not.toContain('AAPFU0939F');
    expect(asJson).not.toContain('4111');
    expect(asJson).not.toContain('sk-abcdefghijklmnopqrst');
  });
});

describe('the persona ring', () => {
  it('a Tier-0 item travels when the manifest declared no personas', () => {
    expect(project([registration()]).items).toHaveLength(1);
  });

  it('a Tier-0 item is held back when the manifest DID name personas', () => {
    createPersona('professional', 'standard');
    const projected = project([registration()], 'write', {
      categories: ['business_registry'],
      personas: ['professional'],
      max_context_items: 3,
    });
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0].reason).toBe('persona_not_declared');
  });

  it('a locked persona is NEVER in scope, even when the manifest names it', () => {
    createPersona('financial', 'locked');
    const projected = project([{ ...registration(), persona: 'financial' }], 'write', {
      categories: ['business_registry'],
      personas: ['financial'],
      max_context_items: 3,
    });
    expect(projected.items).toEqual([]);
    expect(projected.excluded[0].reason).toBe('persona_locked');
  });

  it('a persona this node does not recognise reads as locked', () => {
    const projected = project([{ ...registration(), persona: 'ghost' }], 'write', {
      categories: ['business_registry'],
      personas: ['ghost'],
      max_context_items: 3,
    });
    expect(projected.excluded[0].reason).toBe('persona_locked');
  });

  it('a sensitive persona is in scope — its clamp is the card, not the projection', () => {
    createPersona('health', 'sensitive');
    const projected = project([{ ...registration(), persona: 'health' }], 'write', {
      categories: ['business_registry'],
      personas: ['health'],
      max_context_items: 3,
    });
    expect(projected.items).toHaveLength(1);
  });
});

describe('gathering, per invocation', () => {
  it('asks each declared category its OWN question and refuses a source that answers another', () => {
    const asked: string[] = [];
    setContextSource('business_registry', (request) => {
      asked.push(request.category);
      return [registration(), { category: 'contact', fields: { role: 'counterparty' } }];
    });
    const projection = projectInvocationContext({
      capability: capabilityOf({ data_scope: { categories: ['business_registry'], max_context_items: 4 } }),
      subject: {},
      nowMs: NOW,
    });
    expect(asked).toEqual(['business_registry']);
    // The mislabelled candidate never even reaches the scope filter: the
    // category decides the template, so it would be shaped by the wrong rules.
    expect(projection.items).toHaveLength(1);
    expect(projection.excluded).toEqual([]);
  });

  it('names a declared category with no source, rather than passing it off as nothing to send', () => {
    const projection = projectInvocationContext({
      capability: capabilityOf({ data_scope: { categories: ['delivery', 'tax'], max_context_items: 4 } }),
      subject: {},
      nowMs: NOW,
    });
    expect(projection.unsourced).toEqual(['delivery', 'tax']);
    expect(projection.items).toEqual([]);
  });

  it('a source that throws contributes nothing and never sinks the invocation', () => {
    setContextSource('business_registry', () => {
      throw new Error('the settings store is shut');
    });
    const projection = projectInvocationContext({
      capability: capabilityOf({ data_scope: { categories: ['business_registry'], max_context_items: 4 } }),
      subject: {},
      nowMs: NOW,
    });
    expect(projection.items).toEqual([]);
    expect(projection.unsourced).toEqual(['business_registry']);
  });

  it('passes the subject through to the source, and nothing else', () => {
    let seen: unknown = null;
    setContextSource('business_registry', (request) => {
      seen = request;
      return [];
    });
    projectInvocationContext({
      capability: capabilityOf({ data_scope: { categories: ['business_registry'], max_context_items: 4 } }),
      subject: { contactDid: 'did:plc:chairmaker99', documentDigest: 'abc123' },
      nowMs: NOW,
    });
    expect(seen).toEqual({
      category: 'business_registry',
      actionClass: 'write',
      subject: { contactDid: 'did:plc:chairmaker99', documentDigest: 'abc123' },
      nowMs: NOW,
    });
  });
});

describe('what the audit line gets', () => {
  it('names the categories that travelled, sorted and deduplicated', () => {
    const projected = project([
      registration(),
      { category: 'address', fields: { role: 'self', city: 'Bengaluru', country: 'IN' } },
      registration({ registration_value: '29AAPFU0939F1Z6' }),
    ]);
    expect(projectedCategories(projected)).toEqual(['address', 'business_registry']);
  });

  it('digests what travelled — the same items digest the same, a changed one does not', () => {
    const a = project([registration()]);
    const b = project([registration()]);
    const c = project([registration({ legal_name: 'Someone Else LLP' })]);
    expect(projectionDigest(a)).toBe(projectionDigest(b));
    expect(projectionDigest(a)).not.toBe(projectionDigest(c));
    // The digest is a hash: it carries none of what it digests.
    expect(projectionDigest(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function capabilityOf(over: Partial<PluginCapabilityDecl> = {}): PluginCapabilityDecl {
  return {
    id: 'com.dinakernel.country.in.eway-bill',
    display_name: 'File an e-way bill',
    interaction: 'query',
    action_class: 'write',
    privacy_class: 'regulated',
    kinds: ['tool'],
    ...over,
  } as PluginCapabilityDecl;
}
