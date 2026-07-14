/**
 * PLG-8 — tool-lane dispatch: params-are-egress, envelope assembly,
 * pinned-schema result validation (PLUGIN_ARCHITECTURE.md §9.1, §11).
 */

import {
  assessParamsEgress,
  buildPluginEnvelope,
  contextScopeViolation,
  decideDispatch,
  validatePluginResult,
} from '../../src/plugins/dispatch';
import { validateAgainstSchema } from '../../src/plugins/schema_validate';
import { parsePluginEnvelope } from '../../src/workflow/plugin_envelope';

import type { PluginInstall } from '../../src/plugins/registry';
import type { PluginIntentDecision } from '../../src/gatekeeper/intent';
import type { PluginCapabilityDecl, PluginManifest, PluginTrustAnchor } from '@dina/protocol';

function intent(overrides: Partial<PluginIntentDecision> = {}): PluginIntentDecision {
  return {
    allowed: true,
    riskLevel: 'SAFE',
    requiresApproval: false,
    audit: false,
    reason: 'SAFE floor',
    mode: 'silent',
    firstNCard: false,
    ...overrides,
  };
}

/** A minimal active runner install whose manifest carries one capability
 * — the source of truth `buildPluginEnvelope` now derives authority from. */
function installWithCap(cap: Partial<PluginCapabilityDecl> & { id: string }): PluginInstall {
  const capability = {
    display_name: 'Watch',
    interaction: 'query',
    action_class: 'read',
    kinds: ['tool'],
    ...cap, // caller overrides (incl. the required id) win
  } as PluginCapabilityDecl;
  const manifest = {
    $type: 'com.dinakernel.plugin.release',
    plugin_id: 'com.acme.flightwatch',
    version: '1.0.0',
    display_name: 'Flight Watch',
    execution: { mode: 'runner' },
    capabilities: [capability],
  } as unknown as PluginManifest;
  return {
    installId: 'pli_1',
    publisherDid: 'did:plc:pub',
    pluginId: 'com.acme.flightwatch',
    label: '',
    status: 'active',
    executionMode: 'runner',
    currentCid: 'bafyreicid',
    currentVersion: '1.0.0',
    manifest,
    installScopeHash: 's'.repeat(64),
    capabilityHashes: { [cap.id]: 'a'.repeat(64) },
    behaviorHash: 'b'.repeat(64),
    presentationHash: 'p'.repeat(64),
    trustAnchor: { kind: 'repo_proof' } as unknown as PluginTrustAnchor,
    configRevision: 3,
    createdAt: 0,
    updatedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// params-are-egress (§11.5)
// ---------------------------------------------------------------------------

describe('assessParamsEgress (§11.5)', () => {
  it('clears clean, in-scope params', () => {
    const a = assessParamsEgress({
      params: { flight: 'BA117', when: 'tomorrow' },
      paramCategories: ['travel'],
      consentedCategories: ['travel'],
    });
    expect(a.clears).toBe(true);
    expect(a.reasons).toHaveLength(0);
  });

  it('does NOT clear when params carry an out-of-scope category (the back-pain example)', () => {
    const a = assessParamsEgress({
      params: { query: 'find a chair because my back pain is worse' },
      paramCategories: ['shopping', 'health'],
      consentedCategories: ['shopping'],
    });
    expect(a.clears).toBe(false);
    expect(a.outOfScopeCategories).toEqual(['health']);
  });

  it('AUDIT D6 HIGH: a SENSITIVE category cards even when CONSENTED (dermatology plugin + health)', () => {
    const a = assessParamsEgress({
      params: { reason: 'book a dermatology appointment for my psoriasis flare' },
      paramCategories: ['appointment_booking', 'health'],
      consentedCategories: ['appointment_booking', 'health'], // health IS consented
    });
    expect(a.clears).toBe(false);
    expect(a.sensitiveCategories).toContain('health');
  });

  it('round-12 #17: a MIXED-CASE sensitive category is recognized even when consented same-cased', () => {
    // `Health`/`FINANCE` must not slip past the (lowercase) sensitive set nor
    // clear via a same-cased consent entry — the comparison folds case.
    const a = assessParamsEgress({
      params: { reason: 'pay my Finance bill' },
      paramCategories: ['Health', 'FINANCE'],
      consentedCategories: ['Health', 'FINANCE'], // same casing in consent
    });
    expect(a.clears).toBe(false);
    expect(a.sensitiveCategories).toEqual(expect.arrayContaining(['Health', 'FINANCE']));
  });

  it('does NOT clear when params contain regulated PII, even if categories are in scope', () => {
    const a = assessParamsEgress({
      params: { instruction: 'charge my card 4111 1111 1111 1111 for the booking' },
      paramCategories: ['shopping'],
      consentedCategories: ['shopping'],
    });
    expect(a.clears).toBe(false);
    expect(a.piiTypes).toContain('CREDIT_CARD');
    // Audit-log rendering is scrubbed (PII never in logs); the CARD
    // shows the exact outbound text (WYSIWYG, §11.5).
    expect(a.auditText).not.toContain('4111');
    expect(a.cardParamsText).toContain('4111');
  });

  it('AUDIT D6 HIGH: credential/API-key tokens are regulated (never silent)', () => {
    for (const secret of [
      'sk-live9fA3ZZZZ1234567890',
      'ghp_abcdefghij0123456789KKKK',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      const a = assessParamsEgress({
        params: { cmd: `log in with token ${secret}` },
        paramCategories: ['automation'],
        consentedCategories: ['automation'],
      });
      expect(a.clears).toBe(false);
      expect(a.piiTypes.some((t) => t === 'API_KEY' || t === 'BEARER_TOKEN')).toBe(true);
    }
    // A 'credentials' category also cards even if the classifier missed the token shape.
    expect(
      assessParamsEgress({
        params: { cmd: 'log in with my password Hunter2' },
        paramCategories: ['credentials'],
        consentedCategories: ['credentials'],
      }).clears,
    ).toBe(false);
  });

  it('AUDIT D6 MEDIUM: a hidden field NOT in the human flatten is still scanned (structured deep-scan)', () => {
    // The classifier labelled only the city; the `note` field carries an SSN.
    const a = assessParamsEgress({
      params: { city: 'NYC', note: 'my ssn is 123-45-6789' },
      paramCategories: ['dining'],
      consentedCategories: ['dining'],
    });
    expect(a.clears).toBe(false);
    expect(a.piiTypes).toContain('SSN');
  });

  it('AUDIT (non-string egress): numeric/boolean params are non-empty — they must NOT silently clear, and the card shows the full object', () => {
    const a = assessParamsEgress({
      params: { amount: 500, confirm: true },
      paramCategories: [], // classifier could not label
      consentedCategories: ['travel'],
    });
    // Previously {amount:500} produced an empty string-join and cleared
    // silently with a blank card. It must now fail toward the card.
    expect(a.clears).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/could not be classified/);
    // The owner's card renders the whole object, not an empty string.
    expect(a.cardParamsText).toContain('amount');
    expect(a.cardParamsText).toContain('500');
    expect(a.cardParamsText).toContain('confirm');
  });

  it('AUDIT (non-string egress): a card number stored as a NUMBER is still caught as regulated PII', () => {
    const a = assessParamsEgress({
      params: { card: 4111111111111111, note: 'pay' },
      paramCategories: ['shopping'],
      consentedCategories: ['shopping'],
    });
    expect(a.clears).toBe(false);
    expect(a.piiTypes).toContain('CREDIT_CARD');
  });

  it('P1-1: a secret nested DEEPER than the inspection cap does NOT clear (fail closed)', () => {
    let deep: unknown = { token: 'sk-live9fA3ZZZZ1234567890secret' };
    for (let i = 0; i < 20; i++) deep = { nest: deep };
    const a = assessParamsEgress({
      params: deep,
      paramCategories: ['travel'],
      consentedCategories: ['travel'],
    });
    // Previously the scan/card/content-check all truncated at depth 12, so a
    // secret below that cleared silently. It must now fail toward the card.
    expect(a.clears).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/deeper than|inspect/);
  });

  it('an unclassified param category is treated as out-of-scope (fail toward the card)', () => {
    const a = assessParamsEgress({
      params: { x: 'do the thing' },
      paramCategories: ['mystery'],
      consentedCategories: ['travel'],
    });
    expect(a.clears).toBe(false);
  });

  it('non-empty params the classifier could NOT label (empty category list) do not clear (§11.5)', () => {
    const a = assessParamsEgress({
      params: { text: 'sensitive stuff about my depression' },
      paramCategories: [],
      consentedCategories: ['travel'],
    });
    expect(a.clears).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/could not be classified/);
    // Genuinely empty params (nothing to leak) still clear.
    expect(
      assessParamsEgress({ params: {}, paramCategories: [], consentedCategories: ['travel'] })
        .clears,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decideDispatch — silent NECESSARY-not-SUFFICIENT (§9.1/§11.5)
// ---------------------------------------------------------------------------

describe('decideDispatch', () => {
  const clean = assessParamsEgress({
    params: { note: 'ok' },
    paramCategories: ['travel'],
    consentedCategories: ['travel'],
  });
  const dirty = assessParamsEgress({
    params: { note: 'my ssn is 123-45-6789' },
    paramCategories: ['travel'],
    consentedCategories: ['travel'],
  });

  it('SAFE + clean params → silent', () => {
    expect(decideDispatch(intent(), clean).mode).toBe('silent');
  });

  it('SAFE + dirty params → CARD, never silent (whatever the floor says)', () => {
    const d = decideDispatch(intent(), dirty);
    expect(d.mode).toBe('card');
    expect(d.reason).toContain('params require review');
  });

  it('grant-silenced HIGH + clean params → silent; + dirty → card', () => {
    const silencedHigh = intent({ riskLevel: 'HIGH', mode: 'silent', audit: true });
    expect(decideDispatch(silencedHigh, clean).mode).toBe('silent');
    expect(decideDispatch(silencedHigh, dirty).mode).toBe('card');
  });

  it('blocked floor stays blocked regardless of egress', () => {
    const blocked = intent({ riskLevel: 'BLOCKED', mode: 'blocked', allowed: false });
    expect(decideDispatch(blocked, clean).mode).toBe('blocked');
  });

  it('card floor stays a card; egress reasons ride along', () => {
    const card = intent({ riskLevel: 'MODERATE', mode: 'card', requiresApproval: true });
    const d = decideDispatch(card, dirty);
    expect(d.mode).toBe('card');
    expect(d.reason).toContain('also');
  });
});

// ---------------------------------------------------------------------------
// envelope assembly (§9.1)
// ---------------------------------------------------------------------------

describe('buildPluginEnvelope', () => {
  it('DERIVES every pinned authority field from the install — the caller cannot assert them', () => {
    const install = installWithCap({
      id: 'com.acme.flightwatch.watch',
      action_class: 'booking',
      kinds: ['tool'],
      result_schema: { type: 'object' },
      effects: { idempotency: 'supported' },
    });
    const env = buildPluginEnvelope({
      install,
      capabilityId: 'com.acme.flightwatch.watch',
      params: { flight: 'BA117' },
      context: [],
      executionId: 'exec-1',
      idempotencyKey: 'idem-1',
    });
    const parsed = parsePluginEnvelope(JSON.stringify(env));
    expect(parsed).not.toBeNull();
    // Config revision, manifest CID, scope hash, action class, effects,
    // and result schema all come from the install/manifest — not args.
    expect(parsed?.config_revision).toBe(3);
    expect(parsed?.manifest_cid).toBe('bafyreicid');
    expect(parsed?.approved_scope_hash).toBe('a'.repeat(64));
    expect(parsed?.action_class).toBe('booking');
    expect(parsed?.effects_idempotency).toBe('supported');
    expect(parsed?.schema_snapshot).toEqual({ type: 'object' });
  });

  it('round-15 #14: throws when authorization kind is "grant" but grantId is omitted (internal coherence)', () => {
    const install = installWithCap({ id: 'com.acme.flightwatch.watch', kinds: ['tool'] });
    // Builder would otherwise emit a typed envelope that parsePluginEnvelope
    // rejects (grant kind requires grant_id), silently terminalizing the task at
    // claim. Fail at build where the producer bug is diagnosable.
    expect(() =>
      buildPluginEnvelope({
        install,
        capabilityId: 'com.acme.flightwatch.watch',
        params: {},
        context: [],
        executionId: 'e',
        idempotencyKey: 'i',
        authorization: { kind: 'grant' }, // no grantId
      }),
    ).toThrow(/grant.*grantId/i);
    // A grant with an id, and a card without one, both build fine.
    expect(() =>
      buildPluginEnvelope({
        install,
        capabilityId: 'com.acme.flightwatch.watch',
        params: {},
        context: [],
        executionId: 'e2',
        idempotencyKey: 'i2',
        authorization: { kind: 'grant', grantId: 'plg_x' },
      }),
    ).not.toThrow();
    expect(() =>
      buildPluginEnvelope({
        install,
        capabilityId: 'com.acme.flightwatch.watch',
        params: {},
        context: [],
        executionId: 'e3',
        idempotencyKey: 'i3',
        authorization: { kind: 'card' },
      }),
    ).not.toThrow();
  });

  it('a capability with no declared idempotency derives "unsupported" (no silent auto-retry by default)', () => {
    const install = installWithCap({ id: 'com.acme.flightwatch.watch', kinds: ['tool'] });
    const env = buildPluginEnvelope({
      install,
      capabilityId: 'com.acme.flightwatch.watch',
      params: {},
      context: [],
      executionId: 'e',
      idempotencyKey: 'i',
    });
    expect(env.effects_idempotency).toBe('unsupported');
  });

  it('throws when the capability is not in the install manifest (integrity error)', () => {
    const install = installWithCap({ id: 'com.acme.flightwatch.watch' });
    expect(() =>
      buildPluginEnvelope({
        install,
        capabilityId: 'com.acme.nonexistent',
        params: {},
        context: [],
        executionId: 'e',
        idempotencyKey: 'i',
      }),
    ).toThrow();
  });

  it('P1-3: validates params against the consented params_schema before enqueue', () => {
    const install = installWithCap({
      id: 'com.acme.flightwatch.watch',
      kinds: ['tool'],
      params_schema: {
        type: 'object',
        required: ['flight'],
        properties: { flight: { type: 'string' } },
        additionalProperties: false,
      },
    });
    const build =
      (params: unknown): (() => void) =>
      () =>
        buildPluginEnvelope({
          install,
          capabilityId: 'com.acme.flightwatch.watch',
          params,
          context: [],
          executionId: 'e',
          idempotencyKey: 'i',
        });
    expect(build({})).toThrow(/params_schema/); // missing required
    expect(build({ flight: 'BA1', evil: 1 })).toThrow(/params_schema/); // extra property
    expect(build({ flight: 42 })).toThrow(/params_schema/); // wrong type
    expect(build({ flight: 'BA1' })).not.toThrow(); // valid
  });

  it('P1-2: bounds context against the consented data_scope.max_context_items', () => {
    const install = installWithCap({
      id: 'com.acme.flightwatch.watch',
      kinds: ['tool'],
      data_scope: { categories: ['travel'], max_context_items: 2 },
    });
    const build =
      (context: unknown): (() => void) =>
      () =>
        buildPluginEnvelope({
          install,
          capabilityId: 'com.acme.flightwatch.watch',
          params: {},
          context,
          executionId: 'e',
          idempotencyKey: 'i',
        });
    expect(build([{ a: 1 }, { b: 2 }])).not.toThrow(); // at the ceiling
    expect(build([])).not.toThrow(); // empty
    expect(build(undefined)).not.toThrow(); // absent
    expect(build([{ a: 1 }, { b: 2 }, { c: 3 }])).toThrow(/data_scope/); // over ceiling
    expect(build({ raw: 'vault row' })).toThrow(/data_scope/); // non-array = unmeasurable
  });

  it('P1-2: a capability declaring NO context scope must receive no context', () => {
    const install = installWithCap({ id: 'com.acme.flightwatch.watch', kinds: ['tool'] });
    const build =
      (context: unknown): (() => void) =>
      () =>
        buildPluginEnvelope({
          install,
          capabilityId: 'com.acme.flightwatch.watch',
          params: {},
          context,
          executionId: 'e',
          idempotencyKey: 'i',
        });
    expect(build([])).not.toThrow();
    expect(build([{ a: 1 }])).toThrow(/data_scope/); // no declared scope → none allowed
  });

  it('round-5 #7: raw regulated PII / secret tokens in context are refused even within the count ceiling', () => {
    const install = installWithCap({
      id: 'com.acme.flightwatch.watch',
      kinds: ['tool'],
      data_scope: { categories: ['travel'], max_context_items: 3 },
    });
    const build =
      (context: unknown): (() => void) =>
      () =>
        buildPluginEnvelope({
          install,
          capabilityId: 'com.acme.flightwatch.watch',
          params: {},
          context,
          executionId: 'e',
          idempotencyKey: 'i',
        });
    // Within the count ceiling, but carrying raw vault records the projection
    // should have scrubbed — quantity is not authority (#7).
    expect(build([{ note: 'my card is 4111 1111 1111 1111' }])).toThrow(/regulated/);
    expect(build([{ token: 'sk-abcdefghijklmnop1234567' }])).toThrow(/regulated/);
    expect(build([{ note: 'landing at 3pm, gate B12' }])).not.toThrow(); // clean projected item
  });
});

describe('contextScopeViolation (P1-2 unit)', () => {
  it('null/undefined/empty context is always within scope', () => {
    expect(contextScopeViolation(undefined, undefined)).toBeNull();
    expect(contextScopeViolation(null, 5)).toBeNull();
    expect(contextScopeViolation([], 0)).toBeNull();
  });
  it('non-array context is rejected (cannot be measured)', () => {
    expect(contextScopeViolation({ raw: 1 }, 5)).toMatch(/projected item array/);
    expect(contextScopeViolation('a string', 5)).toMatch(/projected item array/);
  });
  it('unset max means no context permitted', () => {
    expect(contextScopeViolation([{ a: 1 }], undefined)).toMatch(/no context scope/);
    expect(contextScopeViolation([{ a: 1 }], 0)).toMatch(/no context scope/);
  });
  it('within/over the ceiling', () => {
    expect(contextScopeViolation([{ a: 1 }, { b: 2 }], 2)).toBeNull();
    expect(contextScopeViolation([{ a: 1 }, { b: 2 }, { c: 3 }], 2)).toMatch(/exceeds/);
  });
  it('round-5 #7: raw regulated content is rejected even within count', () => {
    expect(contextScopeViolation([{ ssn: '123-45-6789' }], 5)).toMatch(/regulated/);
    expect(contextScopeViolation([{ x: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }], 5)).toMatch(
      /regulated/,
    );
    expect(contextScopeViolation([{ note: 'nothing sensitive' }], 5)).toBeNull();
  });
  it('round-9 #7: context too DEEP to fully scan is refused (a secret nested past the scan floor cannot hide)', () => {
    // Build a single item nested deeper than the depth-12 scanner floor, with a
    // secret at the bottom. Pre-round-9 the scanner silently stopped at 12 and
    // the secret cleared unscanned; now the over-depth item is refused outright.
    let deep: Record<string, unknown> = { ssn: '123-45-6789' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(contextScopeViolation([deep], 5)).toMatch(/deeper|cannot fully inspect/);
    // A shallow item with the same secret is still caught by the content scan.
    expect(contextScopeViolation([{ ssn: '123-45-6789' }], 5)).toMatch(/regulated/);
  });
  it('round-9 #7: context too LARGE to fully scan is refused (byte cap)', () => {
    // A small ITEM COUNT (1) but a huge payload — within max_context_items yet
    // over the byte inspection cap, so it cannot be fully scanned.
    const huge = [{ blob: 'x'.repeat(70 * 1024) }];
    expect(contextScopeViolation(huge, 5)).toMatch(/bytes|inspection cap/);
  });
});

// ---------------------------------------------------------------------------
// pinned-schema result validation (§9.1)
// ---------------------------------------------------------------------------

describe('validatePluginResult (§9.1: nonconforming = task failure)', () => {
  const schema = {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['watching', 'landed', 'delayed'] },
      delay_min: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  };

  it('accepts a conforming result', () => {
    const r = validatePluginResult('{"status":"delayed","delay_min":45}', schema);
    expect(r.ok).toBe(true);
    expect(r.parsed).toEqual({ status: 'delayed', delay_min: 45 });
  });

  it('rejects a missing required field', () => {
    const r = validatePluginResult('{"delay_min":10}', schema);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('status');
  });

  it('rejects an out-of-enum value', () => {
    expect(validatePluginResult('{"status":"exploded"}', schema).ok).toBe(false);
  });

  it('rejects an additional property (a plugin cannot smuggle extra fields past the pin)', () => {
    const r = validatePluginResult('{"status":"watching","tracking_pixel":"http://evil"}', schema);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('tracking_pixel');
  });

  it('rejects prototype-named smuggled fields (in-operator bypass — audit repro D6)', () => {
    // `'toString' in {}` is true via the prototype chain; the validator
    // must use hasOwnProperty or these slip past additionalProperties:false.
    for (const evil of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const r = validatePluginResult(`{"status":"watching","${evil}":"http://evil"}`, schema);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a wrong-typed field', () => {
    expect(validatePluginResult('{"status":"watching","delay_min":"lots"}', schema).ok).toBe(false);
  });

  it('rejects non-JSON', () => {
    expect(validatePluginResult('not json', schema).ok).toBe(false);
  });

  it('accepts any JSON when no schema was pinned', () => {
    expect(validatePluginResult('{"anything":true}', undefined).ok).toBe(true);
  });

  it('round-16 #6: an oversized or too-deep result is rejected even with NO pinned schema', () => {
    // The inbound params/context are already byte/depth-capped; the result was
    // not. On the in-process/mobile path (no HTTP body limit) a huge or deeply-
    // nested null-schema result would persist verbatim and bloat tasks/events.
    const huge = JSON.stringify({ blob: 'x'.repeat(70 * 1024) });
    expect(validatePluginResult(huge, undefined).ok).toBe(false);
    // Build a deeply-nested object (> MAX_PARAM_DEPTH=12).
    let deep = '';
    let close = '';
    for (let i = 0; i < 20; i++) {
      deep += '{"a":';
      close += '}';
    }
    expect(validatePluginResult(`${deep}1${close}`, undefined).ok).toBe(false);
    // A small shallow result still passes.
    expect(validatePluginResult('{"ok":true}', undefined).ok).toBe(true);
  });

  it('PLG-27 #5: the byte gate runs BEFORE JSON.parse — an oversized result is rejected on bytes, not parse', () => {
    // An over-cap string that is ALSO not valid JSON: if JSON.parse ran first it
    // would report "not valid JSON" (after materializing the whole string); the
    // byte gate now fires first with the byte-cap error, so the parse never runs.
    const oversizedGarbage = 'x'.repeat(70 * 1024); // not JSON, > MAX_PARAM_BYTES
    const r = validatePluginResult(oversizedGarbage, undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/byte/i);
    expect(r.error).not.toMatch(/not valid JSON/i);
    // A valid-but-oversized JSON result is likewise rejected on the byte gate.
    const oversizedJson = JSON.stringify({ blob: 'y'.repeat(70 * 1024) });
    expect(validatePluginResult(oversizedJson, undefined).error).toMatch(/byte/i);
  });
});

// ---------------------------------------------------------------------------
// the schema validator itself
// ---------------------------------------------------------------------------

describe('validateAgainstSchema', () => {
  it('handles nested objects + arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: 2,
          items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
    };
    expect(validateAgainstSchema({ items: [{ id: 'a' }, { id: 'b' }] }, schema).ok).toBe(true);
    expect(
      validateAgainstSchema({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, schema).ok,
    ).toBe(false);
    expect(validateAgainstSchema({ items: [{ noid: 1 }] }, schema).ok).toBe(false);
  });

  it('fails closed on an unknown type keyword (a result we cannot check is a result we reject)', () => {
    expect(validateAgainstSchema('x', { type: 'quantum' }).ok).toBe(false);
  });

  it('supports type unions', () => {
    const schema = { type: ['string', 'null'] };
    expect(validateAgainstSchema('x', schema).ok).toBe(true);
    expect(validateAgainstSchema(null, schema).ok).toBe(true);
    expect(validateAgainstSchema(5, schema).ok).toBe(false);
  });
});
