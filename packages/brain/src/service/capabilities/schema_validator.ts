/**
 * Minimal JSON Schema validator (draft-07 subset) used to check inbound
 * `service.query` params against the provider's PUBLISHED schema.
 *
 * Why a hand-rolled validator and not ajv? The Dina provider surface
 * publishes tightly-scoped schemas (capability params). ajv's full draft
 * machinery would add ~60 KB to the RN bundle for shapes we fully
 * control. This validator covers the keywords the reference uses:
 *
 *   type          object | string | number | integer | boolean | array | null
 *   required      string[] — keys that must be present (not `undefined`)
 *   properties    per-property recursion
 *   additionalProperties   boolean — when `false`, extra keys are rejected
 *   enum          list of allowed primitive values
 *   minimum / maximum                 numeric bounds
 *   exclusiveMinimum / exclusiveMaximum  numeric bounds (boolean OR number)
 *   minLength / maxLength             string bounds
 *   pattern                           regex (ECMAScript)
 *   items                             array element schema (single)
 *   minItems / maxItems               array bounds
 *   const                             exact-value match
 *
 * Returns `null` when `value` satisfies `schema`, or a human-readable
 * error string explaining the first violation. Error messages match the
 * Python reference where practical — the requester sees them in the
 * error `service.response` payload.
 *
 * Source: brain/src/service/service_handler.py::_validate_params
 *         (uses `jsonschema.Draft7Validator` in main-dina).
 */

/**
 * Returns `null` when `value` matches `schema`, or a one-line error.
 * `path` is the dotted slot for nested errors (`params.patient_id`).
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  path = 'params',
): string | null {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    // Schema not a plain object → nothing to enforce.
    return null;
  }
  const s = schema as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(s, 'const')) {
    if (value !== s.const) return `${path}: must equal ${JSON.stringify(s.const)}`;
  }
  if (Array.isArray(s.enum)) {
    if (!s.enum.some((allowed) => deepEqual(allowed, value))) {
      return `${path}: must be one of ${JSON.stringify(s.enum)}`;
    }
  }

  const type = s.type;
  if (typeof type === 'string') {
    const typeErr = checkType(value, type, path);
    if (typeErr !== null) return typeErr;
  } else if (Array.isArray(type)) {
    const matched = type.some((t) => typeof t === 'string' && checkType(value, t, path) === null);
    if (!matched) return `${path}: must be one of types ${JSON.stringify(type)}`;
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      return `${path}: must be ≥ ${s.minimum}`;
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      return `${path}: must be ≤ ${s.maximum}`;
    }
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) {
      return `${path}: must be > ${s.exclusiveMinimum}`;
    }
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) {
      return `${path}: must be < ${s.exclusiveMaximum}`;
    }
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      return `${path}: must have length ≥ ${s.minLength}`;
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      return `${path}: must have length ≤ ${s.maxLength}`;
    }
    if (typeof s.pattern === 'string') {
      let re: RegExp;
      try {
        re = new RegExp(s.pattern);
      } catch {
        return `${path}: invalid pattern in schema`;
      }
      if (!re.test(value)) return `${path}: must match pattern ${s.pattern}`;
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      return `${path}: must have ≥ ${s.minItems} items`;
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      return `${path}: must have ≤ ${s.maxItems} items`;
    }
    if (
      s.items !== undefined &&
      typeof s.items === 'object' &&
      s.items !== null &&
      !Array.isArray(s.items)
    ) {
      for (let i = 0; i < value.length; i++) {
        const err = validateAgainstSchema(value[i], s.items, `${path}[${i}]`);
        if (err !== null) return err;
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props =
      typeof s.properties === 'object' && s.properties !== null && !Array.isArray(s.properties)
        ? (s.properties as Record<string, unknown>)
        : undefined;

    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key !== 'string') continue;
        if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined) {
          return `${path}.${key}: required`;
        }
      }
    }

    // additionalProperties: false → reject keys not listed in `properties`.
    if (s.additionalProperties === false && props !== undefined) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          return `${path}.${key}: additional property not allowed`;
        }
      }
    }

    if (props !== undefined) {
      for (const [key, subSchema] of Object.entries(props)) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        const err = validateAgainstSchema(obj[key], subSchema, `${path}.${key}`);
        if (err !== null) return err;
      }
    }
  }

  return null;
}

function checkType(value: unknown, type: string, path: string): string | null {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? null : `${path}: must be a string`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `${path}: must be an integer`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${path}: must be a finite number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: must be a boolean`;
    case 'null':
      return value === null ? null : `${path}: must be null`;
    case 'array':
      return Array.isArray(value) ? null : `${path}: must be an array`;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? null
        : `${path}: must be a JSON object`;
    default:
      return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}
