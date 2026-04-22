/**
 * Task 6.5 — Lexicon validation per Dina collection.
 *
 * AT Protocol records (`com.dina.service.profile`,
 * `com.dina.contact.card`, `com.dina.trust.attestation`, …) must
 * conform to per-collection Lexicon schemas before publishing OR
 * accepting from the firehose. This primitive is the structural
 * validator — give it a collection name + record + its registered
 * schema, get back `{ok: true}` or `{ok: false, errors[]}`.
 *
 * **Why a new primitive instead of a JSON Schema library?** Three
 * reasons:
 *
 *   1. **Zero dependencies**. The Home Node Lite package budget
 *      doesn't want `ajv` (~150KB + transitive deps) for the subset
 *      of JSON Schema the Dina lexicons use.
 *   2. **Collection-routing built in**. `validate(collection, record)`
 *      picks the registered schema by AT-Proto `$type` OR explicit
 *      collection argument. Callers don't duplicate the lookup
 *      logic at every call-site.
 *   3. **Structured error paths** with JSON-pointer-style locations
 *      so the `service.profile` publish + firehose ingest flows
 *      both surface the exact offending field.
 *
 * **Supported JSON Schema subset** (sufficient for current Dina
 * lexicons):
 *
 *   - Types: `string` / `number` / `integer` / `boolean` /
 *     `object` / `array` / `null`.
 *   - Object: `properties`, `required`, `additionalProperties`
 *     (bool).
 *   - Array: `items` (single schema), `minItems`, `maxItems`.
 *   - String: `minLength`, `maxLength`, `enum`, `pattern` (regex).
 *   - Number / integer: `minimum`, `maximum`.
 *   - Global: `const`, `enum`.
 *
 * **Out of scope**: `$ref`, `oneOf`, `allOf`, `anyOf`, `format`,
 * `if/then/else`, `patternProperties`, `dependencies`. Dina
 * lexicons don't use these today; adding support is straightforward
 * when a new lexicon needs them.
 *
 * **Path-aware errors**: every validation failure carries a
 * JSON-pointer-like path (`/capabilitySchemas/eta_query/params`)
 * so the caller can highlight the exact field.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6b task 6.5.
 */

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/** Supported JSON Schema subset — see module header. */
export interface LexiconSchema {
  type?: JsonSchemaType | readonly JsonSchemaType[];
  properties?: Record<string, LexiconSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: LexiconSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: readonly unknown[];
  const?: unknown;
  description?: string;
}

export interface ValidationError {
  /** JSON-pointer path to the offending value (`""` = root). */
  path: string;
  message: string;
  /** Compact machine-readable kind — `type_mismatch`, `required_missing`, etc. */
  kind: ValidationErrorKind;
}

export type ValidationErrorKind =
  | 'type_mismatch'
  | 'required_missing'
  | 'additional_property_not_allowed'
  | 'min_length_violation'
  | 'max_length_violation'
  | 'min_items_violation'
  | 'max_items_violation'
  | 'minimum_violation'
  | 'maximum_violation'
  | 'pattern_mismatch'
  | 'enum_mismatch'
  | 'const_mismatch'
  | 'invalid_number'
  | 'unknown_collection';

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

export interface ValidatorOptions {
  /** Max errors reported before short-circuiting. Defaults to 10. */
  maxErrors?: number;
}

export const DEFAULT_MAX_ERRORS = 10;

/**
 * Registry of per-collection Lexicon schemas + the validator
 * function. Immutable after construction — the set of collections
 * is known at boot (service startup loads the Dina lexicon bundle).
 */
export class LexiconValidator {
  private readonly schemas: ReadonlyMap<string, LexiconSchema>;
  private readonly maxErrors: number;

  constructor(
    schemas: Record<string, LexiconSchema>,
    opts: ValidatorOptions = {},
  ) {
    if (!schemas || typeof schemas !== 'object') {
      throw new TypeError('LexiconValidator: schemas must be an object');
    }
    const map = new Map<string, LexiconSchema>();
    for (const [collection, schema] of Object.entries(schemas)) {
      if (typeof collection !== 'string' || collection === '') {
        throw new TypeError(
          'LexiconValidator: collection names must be non-empty strings',
        );
      }
      if (!schema || typeof schema !== 'object') {
        throw new TypeError(
          `LexiconValidator: schema for "${collection}" must be an object`,
        );
      }
      map.set(collection, schema);
    }
    this.schemas = map;
    this.maxErrors = opts.maxErrors ?? DEFAULT_MAX_ERRORS;
  }

  /** True when a schema is registered for `collection`. */
  has(collection: string): boolean {
    return this.schemas.has(collection);
  }

  /** List registered collection names (sorted, stable output). */
  collections(): string[] {
    return Array.from(this.schemas.keys()).sort();
  }

  /**
   * Validate `record` against the schema for `collection`. When
   * `collection` is omitted, the validator reads it from
   * `record.$type`. Returns a structured result with paths.
   */
  validate(record: unknown, collection?: string): ValidationResult {
    const rec = record as { $type?: unknown } | null;
    const col =
      collection ??
      (rec !== null && typeof rec === 'object' && typeof rec.$type === 'string'
        ? rec.$type
        : undefined);
    if (col === undefined) {
      return {
        ok: false,
        errors: [
          {
            path: '',
            kind: 'unknown_collection',
            message:
              'no collection provided and record has no $type field',
          },
        ],
      };
    }
    const schema = this.schemas.get(col);
    if (!schema) {
      return {
        ok: false,
        errors: [
          {
            path: '',
            kind: 'unknown_collection',
            message: `no schema registered for collection "${col}"`,
          },
        ],
      };
    }
    const errors: ValidationError[] = [];
    validateValue(record, schema, '', errors, this.maxErrors);
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateValue(
  value: unknown,
  schema: LexiconSchema,
  path: string,
  errors: ValidationError[],
  maxErrors: number,
): void {
  if (errors.length >= maxErrors) return;

  // const check — strict equality via JSON canonical form.
  if ('const' in schema) {
    if (!deepEquals(value, schema.const)) {
      pushError(errors, maxErrors, {
        path,
        kind: 'const_mismatch',
        message: `expected const ${JSON.stringify(schema.const)}`,
      });
      return;
    }
  }

  // enum check — membership via canonical form.
  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => deepEquals(e, value))) {
      pushError(errors, maxErrors, {
        path,
        kind: 'enum_mismatch',
        message: `value not in enum ${JSON.stringify(schema.enum)}`,
      });
      return;
    }
  }

  // Type check.
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      pushError(errors, maxErrors, {
        path,
        kind: 'type_mismatch',
        message: `expected type ${types.join(' | ')}, got ${actualType(value)}`,
      });
      return; // later checks won't make sense on a type mismatch
    }
  }

  // Per-type constraints.
  if (typeof value === 'string') validateString(value, schema, path, errors, maxErrors);
  else if (typeof value === 'number') validateNumber(value, schema, path, errors, maxErrors);
  else if (Array.isArray(value)) validateArray(value, schema, path, errors, maxErrors);
  else if (value !== null && typeof value === 'object') {
    validateObject(value as Record<string, unknown>, schema, path, errors, maxErrors);
  }
}

function validateString(
  v: string,
  s: LexiconSchema,
  path: string,
  errors: ValidationError[],
  maxErrors: number,
): void {
  if (s.minLength !== undefined && v.length < s.minLength) {
    pushError(errors, maxErrors, {
      path,
      kind: 'min_length_violation',
      message: `string length ${v.length} below minimum ${s.minLength}`,
    });
  }
  if (s.maxLength !== undefined && v.length > s.maxLength) {
    pushError(errors, maxErrors, {
      path,
      kind: 'max_length_violation',
      message: `string length ${v.length} exceeds maximum ${s.maxLength}`,
    });
  }
  if (s.pattern !== undefined) {
    try {
      if (!new RegExp(s.pattern).test(v)) {
        pushError(errors, maxErrors, {
          path,
          kind: 'pattern_mismatch',
          message: `value does not match pattern /${s.pattern}/`,
        });
      }
    } catch {
      // Malformed pattern in the schema itself — skip rather than crash
      // validation. Lexicon authors should catch this at build time.
    }
  }
}

function validateNumber(
  v: number,
  s: LexiconSchema,
  path: string,
  errors: ValidationError[],
  maxErrors: number,
): void {
  if (!Number.isFinite(v)) {
    pushError(errors, maxErrors, {
      path,
      kind: 'invalid_number',
      message: 'value must be a finite number',
    });
    return;
  }
  const isInt = Array.isArray(s.type)
    ? s.type.includes('integer')
    : s.type === 'integer';
  if (isInt && !Number.isInteger(v)) {
    pushError(errors, maxErrors, {
      path,
      kind: 'type_mismatch',
      message: `expected integer, got float ${v}`,
    });
  }
  if (s.minimum !== undefined && v < s.minimum) {
    pushError(errors, maxErrors, {
      path,
      kind: 'minimum_violation',
      message: `value ${v} below minimum ${s.minimum}`,
    });
  }
  if (s.maximum !== undefined && v > s.maximum) {
    pushError(errors, maxErrors, {
      path,
      kind: 'maximum_violation',
      message: `value ${v} exceeds maximum ${s.maximum}`,
    });
  }
}

function validateArray(
  v: unknown[],
  s: LexiconSchema,
  path: string,
  errors: ValidationError[],
  maxErrors: number,
): void {
  if (s.minItems !== undefined && v.length < s.minItems) {
    pushError(errors, maxErrors, {
      path,
      kind: 'min_items_violation',
      message: `array length ${v.length} below minimum ${s.minItems}`,
    });
  }
  if (s.maxItems !== undefined && v.length > s.maxItems) {
    pushError(errors, maxErrors, {
      path,
      kind: 'max_items_violation',
      message: `array length ${v.length} exceeds maximum ${s.maxItems}`,
    });
  }
  if (s.items !== undefined) {
    for (let i = 0; i < v.length; i++) {
      if (errors.length >= maxErrors) return;
      validateValue(v[i], s.items, `${path}/${i}`, errors, maxErrors);
    }
  }
}

function validateObject(
  v: Record<string, unknown>,
  s: LexiconSchema,
  path: string,
  errors: ValidationError[],
  maxErrors: number,
): void {
  if (s.required !== undefined) {
    for (const key of s.required) {
      if (errors.length >= maxErrors) return;
      if (!(key in v)) {
        pushError(errors, maxErrors, {
          path: `${path}/${escapePointer(key)}`,
          kind: 'required_missing',
          message: `required property "${key}" is missing`,
        });
      }
    }
  }
  const props = s.properties ?? {};
  for (const [key, val] of Object.entries(v)) {
    if (errors.length >= maxErrors) return;
    const subSchema = props[key];
    if (subSchema) {
      validateValue(
        val,
        subSchema,
        `${path}/${escapePointer(key)}`,
        errors,
        maxErrors,
      );
    } else if (s.additionalProperties === false) {
      pushError(errors, maxErrors, {
        path: `${path}/${escapePointer(key)}`,
        kind: 'additional_property_not_allowed',
        message: `additional property "${key}" is not allowed`,
      });
    }
    // If additionalProperties is true OR undefined, unknown keys pass through.
  }
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return (
        typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return (
        value !== null && typeof value === 'object' && !Array.isArray(value)
      );
  }
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], bb[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const akeys = Object.keys(ao);
  const bkeys = Object.keys(bo);
  if (akeys.length !== bkeys.length) return false;
  for (const k of akeys) {
    if (!deepEquals(ao[k], bo[k])) return false;
  }
  return true;
}

/** Escape a property name for JSON pointer embedding. */
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pushError(
  errors: ValidationError[],
  maxErrors: number,
  err: ValidationError,
): void {
  if (errors.length >= maxErrors) return;
  errors.push(err);
}
