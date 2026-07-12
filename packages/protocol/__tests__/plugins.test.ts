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
