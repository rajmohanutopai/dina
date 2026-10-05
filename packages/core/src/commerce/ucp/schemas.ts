/**
 * Fetching and composing a merchant's schemas (UCP plan §3.6 step 4a, A18,
 * S21), for the negotiated set only, then validating every request before it
 * is sent and every answer after it arrives.
 *
 *  - Which URLs: each negotiated capability's `schema`, and every document its
 *    `$ref`s reach. A `dev.ucp.*` capability's documents all sit under the
 *    release path (`https://ucp.dev/2026-08-25/schemas/`). A merchant's own
 *    capability may reach the release's documents (its extension composes onto
 *    them) and otherwise only documents that pass authority binding for its
 *    name. Anything else drops the capability.
 *  - Identity: the root document's `name` equals the capability's name, so a
 *    merchant cannot point checkout at the order schema.
 *  - References resolve from the URL each document was fetched from (the
 *    validator's rule, `schema_validator.ts`).
 *  - Limits per merchant negotiation, on the MERCHANT's documents: 64
 *    documents, 2 MiB; and on every document: `$ref` depth 16, 256 KiB each.
 *    The release's own documents are a fixed set (116, about 560 KiB at
 *    v2026-08-25), the same for every merchant and cached across them, and
 *    Dina's own capabilities already reach 78 of them, so they are bounded
 *    apart (256 documents, 4 MiB) rather than counted against the merchant.
 *    A document reached twice is fetched once (a cycle ends there). Over a
 *    limit, the capability being fetched is dropped.
 *  - Versions: an extension's `requires` must hold for the chosen protocol
 *    version and capability versions, and it must define `$defs[<parent>]` for
 *    each parent it extends; otherwise it is dropped, and extensions left
 *    without a parent are pruned again.
 *  - Composing (overview :1206-1244): an operation on a resource is validated
 *    against `allOf` the resource schema and each active extension's
 *    `$defs[<resource capability>]`; a catalog operation against its own
 *    `$defs` entry. Requests and answers each see their form of the
 *    `ucp_request` / `ucp_response` annotations (`schemaVariant`).
 *
 * A capability that fails any step is dropped for this merchant with a reason
 * the owner's merchant status shows; an operation on it cannot be validated,
 * so it is never sent.
 */

import { UCP_FETCH_LIMITS, type PolicySocketRequest } from '@dina/net-policy';
import {
  checkAuthorityBinding,
  OPERATIONS,
  schemaVariant,
  UCP_BASE,
  UCP_VERSION,
  type NegotiatedCapability,
  type OperationName,
  type RequestOperation,
  type SchemaDirection,
} from '@dina/ucp';

import { DocumentCache } from './http_cache';
import { readJsonBytes } from './json_bytes';
import {
  referencesOf,
  SchemaSet,
  type SchemaDocument,
  type ValidationOutcome,
} from './schema_validator';

import type { UcpFetchResult } from './fetch';

export const SCHEMA_LIMITS = {
  /** The merchant's own documents, per negotiation. */
  maxDocuments: 64,
  maxBytes: 2 * 1024 * 1024,
  /** The release's documents, per negotiation (a fixed set; a ceiling, not a budget). */
  maxReleaseDocuments: 256,
  maxReleaseBytes: 4 * 1024 * 1024,
  maxDepth: 16,
  perDocumentBytes: UCP_FETCH_LIMITS.schema.maxResponseBytes,
} as const;

/** The negotiated release's schema path: every `dev.ucp.*` document lives under it. */
export const RELEASE_SCHEMAS = `${UCP_BASE}/schemas/`;

export type SchemaDropReason =
  | 'release_path'
  | 'authority'
  | 'fetch'
  | 'not_json'
  | 'identity'
  | 'limits'
  | 'requires'
  | 'missing_defs'
  | 'build'
  | 'parent_dropped';

export interface SchemaDrop {
  name: string;
  reason: SchemaDropReason;
}

export type OperationValidation =
  | ValidationOutcome
  /** The operation's capability is not active for this merchant: never send it. */
  | { valid: false; unavailable: true; errors: [] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON-pointer token for a capability name (`/` and `~` escaped). */
const pointerToken = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

export class MerchantSchemas {
  private readonly sets = new Map<string, SchemaSet>();

  constructor(
    readonly active: ReadonlyMap<string, NegotiatedCapability>,
    readonly dropped: readonly SchemaDrop[],
    private readonly documents: ReadonlyMap<string, Obj>,
    /** Capability name → the document URLs its schema reaches. */
    private readonly reach: ReadonlyMap<string, ReadonlySet<string>>,
  ) {}

  /** Whether the operation can be validated (and so sent) for this merchant. */
  available(operation: OperationName): boolean {
    return this.active.has(OPERATIONS[operation].capability);
  }

  validate(
    operation: OperationName,
    direction: SchemaDirection,
    instance: unknown,
  ): OperationValidation {
    const composed = this.composition(operation, direction);
    if (composed === null) return { valid: false, unavailable: true, errors: [] };
    const set = this.setFor([composed.root, ...composed.extensions], direction, composed.variant);
    if (set === null) return { valid: false, unavailable: true, errors: [] };
    return set.validate(composed.schema, instance);
  }

  /**
   * The schema an operation is checked against: its own part of its
   * capability's document, `allOf` every active extension's contribution to
   * that part: `$defs[<capability>]` followed by the same pointer (overview
   * :1206-1244; for a catalogue call the extension mirrors the base's own
   * `$defs`, as fulfillment.json does). An extension with nothing there does
   * not apply to the operation.
   */
  composition(
    operation: OperationName,
    direction: SchemaDirection,
    only?: readonly string[],
  ): {
    root: string;
    extensions: string[];
    variant: RequestOperation | undefined;
    schema: Obj;
  } | null {
    const spec = OPERATIONS[operation];
    const root = this.active.get(spec.capability);
    const part = direction === 'request' ? spec.schemas.request : spec.schemas.response;
    if (root === undefined || part === undefined) return null;
    const contributions = [...this.active.values()]
      .filter((c) => (c.entry.extends ?? []).includes(root.name))
      .filter((c) => only === undefined || only.includes(c.name))
      .map((c) => ({
        name: c.name,
        pointer: `/$defs/${pointerToken(root.name)}${part.pointer}`,
        url: c.entry.schema,
      }))
      .filter((c) => nodeAt(this.documents.get(c.url), c.pointer) !== undefined);
    const base = {
      $ref: part.pointer === '' ? root.entry.schema : `${root.entry.schema}#${part.pointer}`,
    };
    return {
      root: root.name,
      extensions: contributions.map((c) => c.name),
      variant: part.variant,
      schema:
        contributions.length === 0
          ? base
          : { allOf: [base, ...contributions.map((c) => ({ $ref: `${c.url}#${c.pointer}` }))] },
    };
  }

  /** Whether one capability's own documents build, in every form its operations use. */
  buildsAlone(name: string): boolean {
    const forms = new Set<string>(['response|']);
    for (const op of Object.values(OPERATIONS)) {
      if (op.capability === name && op.schemas.request !== undefined)
        forms.add(`request|${op.schemas.request.variant ?? ''}`);
    }
    // An extension serves its parents' requests too.
    if ((this.active.get(name)?.entry.extends ?? []).length > 0) {
      forms.add('request|create');
      forms.add('request|update');
    }
    return [...forms].every((f) => {
      const [direction, variant] = f.split('|') as [SchemaDirection, string];
      return (
        this.setFor(
          [name],
          direction,
          variant === '' ? undefined : (variant as RequestOperation),
        ) !== null
      );
    });
  }

  private setFor(
    names: readonly string[],
    direction: SchemaDirection,
    variant: RequestOperation | undefined,
  ): SchemaSet | null {
    const key = [...names, direction, variant ?? ''].join('|');
    const cached = this.sets.get(key);
    if (cached !== undefined) return cached;
    const urls = new Set<string>();
    for (const name of names) for (const u of this.reach.get(name) ?? []) urls.add(u);
    const docs: SchemaDocument[] = [...urls].map((url) => ({
      url,
      schema: schemaVariant(this.documents.get(url) as Obj, direction, variant),
    }));
    const built = SchemaSet.build(docs, { forAnswers: direction === 'response' });
    if (!built.ok) return null;
    this.sets.set(key, built.set);
    return built.set;
  }
}

/** The node a JSON pointer (of Dina's own composing: `~0`/`~1` escapes only) names, or undefined. */
function nodeAt(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  let node: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const t = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(node) || !Object.prototype.hasOwnProperty.call(node, t)) return undefined;
    node = node[t];
  }
  return node;
}

export interface SchemaResolverOptions {
  fetch?: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  now?: () => number;
}

export class SchemaResolver {
  private readonly cache: DocumentCache;

  constructor(options: SchemaResolverOptions = {}) {
    this.cache = new DocumentCache({
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      maxBytes: SCHEMA_LIMITS.perDocumentBytes,
      timeoutMs: UCP_FETCH_LIMITS.schema.timeoutMs,
      staleWhileRevalidate: false,
      maxEntries: 1024,
    });
  }

  /** Fetch, check and compose the negotiated capabilities' schemas for one merchant. */
  async resolve(negotiated: ReadonlyMap<string, NegotiatedCapability>): Promise<MerchantSchemas> {
    const documents = new Map<string, Obj>();
    const reach = new Map<string, Set<string>>();
    const dropped: SchemaDrop[] = [];
    const budget = { documents: 0, bytes: 0, releaseDocuments: 0, releaseBytes: 0 };
    const active = new Map(negotiated);

    // Bases first, so an extension's parent is known when its turn comes.
    const order = [...negotiated.values()].sort(
      (a, b) => (a.entry.extends?.length ?? 0) - (b.entry.extends?.length ?? 0),
    );
    for (const cap of order) {
      const reason = await this.fetchGraph(cap, documents, reach, budget);
      if (reason !== null) {
        active.delete(cap.name);
        dropped.push({ name: cap.name, reason });
      }
    }

    // Versions and $defs for each extension, then prune extensions left without a parent.
    for (const cap of [...active.values()]) {
      const parents = cap.entry.extends ?? [];
      if (parents.length === 0) continue;
      const reason = checkExtension(cap, documents.get(cap.entry.schema) as Obj, active);
      if (reason !== null) {
        active.delete(cap.name);
        dropped.push({ name: cap.name, reason });
      }
    }
    pruneOrphans(active, dropped);

    const schemas = new MerchantSchemas(active, dropped, documents, reach);
    // Build every form now, so a schema that cannot be followed shows in the
    // merchant status rather than at the first send. Each capability alone
    // first, so a broken extension drops itself and never its parent.
    for (const name of [...active.keys()]) {
      if (!schemas.buildsAlone(name)) {
        active.delete(name);
        dropped.push({ name, reason: 'build' });
      }
    }
    pruneOrphans(active, dropped);
    // Every check a set's build makes is per document, so the union of
    // capabilities that each build alone builds too. Were one ever to fail,
    // its operation would answer `unavailable` and never be sent.
    pruneOrphans(active, dropped);
    return schemas;
  }

  /** Fetch one capability's schema graph; null when every check passed, else why not. */
  private async fetchGraph(
    cap: NegotiatedCapability,
    documents: Map<string, Obj>,
    reach: Map<string, Set<string>>,
    budget: { documents: number; bytes: number; releaseDocuments: number; releaseBytes: number },
  ): Promise<SchemaDropReason | null> {
    const ucpOwned = cap.name.startsWith('dev.ucp.');
    const allowed = (url: string): SchemaDropReason | null => {
      if (url.startsWith(RELEASE_SCHEMAS)) return null;
      if (ucpOwned) return 'release_path';
      return checkAuthorityBinding(cap.name, url).ok ? null : 'authority';
    };
    const rootReason = allowed(cap.entry.schema);
    if (rootReason !== null) return rootReason;

    const seen = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: cap.entry.schema, depth: 0 }];
    while (queue.length > 0) {
      const { url, depth } = queue.shift() as { url: string; depth: number };
      if (seen.has(url)) continue;
      seen.add(url);
      if (depth > SCHEMA_LIMITS.maxDepth) return 'limits';
      let doc = documents.get(url);
      if (doc === undefined) {
        const inRelease = url.startsWith(RELEASE_SCHEMAS);
        const maxDocs = inRelease ? SCHEMA_LIMITS.maxReleaseDocuments : SCHEMA_LIMITS.maxDocuments;
        const maxBytes = inRelease ? SCHEMA_LIMITS.maxReleaseBytes : SCHEMA_LIMITS.maxBytes;
        const docs = inRelease ? budget.releaseDocuments : budget.documents;
        const bytes = inRelease ? budget.releaseBytes : budget.bytes;
        if (docs + 1 > maxDocs) return 'limits';
        const got = await this.cache.get(url);
        if (!got.ok) return got.error === 'too_large' ? 'limits' : 'fetch';
        if (bytes + got.doc.bytes.length > maxBytes) return 'limits';
        if (inRelease) {
          budget.releaseDocuments += 1;
          budget.releaseBytes += got.doc.bytes.length;
        } else {
          budget.documents += 1;
          budget.bytes += got.doc.bytes.length;
        }
        const parsed = readJsonBytes(got.doc.bytes);
        if (!parsed.ok || !isObj(parsed.value)) return 'not_json';
        doc = parsed.value;
        documents.set(url, doc);
      }
      if (url === cap.entry.schema && doc.name !== cap.name) return 'identity';
      for (const ref of referencesOf(doc)) {
        let target: URL;
        try {
          target = new URL(ref, url);
        } catch {
          return 'authority';
        }
        target.hash = '';
        const reason = allowed(target.href);
        if (reason !== null) return reason;
        if (!seen.has(target.href)) queue.push({ url: target.href, depth: depth + 1 });
      }
    }
    reach.set(cap.name, seen);
    return null;
  }
}

/** Versions satisfy `[min, max]` as dates; an unreadable constraint fails. */
function within(version: string, range: unknown): boolean {
  if (!isObj(range) || typeof range.min !== 'string') return false;
  if (version < range.min) return false;
  if (range.max !== undefined && (typeof range.max !== 'string' || version > range.max))
    return false;
  return true;
}

/** An extension's `requires` and `$defs` checks (overview :1157-1203). */
function checkExtension(
  cap: NegotiatedCapability,
  root: Obj,
  active: ReadonlyMap<string, NegotiatedCapability>,
): SchemaDropReason | null {
  const defs = isObj(root.$defs) ? root.$defs : {};
  for (const parent of cap.entry.extends ?? []) {
    if (active.has(parent) && !isObj(defs[parent])) return 'missing_defs';
  }
  const requires = root.requires;
  if (requires === undefined) return null;
  if (!isObj(requires)) return 'requires';
  if (requires.protocol !== undefined && !within(UCP_VERSION, requires.protocol)) return 'requires';
  if (requires.capabilities !== undefined) {
    if (!isObj(requires.capabilities)) return 'requires';
    for (const [name, range] of Object.entries(requires.capabilities)) {
      // Keys MUST be a subset of the extension's $defs keys.
      if (!isObj(defs[name])) return 'requires';
      const chosen = active.get(name);
      if (chosen !== undefined && !within(chosen.version, range)) return 'requires';
    }
  }
  return null;
}

/** Drop extensions none of whose parents is still active, until nothing changes. */
function pruneOrphans(active: Map<string, NegotiatedCapability>, dropped: SchemaDrop[]): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const cap of [...active.values()]) {
      const parents = cap.entry.extends ?? [];
      if (parents.length > 0 && !parents.some((p) => active.has(p))) {
        active.delete(cap.name);
        dropped.push({ name: cap.name, reason: 'parent_dropped' });
        changed = true;
      }
    }
  }
}
