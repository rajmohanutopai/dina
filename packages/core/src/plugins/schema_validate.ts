/**
 * Minimal JSON Schema validator for pinned plugin schemas
 * (PLUGIN_ARCHITECTURE.md §9.1: "result validated against the PINNED
 * result schema; nonconforming = task failure").
 *
 * Deliberately small — the manifest validator (§5 rule 4) already
 * bans `$ref` and caps depth, so the schema subset a plugin can pin is
 * a bounded, non-recursive shape. We validate exactly that subset:
 * type, properties, required, items, enum, and the numeric/string
 * bounds. Anything a schema DECLARES that this validator doesn't
 * understand is ignored (it can only make validation stricter upstream,
 * never a bypass), but an unknown top-level `type` fails closed — a
 * result we cannot check is a result we do not accept.
 *
 * Pure. No ajv, no codegen — the point is a small auditable surface at
 * the trust boundary, not full JSON-Schema coverage.
 */

export interface SchemaValidationResult {
  ok: boolean;
  /** First failure path (dotted), for the failure event detail. */
  error?: string;
}

const KNOWN_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

export function validateAgainstSchema(value: unknown, schema: unknown): SchemaValidationResult {
  return walk(value, schema, '$');
}

function walk(value: unknown, schema: unknown, path: string): SchemaValidationResult {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    // A non-object schema constrains nothing — accept. (The manifest
    // validator already rejects malformed schemas at ingest.)
    return { ok: true };
  }
  const s = schema as Record<string, unknown>;

  // enum — exact membership by structural equality.
  if (Array.isArray(s.enum)) {
    const found = s.enum.some((e) => deepEqual(e, value));
    if (!found) return fail(path, 'not in enum');
  }

  const type = s.type;
  if (typeof type === 'string') {
    if (!KNOWN_TYPES.has(type)) return fail(path, `unknown schema type "${type}"`);
    const typeOk = matchesType(value, type);
    if (!typeOk) return fail(path, `expected ${type}`);
  } else if (Array.isArray(type)) {
    // Union of types — at least one must match (unknowns fail closed).
    if (type.some((t) => typeof t !== 'string' || !KNOWN_TYPES.has(t))) {
      return fail(path, 'unknown schema type in union');
    }
    if (!type.some((t) => matchesType(value, t as string))) {
      return fail(path, `expected one of ${type.join('|')}`);
    }
  }

  // object: properties + required + additionalProperties=false handling.
  //
  // SECURITY: every membership test uses hasOwnProperty, NEVER the `in`
  // operator. `in` walks the prototype chain, so `'toString' in props`
  // (or `constructor`, `valueOf`, `hasOwnProperty`, …) is ALWAYS true —
  // which would let a result smuggle `{"toString":"http://evil"}` past
  // an `additionalProperties:false` pin. JSON.parse produces own
  // enumerable keys for exactly those names, so the bypass is real.
  const owns = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  if (matchesType(value, 'object') && value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const req of asStringArray(s.required)) {
      if (!owns(obj, req)) return fail(`${path}.${req}`, 'missing required property');
    }
    for (const key of Object.keys(props)) {
      if (owns(obj, key)) {
        const r = walk(obj[key], props[key], `${path}.${key}`);
        if (!r.ok) return r;
      }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!owns(props, key)) return fail(`${path}.${key}`, 'additional property not allowed');
      }
    }
  }

  // array: items + length bounds.
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      return fail(path, `fewer than ${s.minItems} items`);
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      return fail(path, `more than ${s.maxItems} items`);
    }
    if (s.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const r = walk(value[i], s.items, `${path}[${i}]`);
        if (!r.ok) return r;
      }
    }
  }

  // string bounds.
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      return fail(path, `shorter than ${s.minLength}`);
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      return fail(path, `longer than ${s.maxLength}`);
    }
  }

  // number bounds.
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return fail(path, `< ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum) return fail(path, `> ${s.maximum}`);
  }

  return { ok: true };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}

function fail(path: string, msg: string): SchemaValidationResult {
  return { ok: false, error: `${path}: ${msg}` };
}
