/**
 * WS-4.5 — §16.5: "An update cannot silently widen from catalog read to order
 * submission."
 *
 * That sentence is the whole threat model. A supplier pack the owner
 * consented to as a price list ships 1.1 that can also place orders; the new
 * manifest is well-formed, signed, and content-addressed, so nothing else in
 * the machinery objects, and consent given to a reader silently covers a
 * capability that commits money.
 *
 * The tests are written one-directionally, the way consent works: narrowing
 * needs no permission, because nobody is surprised by a plugin doing less.
 */

import { detectUpdateWidening } from '../../src/plugins/update_widening';

import type { PluginManifest } from '@dina/protocol';

type Capability = Record<string, unknown>;

function manifest(capabilities: Capability[]): PluginManifest {
  return {
    $type: 'com.dinakernel.plugin.release',
    plugin_id: 'com.acme.supplier',
    version: '1.0.0',
    display_name: 'Supplier',
    execution: { mode: 'runner' },
    capabilities,
  } as unknown as PluginManifest;
}

/** The consented shape: a catalog reader, and nothing more. */
function catalogReader(over: Capability = {}): Capability {
  return {
    id: 'com.acme.supplier.browse-catalog',
    display_name: 'Browse catalog',
    interaction: 'query',
    action_class: 'read',
    privacy_class: 'public',
    effects: { idempotency: 'supported' },
    data_scope: { categories: ['catalog'], personas: ['work'], max_context_items: 3 },
    ...over,
  };
}

describe('the case §16.5 names', () => {
  it('refuses a version that adds order submission to a catalog reader', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([
        catalogReader(),
        {
          id: 'com.acme.supplier.submit-order',
          display_name: 'Submit order',
          interaction: 'query',
          action_class: 'payment',
          privacy_class: 'personal',
          effects: { idempotency: 'supported' },
        },
      ]),
    );
    expect(verdict.widens).toBe(true);
    expect(verdict.findings).toContainEqual({
      kind: 'new_capability',
      capabilityId: 'com.acme.supplier.submit-order',
      to: 'payment',
    });
  });

  it('refuses the SAME capability quietly promoted from read to payment', () => {
    // The sneakier shape: the capability id and display name do not move, so a
    // diff of names shows nothing. Only the class changed.
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([catalogReader({ action_class: 'payment' })]),
    );
    expect(verdict.findings).toContainEqual({
      kind: 'action_class_raised',
      capabilityId: 'com.acme.supplier.browse-catalog',
      from: 'read',
      to: 'payment',
    });
  });
});

describe('narrowing and standing still need no fresh consent', () => {
  it('accepts an identical manifest', () => {
    expect(detectUpdateWidening(manifest([catalogReader()]), manifest([catalogReader()]))).toEqual({
      widens: false,
      findings: [],
    });
  });

  it('accepts a LOWER action class', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader({ action_class: 'payment' })]),
      manifest([catalogReader({ action_class: 'read' })]),
    );
    expect(verdict.widens).toBe(false);
  });

  it('accepts a capability being REMOVED', () => {
    // Nobody is surprised by a plugin doing less. Removal has its own
    // consequences — in-flight work for that capability — but they belong to
    // the drain authorizations, not to consent.
    const verdict = detectUpdateWidening(
      manifest([catalogReader(), catalogReader({ id: 'com.acme.supplier.other' })]),
      manifest([catalogReader()]),
    );
    expect(verdict.widens).toBe(false);
  });

  it('accepts a smaller context ceiling and a shorter category list', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([
        catalogReader({ data_scope: { categories: [], personas: ['work'], max_context_items: 1 } }),
      ]),
    );
    expect(verdict.widens).toBe(false);
  });
});

describe('the other four widenings', () => {
  it('refuses a raised privacy class', () => {
    // Not about money, still not what was agreed: a capability that read
    // public catalog data now wants regulated data.
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([catalogReader({ privacy_class: 'regulated' })]),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ kind: 'privacy_class_raised', from: 'public', to: 'regulated' }),
    );
  });

  it('refuses a raised context ceiling', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([
        catalogReader({
          data_scope: { categories: ['catalog'], personas: ['work'], max_context_items: 50 },
        }),
      ]),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ kind: 'context_items_raised', from: '3', to: '50' }),
    );
  });

  it('refuses a new data category', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([
        catalogReader({
          data_scope: {
            categories: ['catalog', 'health'],
            personas: ['work'],
            max_context_items: 3,
          },
        }),
      ]),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ kind: 'category_added', to: 'health' }),
    );
  });

  it('refuses a new persona', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([
        catalogReader({
          data_scope: {
            categories: ['catalog'],
            personas: ['work', 'health'],
            max_context_items: 3,
          },
        }),
      ]),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ kind: 'persona_added', to: 'health' }),
    );
  });

  it('refuses DROPPING the persona list, because absent means no restriction', () => {
    // The same distinction the context projector makes. Flattening absent to
    // an empty list here would read the widest possible scope as the
    // narrowest.
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([catalogReader({ data_scope: { categories: ['catalog'], max_context_items: 3 } })]),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({ kind: 'persona_added', to: '*' }),
    );
  });

  it('refuses WEAKENED idempotency, the quietest widening of the five', () => {
    // Name, class, and scope all stand still; a retry may now double-charge.
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([catalogReader({ effects: { idempotency: 'unsupported' } })]),
    );
    expect(verdict.findings).toContainEqual(
      expect.objectContaining({
        kind: 'idempotency_weakened',
        from: 'supported',
        to: 'unsupported',
      }),
    );
  });

  it('accepts idempotency being STRENGTHENED', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader({ effects: { idempotency: 'unsupported' } })]),
      manifest([catalogReader()]),
    );
    expect(verdict.widens).toBe(false);
  });
});

describe('unknown and absent values rank at the ceiling', () => {
  /**
   * An unknown value becoming a bypass is how allow-by-default rules fail.
   * The manifest validator rejects unknown classes on the way in, so this is
   * the second line — but a second line that ranked unknowns lowest would let
   * `action_class: "totally_safe"` sail past every comparison.
   */
  it('treats an UNKNOWN action class as the widest', () => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([catalogReader({ action_class: 'totally_safe' })]),
    );
    expect(verdict.widens).toBe(true);
  });

  it('treats an ABSENT action class as the widest', () => {
    // A capability that declines to say what it does has not said it is safe.
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([catalogReader({ action_class: undefined })]),
    );
    expect(verdict.widens).toBe(true);
  });

  it('does not treat an unknown class in the CONSENTED manifest as a licence', () => {
    // The mirror. Ranking the prior value at the ceiling means an update
    // cannot look narrower merely because what came before was unreadable —
    // it can only fail to widen.
    const verdict = detectUpdateWidening(
      manifest([catalogReader({ action_class: 'mystery' })]),
      manifest([catalogReader({ action_class: 'payment' })]),
    );
    expect(verdict.widens).toBe(false);
  });
});

describe('the report', () => {
  it('names EVERY widening, not the first', () => {
    // An owner deciding whether to re-consent needs the shape of the change.
    const verdict = detectUpdateWidening(
      manifest([catalogReader()]),
      manifest([
        catalogReader({
          action_class: 'payment',
          privacy_class: 'regulated',
          effects: { idempotency: 'unsupported' },
        }),
      ]),
    );
    expect(new Set(verdict.findings.map((f) => f.kind))).toEqual(
      new Set(['action_class_raised', 'privacy_class_raised', 'idempotency_weakened']),
    );
  });

  it('ignores a capability with no id, which cannot be matched to consent', () => {
    const verdict = detectUpdateWidening(manifest([catalogReader()]), manifest([{ id: 42 }]));
    expect(verdict.widens).toBe(false);
  });
});

/**
 * §16.5 OVER THE WHOLE CONSENT PROJECTION.
 *
 * The seven named kinds cover seven dimensions; the canonical consent digest
 * covers twenty. Everything below was classified as "no widening" while the
 * consent hash it is measured against changed — so an update could add a
 * network destination, swap the party receiving the owner's data, or widen the
 * brokered-operation allowlist, and apply without asking.
 *
 * One case per omitted field class, because a catch-all with one test is a
 * catch-all nobody knows the shape of.
 */
describe('the consent projection, not just the seven named kinds', () => {
  function widensOn(over: Capability, manifestOver: Record<string, unknown> = {}) {
    const before = manifest([catalogReader()]);
    const after = {
      ...(manifest([catalogReader(over)]) as unknown as Record<string, unknown>),
      ...manifestOver,
    } as unknown as PluginManifest;
    return detectUpdateWidening(before, after);
  }

  it.each([
    ['a NEW NETWORK DESTINATION', { network_domains: ['exfil.example.com'] }],
    ['a changed INTERACTION mode', { interaction: 'session' }],
    ['a new LANE it may serve', { kinds: ['provider'] }],
    ['a widened brokered-operation allowlist', { host_operations: ['pay.charge'] }],
    ['new routing phrases', { intent_phrases: ['buy me anything'] }],
    ['new host ops', { ops_used: ['fs.write'] }],
    ['a raised verification budget', { verify_budget: 99 }],
    ['a new machine move surface', { machine: { moves: [{ id: 'transfer' }] } }],
  ])('refuses %s', (_name, over) => {
    const verdict = widensOn(over as Capability);
    expect(verdict.widens).toBe(true);
    expect(verdict.findings.map((f) => f.kind)).toContain('consent_scope_changed');
  });

  it('refuses a changed RUNTIME ISSUER — a different party receives the data', () => {
    const verdict = widensOn(
      {},
      { execution: { mode: 'runner', runtime: { issuer: 'did:plc:somebodyelse' } } },
    );
    expect(verdict.widens).toBe(true);
    expect(verdict.findings.map((f) => f.kind)).toContain('consent_scope_changed');
  });

  it('refuses changed pinned ARTIFACTS — different code, same name', () => {
    const verdict = widensOn(
      {},
      { execution: { mode: 'runner', runtime: { artifacts: [{ digest: 'f'.repeat(64) }] } } },
    );
    expect(verdict.widens).toBe(true);
  });

  it('NAMES the fields that moved, so the card can say what changed', () => {
    const verdict = widensOn({ network_domains: ['exfil.example.com'], verify_budget: 5 });
    const scope = verdict.findings.find((f) => f.kind === 'consent_scope_changed');
    expect(scope?.to).toContain('network_domains');
    expect(scope?.to).toContain('verify_budget');
  });

  it('does NOT fire on a narrowing the typed rules already rank', () => {
    // Otherwise every narrowing becomes a re-consent prompt, and an owner
    // prompted for everything reads nothing.
    const verdict = detectUpdateWidening(
      manifest([catalogReader({ action_class: 'write' })]),
      manifest([catalogReader({ action_class: 'read' })]),
    );
    expect(verdict.widens).toBe(false);
  });

  it('does NOT fire on a STRICTLY ADDITIVE schema change — the ordinary minor', () => {
    // §9.13: "MINOR is strictly additive (new optional fields only)", and a
    // same-major update rebinds atomically while in-flight tasks complete
    // against their PINNED schemas. Prompting on that would defeat the drain
    // mechanism, and an owner prompted for everything reads nothing.
    //
    // THE TITLE USED TO SAY "on a schema change", full stop, and that was the
    // wrong general claim even though this particular case is right: both
    // schemas sit inside the per-capability scope hash, and the drain governs
    // tasks ALREADY created while consent governs what may be asked NEXT. The
    // exclusion let an install adopt a new data contract under an approval
    // given for a different one. What follows is now the ranked rule.
    const verdict = detectUpdateWidening(
      manifest([catalogReader({ params_schema: { type: 'object' } })]),
      manifest([
        catalogReader({ params_schema: { type: 'object', properties: { q: { type: 'string' } } } }),
      ]),
    );
    expect(verdict.widens).toBe(false);
  });

  it.each([
    [
      'a NEW REQUIRED input, which makes every previously valid call invalid',
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      {
        type: 'object',
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { type: 'string' } },
      },
    ],
    [
      'a REMOVED property the owner approved',
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
      { type: 'object', properties: { a: { type: 'string' } } },
    ],
    [
      'a CHANGED property type — same name, different contract',
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { a: { type: 'number' } } },
    ],
    [
      'a RELAXED required set, which loosens an input contract',
      { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
      { type: 'object', required: [], properties: { a: { type: 'string' } } },
    ],
    [
      'a construct this code cannot prove additive — fails closed',
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', oneOf: [{ type: 'object' }], properties: { a: { type: 'string' } } },
    ],
  ])('DOES fire on %s', (_label, prev, next) => {
    const verdict = detectUpdateWidening(
      manifest([catalogReader({ params_schema: prev })]),
      manifest([catalogReader({ params_schema: next })]),
    );
    expect(verdict.widens).toBe(true);
  });

  it('ranks the RESULT schema the same way as the params schema', () => {
    // Both are in `scopeHashInput`, and a changed result shape is a changed
    // contract about what comes back — which the owner also approved.
    expect(
      detectUpdateWidening(
        manifest([catalogReader({ result_schema: { type: 'object', properties: {} } })]),
        manifest([catalogReader({ result_schema: { type: 'array' } })]),
      ).widens,
    ).toBe(true);
  });
});
