/**
 * `pinnedSchemaProblems`: one audit, two keyword sets. The plugin manifest
 * profile is the wire contract and stays as it was; the pinned-runtime
 * profile is exactly what Core's validator enforces (A2A uses it).
 */

import { pinnedSchemaProblems } from '../../src';

const paths = (schema: unknown, profile: 'plugin_manifest' | 'pinned_runtime'): string[] =>
  pinnedSchemaProblems(schema, profile).map((p) => p.path);

describe('pinnedSchemaProblems', () => {
  const fullRuntime = {
    type: 'object',
    required: ['code'],
    additionalProperties: false,
    properties: {
      code: { type: 'string', pattern: '^[A-Z]{2}$', minLength: 2, maxLength: 2 },
      kind: { oneOf: [{ const: 'a' }, { const: 'b' }] },
      score: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    },
  };

  it('accepts the full runtime keyword set under pinned_runtime', () => {
    expect(paths(fullRuntime, 'pinned_runtime')).toEqual([]);
  });

  it('keeps the plugin manifest contract: const, oneOf, pattern, exclusive bounds stay unenforceable', () => {
    expect(paths(fullRuntime, 'plugin_manifest').sort()).toEqual(
      [
        'properties.code.pattern',
        'properties.kind.oneOf',
        'properties.score.exclusiveMaximum',
        'properties.score.exclusiveMinimum',
      ].sort(),
    );
  });

  it.each([
    [{ type: 'string', format: 'email' }, 'format'],
    [{ type: 'number', multipleOf: 2 }, 'multipleOf'],
    [{ type: 'array', uniqueItems: true }, 'uniqueItems'],
    [{ anyOf: [{ type: 'string' }] }, 'anyOf'],
    [{ $ref: '#/x' }, '$ref'],
    [{ type: 'object', properties: { a: false } }, 'properties.a'],
    [{ oneOf: [{ type: 'string', not: {} }] }, 'oneOf[0].not'],
  ])('flags what neither profile enforces (%p)', (schema, path) => {
    expect(paths(schema, 'pinned_runtime')).toEqual([path]);
  });

  it.each([
    [{ type: 'string', pattern: '(' }, 'pattern'],
    [{ type: 'string', pattern: 'x'.repeat(513) }, 'pattern'],
    [{ type: 'number', exclusiveMinimum: true }, 'exclusiveMinimum'],
    [{ oneOf: [] }, 'oneOf'],
    [{ oneOf: 'x' }, 'oneOf'],
  ])('flags a malformed runtime keyword value (%p)', (schema, path) => {
    const problems = pinnedSchemaProblems(schema, 'pinned_runtime');
    expect(problems.map((p) => [p.kind, p.path])).toEqual([['malformed', path]]);
  });

  it('refuses a schema nested past the depth cap', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { x: deep } };
    expect(paths(deep, 'pinned_runtime')).toEqual(['(schema)']);
  });
});
