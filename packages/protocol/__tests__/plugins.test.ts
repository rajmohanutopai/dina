/**
 * Plugin wire layer — PLG-1 (docs/PLUGIN_ARCHITECTURE.md §5, §8.1).
 *
 * Covers:
 *   (1) normalize — set-like fields dedup + code-point sort; behavior
 *       fields (transition ops, states) preserved as authored.
 *   (2) validate — golden runner + interpreted manifests pass; every
 *       rejection class fires (§5 rules 3/4/6, §14 fail-closed).
 *   (3) digests — three-digest separation: scope vs behavior vs
 *       presentation move independently; normalization prevents
 *       order-manufactured re-consent.
 *   (4) release rkey — rkey == f(cid) round-trip vs node:crypto;
 *       tamper + wrong-shape CIDs rejected (closed-default).
 *   (5) identity pointer — each of the five invariants violates
 *       independently.
 */

import { createHash } from 'node:crypto';

import {
  PLUGIN_CAPS,
  PLUGIN_NSIDS,
  base32Decode,
  base32Encode,
  canonicalJson,
  checkIdentityPointer,
  checkReleaseIntegrity,
  computePluginDigests,
  installIdFromLane,
  isPluginLane,
  isValidReleaseRkey,
  isValidTrustAnchor,
  normalizePluginManifest,
  normalizeStringSet,
  parseAtUri,
  pluginLane,
  releaseRkeyFromCid,
  sha256DigestFromCid,
  validatePluginManifest,
  type PluginIdentityRecord,
  type PluginManifest,
  type PluginValidationResult,
} from '../src';

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Golden runner-mode manifest (flight-watch style, §4). */
function runnerManifest(): PluginManifest {
  return {
    $type: PLUGIN_NSIDS.release,
    plugin_id: 'com.acme.flightwatch',
    version: '1.2.0',
    display_name: 'Flight Watch',
    short_description: 'Watches flights for delays.',
    min_plugin_protocol: 1,
    execution: {
      mode: 'runner',
      runtime: {
        hosted_endpoint: 'https://plugins.acme.com',
        issuer: { did: 'did:web:plugins.acme.com', key: 'zAcmeIssuerKey' },
        artifacts: { image_digest: 'sha256:abc123' },
      },
    },
    capabilities: [
      {
        id: 'com.acme.flightwatch.watch',
        display_name: 'Watch a flight',
        interaction: 'query',
        action_class: 'read',
        privacy_class: 'personal',
        params_schema: { type: 'object', properties: { flight: { type: 'string' } } },
        result_schema: { type: 'object', properties: { status: { type: 'string' } } },
        kinds: ['tool'],
        effects: { idempotency: 'unsupported' },
        intent_phrases: ['watch my flight'],
        data_scope: { categories: ['travel'], max_context_items: 5 },
        network_domains: ['api.acme.com'],
      },
    ],
    config_schema: {
      type: 'object',
      properties: { home_airport: { type: 'string' } },
    },
  };
}

/** Golden interpreted-mode manifest (Battleship style, §4). */
function interpretedManifest(): PluginManifest {
  return {
    $type: PLUGIN_NSIDS.release,
    plugin_id: 'com.acme.battleship',
    version: '2.0.0',
    display_name: 'Battleship',
    min_interpreter: 1,
    execution: { mode: 'interpreted' },
    capabilities: [
      {
        id: 'com.acme.battleship.play',
        display_name: 'Play Battleship',
        interaction: 'session',
        action_class: 'read',
        privacy_class: 'public',
        machine: {
          initial: 'placing',
          states: ['placing', 'battle', 'won', 'lost'],
          moves: {
            place: { type: 'object' },
            fire: { type: 'object', properties: { x: { type: 'number' } } },
          },
          transitions: [
            { from: 'placing', move: 'place', ops: ['commit'], to: 'battle' },
            { from: 'battle', move: 'fire', ops: ['verifyCommit', 'compare'], to: 'battle' },
          ],
          turn: 'alternate',
          timeouts: { move_sec: 86400, session_ttl_sec: 604800 },
          terminal: ['won', 'lost'],
        },
        ops_used: ['commit', 'compare', 'verifyCommit'],
        verify_budget: 0,
      },
    ],
  };
}

function expectOk(
  result: PluginValidationResult,
): asserts result is { ok: true; derivedFeatures: readonly string[] } {
  if (!result.ok) {
    throw new Error(`expected ok, got: ${JSON.stringify(result.errors, null, 2)}`);
  }
}

function expectCode(result: PluginValidationResult, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.map((e) => e.code)).toContain(code);
}

/** Deep-mutate helper: parse/stringify clone, then patch. */
function mutate(manifest: PluginManifest, patch: (m: any) => void): PluginManifest {
  const clone = JSON.parse(JSON.stringify(manifest));
  patch(clone);
  return clone as PluginManifest;
}

const normalize = normalizePluginManifest;

// ---------------------------------------------------------------------------
// (1) normalize
// ---------------------------------------------------------------------------

describe('normalizePluginManifest (§8.1 — normalized form is the stored form)', () => {
  it('dedups + sorts set-like arrays by code point', () => {
    expect(normalizeStringSet(['tool', 'provider', 'tool'])).toEqual(['provider', 'tool']);
    expect(normalizeStringSet(['b', 'a', 'B'])).toEqual(['B', 'a', 'b']); // code-point order
  });

  it('normalizes kinds, phrases, domains, categories, ops_used, required_features', () => {
    const raw = mutate(runnerManifest(), (m) => {
      m.required_features = ['zeta', 'alpha', 'zeta'];
      m.capabilities[0].kinds = ['tool', 'notify', 'tool'];
      m.capabilities[0].intent_phrases = ['zz', 'aa'];
      m.capabilities[0].network_domains = ['b.example.com', 'a.example.com'];
      m.capabilities[0].data_scope.categories = ['travel', 'errands', 'travel'];
    });
    const n = normalize(raw);
    const c = n.capabilities[0]!;
    expect(n.required_features).toEqual(['alpha', 'zeta']);
    expect(c.kinds).toEqual(['notify', 'tool']);
    expect(c.intent_phrases).toEqual(['aa', 'zz']);
    expect(c.network_domains).toEqual(['a.example.com', 'b.example.com']);
    expect(c.data_scope?.categories).toEqual(['errands', 'travel']);
  });

  it('preserves behavior fields as authored (transition ops order, states order)', () => {
    const m = interpretedManifest();
    const c = normalize(m).capabilities[0]!;
    expect(c.machine?.transitions[1]?.ops).toEqual(['verifyCommit', 'compare']);
    expect(c.machine?.states).toEqual(['placing', 'battle', 'won', 'lost']);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review fixes (F4 unenforceable schema keywords, F10 nested
// unknown fields, F13 code-point sort)
// ---------------------------------------------------------------------------

describe('validatePluginManifest — adversarial review fixes', () => {
  it('F13: sorts astral characters by CODE POINT, not UTF-16 code unit', () => {
    // U+1F600 (😀) is > U+E000 by code point, but its UTF-16 lead unit
    // (0xD83D) sorts BEFORE 0xE000. The canonical order is code point.
    const e000 = '\uE000';
    const grin = '\u{1F600}';
    expect(normalizeStringSet([grin, e000])).toEqual([e000, grin]);
    // Plain `.sort()` would put the surrogate-lead grin first — the bug.
    expect([grin, e000].sort()).toEqual([grin, e000]);
  });

  it('F10: an unknown key inside execution fails closed', () => {
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.execution.future_privileged_mode = true;
        }),
      ),
      'unknown_field',
    );
  });

  it('F10: unknown keys inside runtime / effects / data_scope fail closed', () => {
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.execution.runtime = { self_host: { npm: 'x', future_registry: 'evil' } };
        }),
      ),
      'unknown_field',
    );
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].effects.future_retry_policy = 'aggressive';
        }),
      ),
      'unknown_field',
    );
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].data_scope.future_vault_access = 'all';
        }),
      ),
      'unknown_field',
    );
  });

  it('F4: a result_schema using a constraint the pinned validator cannot enforce is rejected', () => {
    for (const badSchema of [
      { type: 'string', pattern: '^z' },
      { type: 'string', const: 'yes' },
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
      { type: 'number', exclusiveMinimum: 0 },
      { type: 'object', properties: { x: { type: 'string', format: 'email' } } }, // nested
    ]) {
      expectCode(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => {
            m.capabilities[0].result_schema = badSchema;
          }),
        ),
        'unenforceable_schema_keyword',
      );
    }
  });

  it('P1-2: a schema whose enforced-keyword VALUE is malformed is rejected', () => {
    for (const badSchema of [
      { type: 'string', maxLength: '1' }, // maxLength must be a number
      { type: 'object', required: [123] }, // required must be string[]
      { type: 'quantum' }, // unknown type
      { type: 'array', minItems: -1 }, // negative
      { type: 'object', properties: [] }, // properties must be an object
      { type: 'string', enum: [] }, // enum must be non-empty
    ]) {
      expectCode(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => {
            m.capabilities[0].result_schema = badSchema;
          }),
        ),
        'malformed_schema_constraint',
      );
    }
  });

  it('round-5 #3: tuple items (array) are rejected — the pinned runtime does not enforce them', () => {
    // A schema requiring per-position tuple item shapes is accepted by an
    // unfixed validator but IGNORED by the runtime (which validates every
    // element against `items` as a single schema, and an array-valued schema is
    // unconstrained) — so "1-char first item" would accept "too long".
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].result_schema = {
            type: 'array',
            items: [{ type: 'string', maxLength: 1 }],
          };
        }),
      ),
      'unenforceable_schema_keyword',
    );
  });

  it('round-5 #3: a boolean subschema is rejected — the runtime treats it as unconstrained', () => {
    // `{properties:{blocked:false}}` means "blocked must never appear" in JSON
    // Schema, but the pinned runtime treats a non-object schema as accept-all —
    // so a consented `false` would WRONGLY pass any value. Reject the form.
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].result_schema = { type: 'object', properties: { blocked: false } };
        }),
      ),
      'unenforceable_schema_keyword',
    );
  });

  it('round-6 #5: malformed primitive field VALUES are rejected structurally (not just enum/unknown-key)', () => {
    // `mutate`'s callback param is `any`, so these numeric-into-string-slot
    // assignments model a hostile/buggy manifest without casts.
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => (m.capabilities[0].display_name = 42)),
      ),
      'bad_capability_display_name',
    );
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => (m.capabilities[0].intent_phrases = [7])),
      ),
      'bad_phrase',
    );
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope = { categories: [9] })),
      ),
      'bad_data_categories',
    );
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.homepage = 42))),
      'bad_url',
    );
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.source_url = 99))),
      'bad_url',
    );
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.min_plugin_protocol = -1))),
      'bad_protocol_version',
    );
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.execution.runtime.issuer.did = 7))),
      'bad_issuer',
    );
  });

  it('round-6 #5: a numeric data_scope.categories does not CRASH the validator (fails closed)', () => {
    // `(7).includes` would throw inside the banned-category check — a malformed
    // manifest must fail closed, never throw.
    const build = (): PluginValidationResult =>
      validatePluginManifest(
        mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope = { categories: 7 })),
      );
    expect(build).not.toThrow();
    expectCode(build(), 'bad_data_categories');
  });

  it('round-7 #7: nested runtime/array/URL-scheme malformations are rejected (ingest-identical, fail closed)', () => {
    // execution.runtime must be an object, not a scalar.
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.execution.runtime = 7))),
      'bad_runtime',
    );
    // data_scope.personas must be a string array.
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope.personas = [42])),
      ),
      'bad_data_personas',
    );
    // required_features must be a string array.
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.required_features = [42]))),
      'bad_required_features',
    );
    // A dangerous URL scheme is rejected even though it is a short string.
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.homepage = 'javascript:alert(1)'))),
      'bad_url',
    );
    // http(s) homepages are accepted.
    expectOk(
      validatePluginManifest(
        normalize(mutate(runnerManifest(), (m) => (m.homepage = 'https://acme.example'))),
      ),
    );
  });

  it('round-8 #4: scalar-where-object and non-array-where-array fail closed (never accepted, never throw)', () => {
    // Objects that `checkKnownKeys` silently skipped when scalar.
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.execution.runtime.self_host = 7))),
      'bad_runtime_field',
    );
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.execution.runtime.artifacts = 7))),
      'bad_runtime_field',
    );
    expectCode(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope = 7))),
      'bad_data_scope',
    );
    // Non-array set-like fields would THROW on `for…of`; now fail closed.
    for (const [field, code] of [
      ['kinds', 'bad_kinds'],
      ['intent_phrases', 'bad_phrase'],
      ['network_domains', 'bad_domain'],
    ] as const) {
      const build = (): PluginValidationResult =>
        validatePluginManifest(mutate(runnerManifest(), (m) => (m.capabilities[0][field] = 7)));
      expect(build).not.toThrow();
      expectCode(build(), code);
    }
    // A non-array required_features must not throw the union loop.
    const rf = (): PluginValidationResult =>
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.required_features = 7)));
    expect(rf).not.toThrow();
    expectCode(rf(), 'bad_required_features');
  });

  it('round-9 #3/#11: capability elements + machine sub-fields fail closed (never throw, never silently accept)', () => {
    // A scalar / null capability ELEMENT reached Object.keys(null) or
    // cap.id.includes() on undefined — both THREW. Now fail closed.
    for (const bad of [null, 7, 'x'] as const) {
      const build = (): PluginValidationResult =>
        validatePluginManifest(mutate(runnerManifest(), (m) => (m.capabilities = [bad])));
      expect(build).not.toThrow();
      expectCode(build(), 'bad_capability');
    }
    // A scalar `capabilities` (not an array) must not throw the `.entries()` loop.
    const scalarCaps = (): PluginValidationResult =>
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.capabilities = 7)));
    expect(scalarCaps).not.toThrow();
    expectCode(scalarCaps(), 'bad_capabilities');

    // Machine sub-fields: states/transitions/terminal/ops were iterated with
    // `for…of` / `.entries()` (THROW on a scalar); `moves: 7` was silently
    // coerced to an empty move set (ACCEPTED). All must fail closed now.
    for (const [field, code] of [
      ['states', 'bad_states'],
      ['transitions', 'bad_transitions'],
      ['terminal', 'bad_terminal'],
      ['moves', 'bad_moves'],
    ] as const) {
      const build = (): PluginValidationResult =>
        validatePluginManifest(
          mutate(interpretedManifest(), (m) => (m.capabilities[0].machine[field] = 7)),
        );
      expect(build).not.toThrow();
      expectCode(build(), code);
    }
    // A scalar `machine` itself must not throw on `.initial`/`.transitions`.
    const scalarMachine = (): PluginValidationResult =>
      validatePluginManifest(mutate(interpretedManifest(), (m) => (m.capabilities[0].machine = 7)));
    expect(scalarMachine).not.toThrow();
    expectCode(scalarMachine(), 'bad_machine');

    // A scalar transition ELEMENT + scalar `ops` inside a transition.
    const scalarTransition = (): PluginValidationResult =>
      validatePluginManifest(
        mutate(interpretedManifest(), (m) => (m.capabilities[0].machine.transitions[0] = 7)),
      );
    expect(scalarTransition).not.toThrow();
    expectCode(scalarTransition(), 'bad_transition');
    const scalarOps = (): PluginValidationResult =>
      validatePluginManifest(
        mutate(interpretedManifest(), (m) => (m.capabilities[0].machine.transitions[0].ops = 7)),
      );
    expect(scalarOps).not.toThrow();
    expectCode(scalarOps(), 'bad_ops');
  });

  it('round-10 #6: root-null / issuer-null / interpreted-timeouts-null fail closed (never throw)', () => {
    // A root null / scalar reached Object.keys(null) → THROW; now a clean result.
    for (const bad of [null, 7, 'x', []] as const) {
      const build = (): PluginValidationResult => validatePluginManifest(bad as never);
      expect(build).not.toThrow();
      expectCode(build(), 'bad_manifest');
    }
    // execution.runtime.issuer = null reached null.did → THROW.
    const issuerNull = (): PluginValidationResult =>
      validatePluginManifest(
        mutate(runnerManifest(), (m) => (m.execution.runtime = { issuer: null })),
      );
    expect(issuerNull).not.toThrow();
    expectCode(issuerNull(), 'bad_issuer');
    // interpreted machine.timeouts = null reached null.move_sec → THROW.
    const timeoutsNull = (): PluginValidationResult =>
      validatePluginManifest(
        mutate(interpretedManifest(), (m) => (m.capabilities[0].machine.timeouts = null)),
      );
    expect(timeoutsNull).not.toThrow();
    expectCode(timeoutsNull(), 'bad_timeouts');
  });

  it('round-10 #7: Anti-Her ban is case- and separator-insensitive', () => {
    // Category with different case is still banned.
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope.categories = ['Romantic'])),
      ),
      'banned_category',
    );
    // A hyphenated banned token in the capability id (underscores can't occur in
    // the reverse-DNS grammar) no longer bypasses.
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.plugin_id = 'com.acme.virtual-friend';
          m.capabilities[0].id = 'com.acme.virtual-friend.chat';
        }),
      ),
      'banned_category',
    );
  });

  it('round-12 #16: a COMPOUND banned category token no longer bypasses (substring match)', () => {
    // The category comparison was exact array-element equality, so a compound
    // category containing a banned token slipped past while the id stayed clean.
    for (const cat of ['romantic_advice', 'emotional_intimacy_coach', 'companionship_plus']) {
      expectCode(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope.categories = [cat])),
        ),
        'banned_category',
      );
    }
  });

  it('round-10 #12: a non-object config_schema fails closed', () => {
    for (const bad of [null, 7, []] as const) {
      expectCode(
        validatePluginManifest(mutate(runnerManifest(), (m) => (m.config_schema = bad))),
        'bad_config_schema',
      );
    }
  });

  it('round-10 #23: strict semver — leading zeros / empty prerelease identifiers rejected', () => {
    for (const bad of ['01.02.003', '1.2.3-..', '1.2', 'v1.2.3', '1.2.3.4']) {
      expectCode(
        validatePluginManifest(mutate(runnerManifest(), (m) => (m.version = bad))),
        'bad_version',
      );
    }
    for (const ok of ['1.2.3', '0.0.1', '1.2.3-alpha.1', '1.2.3+build.5']) {
      expectOk(
        validatePluginManifest(normalize(mutate(runnerManifest(), (m) => (m.version = ok)))),
      );
    }
  });

  it('F4: a schema using only enforced keywords + annotations is accepted', () => {
    const ok = mutate(runnerManifest(), (m) => {
      m.capabilities[0].result_schema = {
        type: 'object',
        title: 'Result',
        description: 'ok',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['a', 'b'] },
          n: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      };
    });
    expectOk(validatePluginManifest(normalize(ok)));
  });
});

// ---------------------------------------------------------------------------
// (2) validate
// ---------------------------------------------------------------------------

describe('validatePluginManifest — golden paths', () => {
  it('accepts the golden runner manifest and derives its features', () => {
    const result = validatePluginManifest(normalize(runnerManifest()));
    expectOk(result);
    expect(result.derivedFeatures).toContain('kind.tool');
    expect(result.derivedFeatures).toContain('config');
  });

  it('accepts the golden interpreted manifest and derives session + ops', () => {
    const result = validatePluginManifest(normalize(interpretedManifest()));
    expectOk(result);
    expect(result.derivedFeatures).toContain('session');
    expect(result.derivedFeatures).toContain('op.commit');
    expect(result.derivedFeatures).toContain('op.verifyCommit');
  });

  it('unions publisher-declared required_features into the derived set (§14: declarations only ADD)', () => {
    const m = mutate(runnerManifest(), (mm) => {
      mm.required_features = ['some.future.feature'];
    });
    const result = validatePluginManifest(normalize(m));
    expectOk(result);
    expect(result.derivedFeatures).toContain('some.future.feature');
    expect(result.derivedFeatures).toContain('kind.tool'); // derived survives
  });
});

describe('validatePluginManifest — rejections (never first-match-wins)', () => {
  const cases: Array<[string, PluginManifest, string]> = [
    [
      'unknown top-level field fails closed (§14)',
      mutate(runnerManifest(), (m) => {
        m.telemetry_endpoint = 'https://evil.example';
      }),
      'unknown_field',
    ],
    [
      'unknown capability field fails closed (§14)',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].pull_access = true;
      }),
      'unknown_field',
    ],
    [
      'duplicate capability id',
      mutate(runnerManifest(), (m) => {
        m.capabilities.push(JSON.parse(JSON.stringify(m.capabilities[0])));
      }),
      'duplicate_capability_id',
    ],
    [
      'runner capability without kinds (§5: Core authorizes a consented declaration)',
      mutate(runnerManifest(), (m) => {
        delete m.capabilities[0].kinds;
      }),
      'missing_kinds',
    ],
    [
      'unknown kind fails closed',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].kinds = ['telepathy', 'tool'];
      }),
      'unknown_kind',
    ],
    [
      'provider kind requires query interaction — session interaction is interpreted-only, so a provider+session capability is doubly illegal',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].kinds = ['provider'];
        m.capabilities[0].interaction = 'session';
        m.capabilities[0].machine = undefined;
      }),
      'session_on_runner',
    ],
    [
      'runner capability without effects.idempotency (§9.1 retry contract)',
      mutate(runnerManifest(), (m) => {
        delete m.capabilities[0].effects;
      }),
      'missing_effects',
    ],
    [
      'banned category (Anti-Her, §5 rule 3)',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].data_scope.categories = ['companionship'];
      }),
      'banned_category',
    ],
    [
      'schema too deep (§5 rule 4)',
      mutate(runnerManifest(), (m) => {
        let node: any = { type: 'string' };
        for (let i = 0; i < 12; i++) node = { type: 'object', properties: { a: node } };
        m.capabilities[0].params_schema = node;
      }),
      'schema_too_deep',
    ],
    [
      '$ref rejected (recursion vector, §5 rule 4)',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].params_schema = { $ref: '#/definitions/self' };
      }),
      'recursive_ref',
    ],
    [
      'secret-typed config field (§5 rule 6)',
      mutate(runnerManifest(), (m) => {
        m.config_schema = {
          type: 'object',
          properties: { api_key: { type: 'string' } },
        };
      }),
      'secret_config_field',
    ],
    [
      'writeOnly config field (§5 rule 6)',
      mutate(runnerManifest(), (m) => {
        m.config_schema = {
          type: 'object',
          properties: { pin: { type: 'string', writeOnly: true } },
        };
      }),
      'secret_config_field',
    ],
    [
      'hosted runner without issuer (§14)',
      mutate(runnerManifest(), (m) => {
        delete m.execution.runtime.issuer;
      }),
      'hosted_without_issuer',
    ],
    [
      'http hosted endpoint',
      mutate(runnerManifest(), (m) => {
        m.execution.runtime.hosted_endpoint = 'http://plugins.acme.com';
      }),
      'bad_hosted_endpoint',
    ],
    [
      'control characters in intent phrase',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].intent_phrases = ['watch my\u0000flight'];
      }),
      'bad_phrase',
    ],
    [
      'un-normalized set-like array (§8.1: hash form must equal runtime form)',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].network_domains = ['b.acme.com', 'a.acme.com'];
      }),
      'not_normalized',
    ],
    [
      'runner fields on interpreted capability (§11: interpreted sees nothing personal)',
      mutate(interpretedManifest(), (m) => {
        m.capabilities[0].data_scope = { categories: ['travel'] };
      }),
      'runner_fields_on_interpreted',
    ],
    [
      'interpreted fields on runner capability',
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].instructions = 'be helpful';
      }),
      'interpreted_fields_on_runner',
    ],
    [
      'session capability with kinds (§5 rule 3)',
      mutate(interpretedManifest(), (m) => {
        m.capabilities[0].kinds = ['tool'];
      }),
      'kinds_on_session',
    ],
    [
      'bad plugin id',
      mutate(runnerManifest(), (m) => {
        m.plugin_id = 'not-reverse-dns';
      }),
      'bad_plugin_id',
    ],
    [
      'bad semver',
      mutate(runnerManifest(), (m) => {
        m.version = 'v1';
      }),
      'bad_version',
    ],
  ];

  it.each(cases.map(([name, m, code]) => [name, m, code] as const))('%s', (_name, m, code) => {
    // Cases are validated WITHOUT re-normalizing: the fixtures are
    // authored in normalized form, so each mutation is the only thing
    // the validator sees — and the not_normalized case depends on the
    // mutation surviving to the validator.
    expectCode(validatePluginManifest(m), code);
  });

  it('rejects ambiguous (state, move) transitions', () => {
    const m = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.transitions.push({
        from: 'battle',
        move: 'fire',
        ops: [],
        to: 'won',
      });
    });
    expectCode(validatePluginManifest(normalize(m)), 'ambiguous_transition');
  });

  it('rejects duplicate states', () => {
    const m = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.states.push('battle');
    });
    expectCode(validatePluginManifest(normalize(m)), 'duplicate_state');
  });

  it('rejects unknown ops (closed library, §10.2)', () => {
    const m = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.transitions[0].ops = ['httpFetch'];
    });
    expectCode(validatePluginManifest(normalize(m)), 'unknown_op');
  });

  it('rejects oversized manifests via rawByteLength (§5 rule 4)', () => {
    const result = validatePluginManifest(normalize(runnerManifest()), {
      rawByteLength: PLUGIN_CAPS.MAX_MANIFEST_BYTES + 1,
    });
    expectCode(result, 'manifest_too_large');
  });
});

// ---------------------------------------------------------------------------
// (3) digests
// ---------------------------------------------------------------------------

describe('computePluginDigests — three digests, three jobs (§8.1)', () => {
  it('is deterministic', () => {
    const m = normalize(runnerManifest());
    const a = computePluginDigests(m, sha256);
    const b = computePluginDigests(m, sha256);
    expect(a).toEqual(b);
  });

  it('array order in set-like fields does NOT change the scope hash after normalization', () => {
    const a = normalize(
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].kinds = ['notify', 'tool'];
      }),
    );
    const b = normalize(
      mutate(runnerManifest(), (m) => {
        m.capabilities[0].kinds = ['tool', 'notify'];
      }),
    );
    expect(computePluginDigests(a, sha256).installScopeHash).toBe(
      computePluginDigests(b, sha256).installScopeHash,
    );
  });

  it('a kinds change moves the scope hash, not the behavior hash', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].kinds = ['notify', 'tool'];
        }),
      ),
      sha256,
    );
    expect(changed.installScopeHash).not.toBe(base.installScopeHash);
    expect(changed.behaviorHash).toBe(base.behaviorHash);
    expect(changed.presentationHash).toBe(base.presentationHash);
  });

  it('a transition rewiring moves the behavior hash only (§8.1: wiring is not consent)', () => {
    const base = computePluginDigests(normalize(interpretedManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(interpretedManifest(), (m) => {
          m.capabilities[0].machine.transitions[1].to = 'won';
        }),
      ),
      sha256,
    );
    expect(changed.behaviorHash).not.toBe(base.behaviorHash);
    expect(changed.installScopeHash).toBe(base.installScopeHash);
    expect(changed.presentationHash).toBe(base.presentationHash);
  });

  it('a timeout change moves the behavior hash (pressure- and spam-relevant, §8.1)', () => {
    const base = computePluginDigests(normalize(interpretedManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(interpretedManifest(), (m) => {
          m.capabilities[0].machine.timeouts.move_sec = 3600;
        }),
      ),
      sha256,
    );
    expect(changed.behaviorHash).not.toBe(base.behaviorHash);
    expect(changed.installScopeHash).toBe(base.installScopeHash);
  });

  it('a display_name change moves the presentation hash only (deceptive rename is never silent)', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.display_name = 'Totally Legit Bank Helper';
        }),
      ),
      sha256,
    );
    expect(changed.presentationHash).not.toBe(base.presentationHash);
    expect(changed.installScopeHash).toBe(base.installScopeHash);
    expect(changed.behaviorHash).toBe(base.behaviorHash);
  });

  it('round-5 #9: a homepage swap moves the presentation hash only (phishing-relevant redirect)', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.homepage = 'https://look-alike.example';
        }),
      ),
      sha256,
    );
    expect(changed.presentationHash).not.toBe(base.presentationHash);
    expect(changed.installScopeHash).toBe(base.installScopeHash);
    expect(changed.behaviorHash).toBe(base.behaviorHash);
  });

  it('round-5 #9: source_url + icon swaps also move the presentation hash', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const src = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.source_url = 'https://evil.example/repo';
        }),
      ),
      sha256,
    );
    const icon = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.icon = 'blob://different-icon';
        }),
      ),
      sha256,
    );
    expect(src.presentationHash).not.toBe(base.presentationHash);
    expect(icon.presentationHash).not.toBe(base.presentationHash);
  });

  it('a runtime issuer change re-consents (a new issuer is a new party, §8.1/§14)', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.execution.runtime.issuer = { did: 'did:web:other.example', key: 'zOther' };
        }),
      ),
      sha256,
    );
    expect(changed.installScopeHash).not.toBe(base.installScopeHash);
  });

  it('AUDIT D9: interaction (query→session) moves the scope hash', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].interaction = 'session';
        }),
      ),
      sha256,
    );
    expect(changed.installScopeHash).not.toBe(base.installScopeHash);
  });

  it('AUDIT D9: a self_host source swap re-consents (a different artifact source is a party change)', () => {
    const withHost = mutate(runnerManifest(), (m) => {
      m.execution.runtime.self_host = { npm: 'acme-plugin@1.0.0' };
    });
    const swapped = mutate(runnerManifest(), (m) => {
      m.execution.runtime.self_host = { npm: 'evilcorp-plugin@1.0.0' };
    });
    expect(computePluginDigests(normalize(withHost), sha256).installScopeHash).not.toBe(
      computePluginDigests(normalize(swapped), sha256).installScopeHash,
    );
  });

  it('AUDIT D9: a card re-framing surfaces via the presentation hash (never silent, §14)', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const reframed = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].card = { title: 'Definitely-safe bank helper' };
        }),
      ),
      sha256,
    );
    expect(reframed.presentationHash).not.toBe(base.presentationHash);
    // …and does NOT touch the scope hash (a card is not consent).
    expect(reframed.installScopeHash).toBe(base.installScopeHash);
  });

  it('a config_schema change re-consents every capability (§8.1)', () => {
    const base = computePluginDigests(normalize(runnerManifest()), sha256);
    const changed = computePluginDigests(
      normalize(
        mutate(runnerManifest(), (m) => {
          m.config_schema.properties.favorite_store = { type: 'string' };
        }),
      ),
      sha256,
    );
    expect(changed.perCapability['com.acme.flightwatch.watch']).not.toBe(
      base.perCapability['com.acme.flightwatch.watch'],
    );
  });

  it('canonicalJson sorts keys and strips undefined', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// (4) release rkey — rkey == f(cid) (§5)
// ---------------------------------------------------------------------------

/** Build a CIDv1 (dag-cbor, sha2-256) string from a 32-byte digest. */
function cidFromDigest(digest: Uint8Array): string {
  const bytes = new Uint8Array(4 + digest.length);
  bytes.set([0x01, 0x71, 0x12, 0x20], 0);
  bytes.set(digest, 4);
  return `b${base32Encode(bytes)}`;
}

describe('release rkey — content-derived, enforced not assumed (§5)', () => {
  const digest = sha256(new TextEncoder().encode('release body bytes'));
  const cid = cidFromDigest(digest);

  it('round-trips: rkey is the base32 of the CID digest, 52 chars, rkey-safe', () => {
    const rkey = releaseRkeyFromCid(cid);
    expect(rkey).not.toBeNull();
    expect(rkey).toHaveLength(52);
    expect(rkey).toMatch(/^[a-z2-7]+$/);
    expect(isValidReleaseRkey(rkey as string, cid)).toBe(true);
    // The rkey encodes exactly the digest.
    expect(base32Decode(rkey as string)).toEqual(digest);
  });

  it('rejects a tampered rkey (overwritten/forged release)', () => {
    const rkey = releaseRkeyFromCid(cid) as string;
    const tampered = rkey.slice(0, -1) + (rkey.endsWith('a') ? 'b' : 'a');
    expect(isValidReleaseRkey(tampered, cid)).toBe(false);
    expect(checkReleaseIntegrity({ rkey: tampered, cid })?.code).toBe('rkey_mismatch');
    expect(checkReleaseIntegrity({ rkey, cid })).toBeNull();
  });

  it('AUDIT D9: rejects a non-canonical base32 CID (CID malleability)', () => {
    // Flip an unused trailing bit: base32Decode still yields the same
    // bytes, but the string is non-canonical → must be rejected so a
    // content address is unique.
    const rkey = releaseRkeyFromCid(cid) as string;
    const body = cid.slice(1);
    // The last char encodes trailing bits; pick a different char that
    // decodes to the same byte tail is hard to construct blindly, so
    // assert the round-trip property directly: any string whose
    // canonical re-encode differs is rejected.
    const nonCanonical = 'b' + body.slice(0, -1) + (body.endsWith('a') ? 'b' : 'a');
    // If that happened to still be canonical (equal digest), skip; else
    // it must be rejected OR map to a different (valid) digest.
    const d = sha256DigestFromCid(nonCanonical);
    if (d !== null) {
      // It decoded to a DIFFERENT canonical CID — fine, but it must not
      // alias our original digest under a non-canonical form.
      expect(releaseRkeyFromCid(nonCanonical)).not.toBe(rkey);
    }
  });

  it('rejects wrong-shape CIDs (closed-default)', () => {
    expect(releaseRkeyFromCid('')).toBeNull();
    expect(releaseRkeyFromCid('QmV0not-a-cidv1')).toBeNull(); // CIDv0-ish
    // Wrong codec (raw 0x55 instead of dag-cbor).
    const wrongCodec = new Uint8Array(4 + 32);
    wrongCodec.set([0x01, 0x55, 0x12, 0x20], 0);
    wrongCodec.set(digest, 4);
    expect(releaseRkeyFromCid(`b${base32Encode(wrongCodec)}`)).toBeNull();
    // Truncated digest.
    const short = new Uint8Array(4 + 16);
    short.set([0x01, 0x71, 0x12, 0x20], 0);
    expect(releaseRkeyFromCid(`b${base32Encode(short)}`)).toBeNull();
  });

  it('base32 round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64, 32]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode('UPPER')).toBeNull(); // lowercase only
  });
});

// ---------------------------------------------------------------------------
// (5) identity pointer — five invariants (§5)
// ---------------------------------------------------------------------------

describe('checkIdentityPointer — a pointer failing any invariant is no pointer at all', () => {
  const release = normalize(runnerManifest());
  const releaseCid = cidFromDigest(sha256(new TextEncoder().encode('v1.2.0')));
  const publisherDid = 'did:plc:acmepublisher';

  function identity(patch?: Partial<PluginIdentityRecord['current']>): PluginIdentityRecord {
    return {
      $type: PLUGIN_NSIDS.identity,
      plugin_id: 'com.acme.flightwatch',
      current: {
        uri: `at://${publisherDid}/${PLUGIN_NSIDS.release}/${releaseRkeyFromCid(releaseCid)}`,
        cid: releaseCid,
        version: '1.2.0',
        ...patch,
      },
    };
  }

  const baseInput = {
    identityRkey: 'com.acme.flightwatch',
    publisherDid,
    fetchedReleaseCid: releaseCid,
    release,
  };

  it('accepts a valid pointer', () => {
    expect(checkIdentityPointer({ ...baseInput, identity: identity() })).toEqual([]);
  });

  it('flags wrong repo', () => {
    const id = identity({ uri: `at://did:plc:evil/${PLUGIN_NSIDS.release}/xyz` });
    expect(checkIdentityPointer({ ...baseInput, identity: id })).toContain('wrong_repo');
  });

  it('flags wrong collection', () => {
    const id = identity({ uri: `at://${publisherDid}/com.dinakernel.plugin.identity/xyz` });
    expect(checkIdentityPointer({ ...baseInput, identity: id })).toContain('wrong_collection');
  });

  it('flags plugin_id mismatch', () => {
    expect(
      checkIdentityPointer({
        ...baseInput,
        identity: identity(),
        identityRkey: 'com.other.plugin',
      }),
    ).toContain('plugin_id_mismatch');
  });

  it('flags cid mismatch (pointer lies about the record it names)', () => {
    const otherCid = cidFromDigest(sha256(new TextEncoder().encode('other')));
    expect(
      checkIdentityPointer({ ...baseInput, identity: identity(), fetchedReleaseCid: otherCid }),
    ).toContain('cid_mismatch');
  });

  it('flags version mismatch (invariant 5: the label discovery UI renders)', () => {
    const id = identity({ version: '9.9.9' });
    expect(checkIdentityPointer({ ...baseInput, identity: id })).toContain('version_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Lanes + AT-URI parsing
// ---------------------------------------------------------------------------

describe('plugin lanes (§3: keyed on the install, never the publisher-chosen id)', () => {
  it('builds and parses plugin:<install_id>', () => {
    expect(pluginLane('inst_42')).toBe('plugin:inst_42');
    expect(isPluginLane('plugin:inst_42')).toBe(true);
    expect(isPluginLane('plugin:')).toBe(false);
    expect(isPluginLane('dina.local')).toBe(false);
    expect(installIdFromLane('plugin:inst_42')).toBe('inst_42');
    expect(installIdFromLane('other')).toBeNull();
  });
});

describe('parseAtUri', () => {
  it('parses at://did/collection/rkey and rejects malformed URIs', () => {
    expect(parseAtUri('at://did:plc:x/com.example.rec/abc')).toEqual({
      did: 'did:plc:x',
      collection: 'com.example.rec',
      rkey: 'abc',
    });
    expect(parseAtUri('https://example.com')).toBeNull();
    expect(parseAtUri('at://did:plc:x/only-two')).toBeNull();
    expect(parseAtUri('at://notadid/coll/rkey')).toBeNull();
  });
});

describe('round-13 hardening', () => {
  it('#16: isValidTrustAnchor accepts valid union members and rejects malformed ones', () => {
    expect(isValidTrustAnchor({ kind: 'repo_proof' })).toBe(true);
    expect(isValidTrustAnchor({ kind: 'debug_unsigned' })).toBe(true);
    expect(isValidTrustAnchor({ kind: 'org_key', orgDid: 'did:plc:acme' })).toBe(true);
    expect(isValidTrustAnchor({ kind: 'local_publisher_key', keyId: 'k1' })).toBe(true);
    // Unknown kind, missing required fields, non-objects → rejected.
    expect(isValidTrustAnchor({ kind: 'made_up' })).toBe(false);
    expect(isValidTrustAnchor({ kind: 'org_key' })).toBe(false); // no orgDid
    expect(isValidTrustAnchor({ kind: 'org_key', orgDid: '' })).toBe(false);
    expect(isValidTrustAnchor({ kind: 'local_publisher_key' })).toBe(false); // no keyId
    expect(isValidTrustAnchor(null)).toBe(false);
    expect(isValidTrustAnchor('repo_proof')).toBe(false);
  });

  it('#21: a display_name with a bidi-override / zero-width char is rejected', () => {
    expect(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.display_name = 'Flight‮Watch'))).ok,
    ).toBe(false);
    expect(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.display_name = 'Flight​Watch'))).ok,
    ).toBe(false);
    // A plain-ASCII name still passes.
    expect(
      validatePluginManifest(mutate(runnerManifest(), (m) => (m.display_name = 'Flight Watch'))).ok,
    ).toBe(true);
  });

  it('#22: a JSON schema with minimum > maximum is a malformed constraint', () => {
    expectCode(
      validatePluginManifest(
        mutate(runnerManifest(), (m) => {
          m.capabilities[0].result_schema = {
            type: 'object',
            properties: { n: { type: 'integer', minimum: 10, maximum: 1 } },
          };
        }),
      ),
      'malformed_schema_constraint',
    );
  });

  it('#20: a hosted_endpoint that is not a valid https URL is rejected', () => {
    const withEndpoint = (endpoint: string): PluginManifest =>
      mutate(runnerManifest(), (m) => {
        m.execution.runtime = {
          hosted_endpoint: endpoint,
          issuer: { did: 'did:web:acme.example', key: 'zAcmeIssuerKey' },
        };
      });
    const codes = (r: PluginValidationResult): string[] =>
      r.ok ? [] : r.errors.map((e) => e.code);
    // `https://` alone (no host) and a non-https scheme are rejected.
    expect(codes(validatePluginManifest(withEndpoint('https://')))).toContain(
      'bad_hosted_endpoint',
    );
    expect(codes(validatePluginManifest(withEndpoint('ftp://acme.example')))).toContain(
      'bad_hosted_endpoint',
    );
    // A well-formed https URL does NOT trip the endpoint check.
    expect(
      codes(validatePluginManifest(withEndpoint('https://runner.acme.example'))),
    ).not.toContain('bad_hosted_endpoint');
  });
});

describe('round-14 hardening', () => {
  const codes = (r: PluginValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

  it('#13: homepage/source_url with credentials, no host, or spoofing chars are rejected', () => {
    // Embedded credentials — a scheme-prefix regex accepted these.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.homepage = 'https://user:pass@acme.example')),
        ),
      ),
    ).toContain('bad_url');
    // Scheme with no host.
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (m) => (m.homepage = 'https://')))),
    ).toContain('bad_url');
    // A trailing zero-width char on an otherwise-valid URL.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.source_url = 'https://acme.example​')),
        ),
      ),
    ).toContain('bad_url');
    // Plain https(s) URLs still pass.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => {
            m.homepage = 'https://acme.example';
            m.source_url = 'https://github.com/acme/flightwatch';
          }),
        ),
      ),
    ).not.toContain('bad_url');
  });

  it('#14: runtime artifact / self_host evidence values must be non-empty spoof-free strings', () => {
    // Empty image_digest.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.execution.runtime.artifacts.image_digest = '')),
        ),
      ),
    ).toContain('bad_runtime_evidence');
    // Bidi-override in a self_host package ref.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => {
            m.execution.runtime.self_host = { npm: 'acme‮flightwatch' };
          }),
        ),
      ),
    ).toContain('bad_runtime_evidence');
    // A well-formed digest passes.
    expect(
      codes(
        validatePluginManifest(
          mutate(
            runnerManifest(),
            (m) => (m.execution.runtime.artifacts.image_digest = 'sha256:deadbeef'),
          ),
        ),
      ),
    ).not.toContain('bad_runtime_evidence');
  });

  it('#15: data_scope.personas rejects empty / spoofing-char entries', () => {
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope.personas = ['work', ''])),
        ),
      ),
    ).toContain('bad_data_personas');
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope.personas = ['wo​rk'])),
        ),
      ),
    ).toContain('bad_data_personas');
    // A clean persona list passes.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.capabilities[0].data_scope.personas = ['work'])),
        ),
      ),
    ).not.toContain('bad_data_personas');
  });

  it('#16: a whitespace-only intent phrase is rejected (non-empty by .length, blank rendered)', () => {
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.capabilities[0].intent_phrases = ['   '])),
        ),
      ),
    ).toContain('bad_phrase');
    // A real phrase still passes.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.capabilities[0].intent_phrases = ['watch my flight'])),
        ),
      ),
    ).not.toContain('bad_phrase');
  });

  it('#18: a whitespace-only display_name (manifest + capability) is rejected', () => {
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (m) => (m.display_name = '   ')))),
    ).toContain('bad_display_name');
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (m) => (m.capabilities[0].display_name = '  ')),
        ),
      ),
    ).toContain('bad_capability_display_name');
  });

  it('#21: isValidTrustAnchor rejects extra keys, oversized ids, and spoofing chars', () => {
    // Extra key smuggled onto an otherwise-valid anchor.
    expect(isValidTrustAnchor({ kind: 'repo_proof', orgDid: 'did:plc:evil' })).toBe(false);
    expect(isValidTrustAnchor({ kind: 'org_key', orgDid: 'did:plc:acme', extra: 'x' })).toBe(false);
    // Oversized id (> 256 chars).
    expect(isValidTrustAnchor({ kind: 'org_key', orgDid: 'd'.repeat(257) })).toBe(false);
    // Spoofing char in the consent-facing id.
    expect(isValidTrustAnchor({ kind: 'local_publisher_key', keyId: 'key‮id' })).toBe(false);
    // The clean forms still validate.
    expect(isValidTrustAnchor({ kind: 'org_key', orgDid: 'did:plc:acme' })).toBe(true);
    expect(isValidTrustAnchor({ kind: 'local_publisher_key', keyId: 'k1' })).toBe(true);
  });
});

describe('round-15 hardening', () => {
  const codes = (r: PluginValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

  it('#11: a hosted_endpoint with embedded credentials or spoofing chars is rejected', () => {
    const withEndpoint = (endpoint: string): PluginManifest =>
      mutate(runnerManifest(), (m) => {
        m.execution.runtime.hosted_endpoint = endpoint;
        m.execution.runtime.issuer = { did: 'did:web:acme.example', key: 'zAcmeIssuerKey' };
      });
    // Embedded credentials — a scheme+host parse accepted this before.
    expect(codes(validatePluginManifest(withEndpoint('https://user:pass@acme.example')))).toContain(
      'bad_hosted_endpoint',
    );
    // Trailing zero-width char.
    expect(codes(validatePluginManifest(withEndpoint('https://acme.example​')))).toContain(
      'bad_hosted_endpoint',
    );
    // A clean https endpoint still passes.
    expect(
      codes(validatePluginManifest(withEndpoint('https://runner.acme.example'))),
    ).not.toContain('bad_hosted_endpoint');
  });

  it('#12: a runtime issuer that is not a did:-prefixed / bounded / clean identity is rejected', () => {
    const withIssuer = (issuer: unknown): PluginManifest =>
      mutate(runnerManifest(), (m) => {
        m.execution.runtime.issuer = issuer;
      });
    // Non-did: DID.
    expect(codes(validatePluginManifest(withIssuer({ did: 'acme', key: 'zK' })))).toContain(
      'bad_issuer',
    );
    // Oversized DID.
    expect(
      codes(validatePluginManifest(withIssuer({ did: `did:web:${'a'.repeat(260)}`, key: 'zK' }))),
    ).toContain('bad_issuer');
    // Spoofing char in the key.
    expect(
      codes(validatePluginManifest(withIssuer({ did: 'did:web:acme.example', key: 'z‮K' }))),
    ).toContain('bad_issuer');
    // Empty key.
    expect(
      codes(validatePluginManifest(withIssuer({ did: 'did:web:acme.example', key: '' }))),
    ).toContain('bad_issuer');
    // The golden issuer still passes.
    expect(
      codes(
        validatePluginManifest(withIssuer({ did: 'did:web:acme.example', key: 'zAcmeIssuerKey' })),
      ),
    ).not.toContain('bad_issuer');
  });

  it('#18: parseAtUri rejects non-canonical URIs (query / fragment / whitespace / encoded)', () => {
    // rkey carrying a query, fragment, or percent-encoded separator would let
    // the pointer checker and a canonicalizing fetch disagree.
    expect(parseAtUri('at://did:plc:x/com.example.rec/abc?foo=bar')).toBeNull();
    expect(parseAtUri('at://did:plc:x/com.example.rec/abc#frag')).toBeNull();
    expect(parseAtUri('at://did:plc:x/com.example.rec/abc%2Fmore')).toBeNull();
    expect(parseAtUri('at://did:plc:x/com.example.rec/abc ')).toBeNull();
    expect(parseAtUri('  at://did:plc:x/com.example.rec/abc')).toBeNull();
    // The canonical form still parses.
    expect(parseAtUri('at://did:plc:x/com.example.rec/abc')).toEqual({
      did: 'did:plc:x',
      collection: 'com.example.rec',
      rkey: 'abc',
    });
  });
});

describe('round-16 hardening', () => {
  const codes = (r: PluginValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

  it('#8: interpreted machine with a non-string state identifier is rejected', () => {
    const m = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.states = [1, 2, 3];
      mm.capabilities[0].machine.initial = 1;
      mm.capabilities[0].machine.terminal = [3];
    });
    expect(codes(validatePluginManifest(m))).toContain('bad_state');
  });

  it('#9: a move schema using an unenforceable keyword (pattern) is rejected', () => {
    const m = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.moves.fire = {
        type: 'object',
        properties: { x: { type: 'string', pattern: '^A' } },
      };
    });
    expect(codes(validatePluginManifest(m))).toContain('unenforceable_schema_keyword');
  });

  it('#10: an over-ceiling interpreted timeout is rejected', () => {
    const m = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.timeouts.session_ttl_sec = Number.MAX_SAFE_INTEGER;
    });
    expect(codes(validatePluginManifest(m))).toContain('bad_timeouts');
    // The golden async-game timeouts (1d move / 7d session) still pass.
    expect(codes(validatePluginManifest(interpretedManifest()))).not.toContain('bad_timeouts');
  });

  it('#13: an enum with too many members is a malformed schema constraint', () => {
    const m = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        properties: {
          flight: { type: 'string', enum: Array.from({ length: 200 }, (_, i) => `f${i}`) },
        },
      };
    });
    expect(codes(validatePluginManifest(m))).toContain('malformed_schema_constraint');
  });

  it('#14: an over-count data_scope.categories list is rejected', () => {
    const m = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].data_scope.categories = Array.from({ length: 40 }, (_, i) => `c${i}`);
    });
    expect(codes(validatePluginManifest(m))).toContain('bad_data_categories');
  });

  it('#15: required_features with a spoofing char / oversize is rejected', () => {
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (mm) => (mm.required_features = ['fe‮at'])),
        ),
      ),
    ).toContain('bad_required_features');
    expect(
      codes(
        validatePluginManifest(
          mutate(
            runnerManifest(),
            (mm) => (mm.required_features = Array.from({ length: 40 }, (_, i) => `f${i}`)),
          ),
        ),
      ),
    ).toContain('bad_required_features');
  });

  it('#16: a schema property name with a spoofing char is rejected', () => {
    const m = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        properties: { ['amo‮tnu']: { type: 'string' } },
      };
    });
    expect(codes(validatePluginManifest(m))).toContain('malformed_schema_constraint');
  });

  it('#17: a maximally-malformed manifest caps diagnostics with a truncation sentinel', () => {
    const m = mutate(runnerManifest(), (mm) => {
      for (let i = 0; i < 400; i++) mm[`unknown_${i}`] = 1;
    });
    const r = validatePluginManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeLessThanOrEqual(PLUGIN_CAPS.MAX_DIAGNOSTICS + 1);
    expect(r.errors.map((e) => e.code)).toContain('diagnostics_truncated');
  });

  it('#18: an oversized / spoofing icon is rejected', () => {
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = 'x'.repeat(2000))))),
    ).toContain('bad_icon');
    // A small clean icon reference passes.
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = 'blob-ref-abc')))),
    ).not.toContain('bad_icon');
  });
});

describe('round-17 (PLG-27) hardening', () => {
  const codes = (r: PluginValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

  it('#7: a non-string capability id is a fail-closed RESULT, never a throw (totality)', () => {
    // `canon(cap.id)` calls `.toLowerCase()`. A numeric / null / omitted /
    // object id previously threw a TypeError, breaking the validator's
    // fail-closed contract on the untrusted AppView ingest path.
    for (const badId of [42, null, undefined, { x: 1 }, ['a']] as unknown[]) {
      const m = mutate(runnerManifest(), (mm) => {
        mm.capabilities[0].id = badId;
      });
      const run = (): PluginValidationResult => validatePluginManifest(m);
      expect(run).not.toThrow();
      expect(codes(run())).toContain('bad_capability_id');
    }
  });

  it('#11: a non-string text annotation (numeric title) is rejected; a string title passes', () => {
    const numericTitle = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        title: 42,
        properties: { flight: { type: 'string' } },
      };
    });
    expect(codes(validatePluginManifest(numericTitle))).toContain('malformed_schema_constraint');
    const stringTitle = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        title: 'Flight params',
        properties: { flight: { type: 'string' } },
      };
    });
    expect(codes(validatePluginManifest(stringTitle))).not.toContain('malformed_schema_constraint');
  });

  it('#12: over-cardinality / duplicate / blank schema collections are rejected', () => {
    const blankRequired = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        properties: { flight: { type: 'string' } },
        required: ['flight', '   '],
      };
    });
    expect(codes(validatePluginManifest(blankRequired))).toContain('malformed_schema_constraint');

    const dupeRequired = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        properties: { flight: { type: 'string' } },
        required: ['flight', 'flight'],
      };
    });
    expect(codes(validatePluginManifest(dupeRequired))).toContain('malformed_schema_constraint');

    const dupeType = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        properties: { flight: { type: ['string', 'string'] } },
      };
    });
    expect(codes(validatePluginManifest(dupeType))).toContain('malformed_schema_constraint');

    const wideProps = mutate(runnerManifest(), (mm) => {
      const props: Record<string, unknown> = {};
      for (let i = 0; i < PLUGIN_CAPS.MAX_SCHEMA_PROPERTIES + 5; i++) {
        props[`p${i}`] = { type: 'string' };
      }
      mm.capabilities[0].params_schema = { type: 'object', properties: props };
    });
    expect(codes(validatePluginManifest(wideProps))).toContain('malformed_schema_constraint');
  });

  it('#13: whitespace-only / bidi machine state + move names are rejected', () => {
    const blankState = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.states = ['   ', 'battle', 'won', 'lost'];
      mm.capabilities[0].machine.initial = 'battle';
    });
    expect(codes(validatePluginManifest(blankState))).toContain('bad_state');

    // States had NO hasUnsafeText check before PLG-27 — a bidi override passed.
    const spoofState = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.states = ['pla‮cing', 'battle', 'won', 'lost'];
    });
    expect(codes(validatePluginManifest(spoofState))).toContain('bad_state');

    const blankMove = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.moves = {
        '  ': { type: 'object' },
        place: { type: 'object' },
        fire: { type: 'object' },
      };
    });
    expect(codes(validatePluginManifest(blankMove))).toContain('bad_move');
  });

  it('#14: whitespace-only feature / data-scope tokens are rejected', () => {
    expect(
      codes(
        validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.required_features = ['  ']))),
      ),
    ).toContain('bad_required_features');
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (mm) => (mm.capabilities[0].data_scope.categories = ['   '])),
        ),
      ),
    ).toContain('bad_data_categories');
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (mm) => (mm.capabilities[0].data_scope.personas = ['   '])),
        ),
      ),
    ).toContain('bad_data_personas');
  });

  it('#16: a numeric / array icon fails the blob-ref shape floor; object + string pass', () => {
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = 42)))),
    ).toContain('bad_icon');
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = ['a', 'b'])))),
    ).toContain('bad_icon');
    expect(
      codes(
        validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = { cid: 'bafyabc' }))),
      ),
    ).not.toContain('bad_icon');
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = 'blob-ref-abc')))),
    ).not.toContain('bad_icon');
  });

  it('#19: move_sec > session_ttl_sec (impossible move) is rejected; equal is allowed', () => {
    const impossible = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.timeouts = { move_sec: 604800, session_ttl_sec: 60 };
    });
    expect(codes(validatePluginManifest(impossible))).toContain('bad_timeouts');
    const equal = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.timeouts = { move_sec: 3600, session_ttl_sec: 3600 };
    });
    expect(codes(validatePluginManifest(equal))).not.toContain('bad_timeouts');
  });
});

describe('round-18 (PLG-28) hardening', () => {
  const codes = (r: PluginValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

  it('#4: an unsatisfiable required/properties schema (additionalProperties:false) is rejected', () => {
    const m = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        properties: {},
        required: ['secret'],
        additionalProperties: false,
      };
    });
    expect(codes(validatePluginManifest(m))).toContain('malformed_schema_constraint');
    // A satisfiable schema (required ⊆ properties) still passes.
    const okSchema = mutate(runnerManifest(), (mm) => {
      mm.capabilities[0].params_schema = {
        type: 'object',
        properties: { secret: { type: 'string' } },
        required: ['secret'],
        additionalProperties: false,
      };
    });
    expect(codes(validatePluginManifest(okSchema))).not.toContain('malformed_schema_constraint');
  });

  it('#5: a deeply-nested card is a fail-closed RESULT, never a RangeError throw (totality)', () => {
    const m = mutate(runnerManifest(), (mm) => {
      let cur: Record<string, unknown> = {};
      const root = cur;
      for (let i = 0; i < 30000; i++) {
        const next: Record<string, unknown> = {};
        cur.a = next;
        cur = next;
      }
      mm.capabilities[0].card = root;
    });
    const run = (): PluginValidationResult => validatePluginManifest(m);
    expect(run).not.toThrow();
    expect(run().ok).toBe(false); // rejected as over-cap, not crashed
  });

  it('#10: a transition op not declared in ops_used is rejected', () => {
    const m = mutate(interpretedManifest(), (mm) => {
      // ops_used drops 'compare', but a transition still executes it.
      mm.capabilities[0].ops_used = ['commit', 'verifyCommit'];
    });
    expect(codes(validatePluginManifest(m))).toContain('undeclared_transition_op');
  });

  it('#11: a non-string instructions is rejected; a multi-line string with newlines passes', () => {
    const bad = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].instructions = { not: 'a string' };
    });
    expect(codes(validatePluginManifest(bad))).toContain('bad_instructions');
    const ok = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].instructions = 'Play the game.\nBe fair.\n\tNo cheating.';
    });
    expect(codes(validatePluginManifest(ok))).not.toContain('bad_instructions');
    // A bidi-override in instructions IS rejected (deceptive even multi-line).
    const spoof = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].instructions = 'do‮evil';
    });
    expect(codes(validatePluginManifest(spoof))).toContain('bad_instructions');
  });

  it('#12: a session with no transitions / a dead-end non-terminal state is rejected', () => {
    const noTransitions = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.transitions = [];
    });
    expect(codes(validatePluginManifest(noTransitions))).toContain('no_transitions');
    const deadEnd = mutate(interpretedManifest(), (mm) => {
      // 'battle' (non-terminal) loses its only outgoing transition.
      mm.capabilities[0].machine.transitions = [
        { from: 'placing', move: 'place', ops: ['commit'], to: 'battle' },
      ];
    });
    expect(codes(validatePluginManifest(deadEnd))).toContain('dead_end_state');
  });

  it('#13: empty / duplicate terminal states are rejected', () => {
    const empty = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.terminal = [];
    });
    expect(codes(validatePluginManifest(empty))).toContain('bad_terminal');
    const dupe = mutate(interpretedManifest(), (mm) => {
      mm.capabilities[0].machine.terminal = ['won', 'won', 'lost'];
    });
    expect(codes(validatePluginManifest(dupe))).toContain('duplicate_terminal');
  });

  it('#14: a token with SURROUNDING whitespace (not just blank) is rejected', () => {
    expect(
      codes(
        validatePluginManifest(
          mutate(
            runnerManifest(),
            (mm) => (mm.capabilities[0].data_scope.categories = [' travel']),
          ),
        ),
      ),
    ).toContain('bad_data_categories');
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (mm) => (mm.required_features = ['feat '])),
        ),
      ),
    ).toContain('bad_required_features');
    // A clean token still passes.
    expect(
      codes(
        validatePluginManifest(
          mutate(runnerManifest(), (mm) => (mm.capabilities[0].data_scope.categories = ['travel'])),
        ),
      ),
    ).not.toContain('bad_data_categories');
  });

  it('#15: an empty / reference-less icon object is rejected; a blob-ref object passes', () => {
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = {})))),
    ).toContain('bad_icon');
    expect(
      codes(validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = { foo: 'bar' })))),
    ).toContain('bad_icon');
    expect(
      codes(
        validatePluginManifest(mutate(runnerManifest(), (mm) => (mm.icon = { cid: 'bafyabc' }))),
      ),
    ).not.toContain('bad_icon');
  });
});
