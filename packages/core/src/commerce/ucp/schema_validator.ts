/**
 * The interpreting JSON Schema validator for UCP (plan §3.6 "Validation",
 * A16, A18). Every request Dina sends is validated against the merchant's
 * composed schema before it leaves, and every answer after it arrives.
 *
 * The phone runs Core on Hermes, which generates no code at run time, so the
 * validator interprets schemas (`@cfworker/json-schema`, draft 2020-12) rather
 * than compiling them. It is a dependency of this module only.
 *
 * A schema set is built from documents keyed by the URL each was FETCHED from:
 *  - each document's `$id` is replaced by that URL, so every relative `$ref`
 *    resolves against where the document came from, never against what it
 *    claims to be (§3.6 step 4a "References");
 *  - a nested `$id` or `id` (which would re-base part of a document) is
 *    refused, as are `$recursiveRef` / `$dynamicRef` and their anchors (no UCP
 *    schema uses them);
 *  - every `$ref` must land on a document in the set and, when it has a
 *    fragment, on a node that exists there, so validation never meets a
 *    reference it cannot follow;
 *  - in a document not served by the UCP release (a merchant's own extension
 *    schema), `pattern` and `patternProperties` are removed, with the
 *    `additionalProperties` / `unevaluatedProperties` beside a removed
 *    `patternProperties`. A merchant's regular expression never runs on the
 *    phone, where a catastrophic one would stall the only JavaScript thread;
 *    without them the schema only accepts more, and UCP schemas are open
 *    anyway. Dina's typed readers still check every field it acts on;
 *  - a set whose evaluation could expand past `MAX_EVALUATION_NODES` (nested
 *    `allOf` references can double at every level) is refused;
 *  - a set for ANSWERS drops `uniqueItems`: the validator checks it by
 *    comparing every pair of items, and a merchant decides how long its arrays
 *    are. Uniqueness is nothing Dina acts on.
 *
 * Every check walks every object in a document (only the data keywords
 * `const`, `enum`, `default` and `examples` are skipped), because the
 * validator itself registers ids and references under unknown keywords too.
 *
 * Errors keep the keyword and the two locations, never the value that failed.
 * The locations are JSON pointers made of the answer's keys and the schema's
 * keys, which a merchant chooses: they are for the owner's merchant status,
 * never for a log.
 */

import { Validator, type OutputUnit, type Schema } from '@cfworker/json-schema';

import { copyJson } from '@dina/ucp';

export interface SchemaDocument {
  /** The https URL the document was fetched from. */
  url: string;
  /** The parsed document. */
  schema: unknown;
}

export interface ValidationError {
  keyword: string;
  keywordLocation: string;
  instanceLocation: string;
}

export type ValidationOutcome = { valid: true } | { valid: false; errors: ValidationError[] };

export type SchemaSetRefusal =
  | 'not_object'
  | 'nested_id'
  | 'unsupported_keyword'
  | 'duplicate_url'
  | 'unresolved_ref'
  | 'bad_ref'
  | 'too_costly';

export interface SchemaSetOptions {
  /** A set that validates answers: `uniqueItems` is dropped (see above). */
  forAnswers?: boolean;
}

/** How far one document's evaluation may expand, counting each reached node once per path. */
export const MAX_EVALUATION_NODES = 200_000;

export type SchemaSetResult =
  | { ok: true; set: SchemaSet }
  | { ok: false; reason: SchemaSetRefusal; url: string };

/** Documents whose patterns are kept: the UCP release's own schemas. */
export const isReleaseSchemaUrl = (url: string): boolean => url.startsWith('https://ucp.dev/');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keywords whose values are data, never schemas: not walked. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);
const UNSUPPORTED = ['$recursiveRef', '$recursiveAnchor', '$dynamicRef', '$dynamicAnchor'];

/** Every object in a schema document, depth first, outside the data keywords. */
function* everyNode(value: unknown): Generator<Obj> {
  if (Array.isArray(value)) {
    for (const item of value) yield* everyNode(item);
    return;
  }
  if (!isObj(value)) return;
  yield value;
  for (const [key, child] of Object.entries(value)) {
    if (!DATA_KEYWORDS.has(key)) yield* everyNode(child);
  }
}

/**
 * Every `$ref` string in a document, found the way the build check finds them
 * (every object outside the data keywords), so the resolver fetches exactly
 * what the set will need.
 */
export function referencesOf(doc: unknown): string[] {
  const out: string[] = [];
  for (const s of everyNode(doc)) if (typeof s.$ref === 'string') out.push(s.$ref);
  return out;
}

function withoutPatterns(schema: Obj): void {
  for (const s of everyNode(schema)) {
    if (typeof s.pattern === 'string') delete s.pattern;
    if (isObj(s.patternProperties)) {
      delete s.patternProperties;
      delete s.additionalProperties;
      delete s.unevaluatedProperties;
    }
  }
}

/** The JSON-pointer tokens of a normalised fragment (`/a~1b/%24c` → [`a/b`, `$c`]). */
function pointerTokens(fragment: string): string[] | null {
  if (fragment === '') return [];
  if (!fragment.startsWith('/')) return null;
  try {
    return fragment
      .slice(1)
      .split('/')
      .map((t) => decodeURIComponent(t).replace(/~1/g, '/').replace(/~0/g, '~'));
  } catch {
    return null;
  }
}

/** The node a pointer names in a document, or undefined. */
function atPointer(doc: unknown, tokens: readonly string[]): unknown {
  let node: unknown = doc;
  for (const t of tokens) {
    if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(t)) node = node[Number(t)];
    else if (isObj(node) && Object.prototype.hasOwnProperty.call(node, t)) node = node[t];
    else return undefined;
  }
  return node;
}

/** Whether a document defines a plain-name anchor (`$anchor`). */
function hasAnchor(doc: Obj, name: string): boolean {
  for (const s of everyNode(doc)) if (s.$anchor === name) return true;
  return false;
}

/**
 * A `$ref` with its JSON-pointer fragment in the one form the validator looks
 * up: percent-decoded (RFC 6901 §6: a pointer in a URI fragment is
 * percent-encoded, so `#/%24defs/x` is `#/$defs/x`), then each token, still
 * `~0`/`~1`-escaped, passed through `encodeURI` as the validator encodes the
 * keys it registers. Null when the fragment does not decode.
 */
function normalisedRef(ref: string): string | null {
  const hash = ref.indexOf('#');
  if (hash === -1) return ref;
  const fragment = ref.slice(hash + 1);
  if (!fragment.startsWith('/') && !fragment.startsWith('%2F') && !fragment.startsWith('%2f'))
    return ref;
  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment);
  } catch {
    return null;
  }
  return `${ref.slice(0, hash)}#${pointer
    .split('/')
    .map((token) => encodeURI(token))
    .join('/')}`;
}

export class SchemaSet {
  private readonly validators = new Map<string, Validator>();

  private constructor(private readonly docs: ReadonlyMap<string, Obj>) {}

  /** Build a set; refuses rather than validate against something it cannot follow, or afford. */
  static build(
    documents: readonly SchemaDocument[],
    options: SchemaSetOptions = {},
  ): SchemaSetResult {
    const docs = new Map<string, Obj>();
    for (const { url, schema } of documents) {
      if (!isObj(schema)) return { ok: false, reason: 'not_object', url };
      if (docs.has(url)) return { ok: false, reason: 'duplicate_url', url };
      const doc = copyJson(schema);
      for (const s of everyNode(doc)) {
        if (s !== doc && (typeof s.$id === 'string' || typeof s.id === 'string'))
          return { ok: false, reason: 'nested_id', url };
        if (UNSUPPORTED.some((k) => k in s))
          return { ok: false, reason: 'unsupported_keyword', url };
      }
      delete doc.id;
      doc.$id = url;
      if (!isReleaseSchemaUrl(url)) withoutPatterns(doc);
      if (options.forAnswers === true) for (const s of everyNode(doc)) delete s.uniqueItems;
      docs.set(url, doc);
    }
    // References: well formed, onto a document in the set, onto a node that exists.
    const targets = new Map<Obj, { doc: Obj; node: unknown }>();
    for (const [url, doc] of docs) {
      for (const s of everyNode(doc)) {
        if (!('$ref' in s)) continue;
        if (typeof s.$ref !== 'string') return { ok: false, reason: 'bad_ref', url };
        const ref = normalisedRef(s.$ref);
        if (ref === null) return { ok: false, reason: 'bad_ref', url };
        s.$ref = ref;
        let target: URL;
        try {
          target = new URL(ref, url);
        } catch {
          return { ok: false, reason: 'bad_ref', url };
        }
        const fragment = target.hash.startsWith('#') ? target.hash.slice(1) : '';
        target.hash = '';
        const into = docs.get(target.href);
        if (into === undefined) return { ok: false, reason: 'unresolved_ref', url };
        const tokens = pointerTokens(fragment);
        if (tokens === null) {
          // A plain-name fragment: an `$anchor` in the target document.
          if (!hasAnchor(into, decodeURIComponent(fragment)))
            return { ok: false, reason: 'unresolved_ref', url };
          continue;
        }
        const node = atPointer(into, tokens);
        if (node === undefined) return { ok: false, reason: 'unresolved_ref', url };
        targets.set(s, { doc: into, node });
      }
    }
    // Evaluation cost: each node's expansion, references followed, memoised; a node met
    // again on its own path (recursion) counts once, since the answer's depth bounds it.
    const memo = new Map<unknown, number>();
    const open = new Set<unknown>();
    const cost = (node: unknown): number => {
      if (!isObj(node) && !Array.isArray(node)) return 0;
      const known = memo.get(node);
      if (known !== undefined) return known;
      if (open.has(node)) return 1;
      open.add(node);
      let total = 1;
      if (Array.isArray(node)) for (const item of node) total += cost(item);
      else {
        for (const [key, child] of Object.entries(node))
          if (!DATA_KEYWORDS.has(key)) total += cost(child);
        const ref = targets.get(node);
        if (ref !== undefined) total += cost(ref.node);
      }
      open.delete(node);
      const capped = Math.min(total, MAX_EVALUATION_NODES + 1);
      memo.set(node, capped);
      return capped;
    };
    for (const [url, doc] of docs) {
      if (cost(doc) > MAX_EVALUATION_NODES) return { ok: false, reason: 'too_costly', url };
    }
    return { ok: true, set: new SchemaSet(docs) };
  }

  /** The URLs in the set. */
  get urls(): string[] {
    return [...this.docs.keys()];
  }

  /**
   * Validate an instance against a schema: a document's URL (with an optional
   * `#/json/pointer`), or a schema object whose `$ref`s are absolute URLs into
   * the set (a composition: `{ allOf: [{ $ref }, …] }`).
   */
  validate(schema: string | Obj, instance: unknown): ValidationOutcome {
    const key = typeof schema === 'string' ? schema : JSON.stringify(schema);
    let validator = this.validators.get(key);
    if (validator === undefined) {
      const root: Schema = (
        typeof schema === 'string' ? { $ref: schema } : copyJson(schema)
      ) as Schema;
      validator = new Validator(root, '2020-12', true);
      for (const [url, doc] of this.docs) validator.addSchema(doc as Schema, url);
      this.validators.set(key, validator);
    }
    let result: ReturnType<Validator['validate']>;
    try {
      result = validator.validate(instance);
    } catch {
      // A reference into a document that is not there (`#/$defs/missing`): the
      // schema cannot be followed, so nothing validates against it.
      return {
        valid: false,
        errors: [{ keyword: '$ref', keywordLocation: '', instanceLocation: '' }],
      };
    }
    if (result.valid) return { valid: true };
    return {
      valid: false,
      errors: result.errors.map((e: OutputUnit) => ({
        keyword: e.keyword,
        keywordLocation: e.keywordLocation,
        instanceLocation: e.instanceLocation,
      })),
    };
  }
}
