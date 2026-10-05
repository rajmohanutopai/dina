/**
 * The request and response forms of a UCP schema (plan §3.6 step 4a,
 * "the `ucp_request` / `ucp_response` annotations resolved per operation").
 *
 * A schema's `required` list states what a RESPONSE carries. A property's
 * `ucp_request` overrides that for requests, either for every request
 * operation (`"omit"`) or per operation (`{"create": "omit", "update":
 * "required"}`); its `ucp_response` overrides it for responses. The values are
 * `required`, `optional` and `omit`; an unannotated property inherits the
 * response requirement (the spec's own reading, in its docs build:
 * `main.py`, `_field_requirement`). A `{"transition": {from, to}}` value marks
 * a requirement mid-change and is read as `optional`, which both sides of the
 * change satisfy.
 *
 * `omit` becomes the `false` schema for that property: Dina never sends a
 * response-only member, and refuses a response carrying a member the spec
 * says responses omit (a credential echoed back, say).
 */

import { isPlainObject } from '@dina/a2a';

export type SchemaDirection = 'request' | 'response';
export type RequestOperation = 'create' | 'update' | 'complete';
type Requirement = 'required' | 'optional' | 'omit';

type Obj = Record<string, unknown>;

/** Keywords whose value is one schema, an array of schemas, or a map of schemas (2020-12). */
const ONE = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'items',
  'additionalItems',
  'unevaluatedItems',
]);
const MANY = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']);
const MAP = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/**
 * Every subschema of a schema, the schema itself first, depth first, following
 * only schema keywords: data under `const`, `enum`, `default` or `examples`,
 * and a property merely NAMED `$id`, are never taken for schemas.
 */
export function* subschemas(schema: Obj): Generator<Obj> {
  yield schema;
  for (const [key, value] of Object.entries(schema)) {
    if (ONE.has(key) && isPlainObject(value)) yield* subschemas(value);
    if (MANY.has(key) && Array.isArray(value)) {
      for (const item of value) if (isPlainObject(item)) yield* subschemas(item);
    }
    if (MAP.has(key) && isPlainObject(value)) {
      for (const item of Object.values(value)) if (isPlainObject(item)) yield* subschemas(item);
    }
  }
}

/** A deep copy of a JSON value. */
export function copyJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyJson) as T;
  if (isPlainObject(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = copyJson(v);
    return out as T;
  }
  return value;
}

function requirementOf(
  annotation: unknown,
  direction: SchemaDirection,
  op: RequestOperation | undefined,
): Requirement | undefined {
  const value =
    typeof annotation === 'string'
      ? annotation
      : direction === 'request' && op !== undefined && isPlainObject(annotation)
        ? annotation[op]
        : undefined;
  if (value === 'required' || value === 'optional' || value === 'omit') return value;
  if (isPlainObject(value) && isPlainObject(value.transition)) return 'optional';
  return undefined;
}

/**
 * The requirement annotations a schema node states for its members: those on
 * its own `properties`, and on the `properties` of its inline `allOf`
 * branches (a `required` list often sits beside an `allOf` whose branch
 * defines the member, as `daily_hour.json` does). A `$ref` branch is not
 * followed: its own `required` lists are adjusted where they stand.
 */
function annotationsOf(
  node: Obj,
  key: 'ucp_request' | 'ucp_response',
  direction: SchemaDirection,
  op: RequestOperation | undefined,
  out = new Map<string, Requirement>(),
  depth = 0,
): Map<string, Requirement> {
  if (depth > 16) return out;
  if (isPlainObject(node.properties)) {
    for (const [name, prop] of Object.entries(node.properties)) {
      if (!isPlainObject(prop) || !(key in prop)) continue;
      const req = requirementOf(prop[key], direction, op);
      if (req !== undefined && !out.has(name)) out.set(name, req);
    }
  }
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf) {
      if (isPlainObject(branch)) annotationsOf(branch, key, direction, op, out, depth + 1);
    }
  }
  return out;
}

/**
 * A copy of `schema` in the form one direction (and, for requests, one
 * operation) sees. The annotations themselves are kept: a validator ignores
 * keywords it does not know.
 */
export function schemaVariant<T>(schema: T, direction: SchemaDirection, op?: RequestOperation): T {
  const out = copyJson(schema);
  if (!isPlainObject(out)) return out;
  const key = direction === 'request' ? 'ucp_request' : 'ucp_response';
  // Decide every node from the original annotations first, then change them,
  // so a member replaced by `false` cannot hide its annotation from a parent.
  const changes: { node: Obj; required: string[] | null; omit: string[] }[] = [];
  for (const node of subschemas(out)) {
    const stated = annotationsOf(node, key, direction, op);
    if (stated.size === 0) continue;
    const required = Array.isArray(node.required)
      ? node.required.filter((r): r is string => typeof r === 'string')
      : [];
    const next = new Set(required);
    for (const [name, req] of stated) {
      if (req === 'required') {
        // Only where the member is defined: a parent does not gain a member its branch requires.
        if (isPlainObject(node.properties) && name in node.properties) next.add(name);
      } else next.delete(name);
    }
    const own = isPlainObject(node.properties) ? node.properties : {};
    const omit = [...stated]
      .filter(([name, req]) => req === 'omit' && name in own)
      .map(([name]) => name);
    const ordered = [
      ...required.filter((r) => next.has(r)),
      ...[...next].filter((r) => !required.includes(r)),
    ];
    const same = ordered.length === required.length && ordered.every((r, i) => r === required[i]);
    changes.push({ node, required: same ? null : ordered, omit });
  }
  for (const { node, required, omit } of changes) {
    if (required !== null) {
      if (required.length > 0) node.required = required;
      else delete node.required;
    }
    for (const name of omit) (node.properties as Obj)[name] = false;
  }
  return out;
}
