/**
 * Project Dina's service listings onto a public Agent Card (design §7.1).
 *
 * Pure and deterministic. Core classifies each capability first (canonical
 * name, catalog action class, public-exposure rule, pinned schema pair, and
 * the executor §7.3's selection found) and hands the result in; this module
 * applies the inclusion rules and builds the card. Nothing on the input that
 * the card does not need is ever copied, so an instruction, an MCP binding,
 * a plugin install id or a persona cannot leak through.
 *
 * Included: listings that are `active` + `public` + `surface: 'services'`;
 * per capability, an official (catalog) capability that is not commerce, not
 * `payment`, allowed in public, with a pinned params schema and hash that
 * Core's validator enforces exactly, and a supported executor. A skill id two
 * capabilities would both claim (a capability and its alias on one listing)
 * is ambiguous and left out entirely, as invocation refuses it too.
 * Everything else is left out.
 *
 * The extended card (design §7.1, A2A §3.1.11) projects for one client:
 * the public skills in its scope, and the skills its live grants open on
 * unlisted and known_only listings, each with the `grant_id` and
 * `schema_hash` its call carries. It mirrors invocation exactly: a grant
 * on a public listing changes nothing there (the public rules and the
 * scope decide), and a sensitive capability may be granted though never
 * public.
 *
 * Every skill carries its call contract twice (design §7.6): machine-readable
 * in the Dina extension, and in standard fields (`inputModes`, a JSON-text
 * `examples[]` sample, and a `description` naming required params), so a
 * client that ignores the optional extension can still form a valid call
 * (control plane §18.4).
 */

import {
  A2A_LIMITS,
  A2A_PROTOCOL_VERSION,
  DINA_A2A_EXTENSION_URI,
  JSON_MEDIA_TYPE,
  PROTOCOL_BINDING_HTTP_JSON,
  PROTOCOL_BINDING_JSONRPC,
} from './constants';
import { DINA_REQUEST_SIGNING } from './did_auth';
import { qualifySkill } from './envelope';
import { JcsError, canonicalize } from './jcs';
import { isPlainObject, utf8Bytes, type JsonObject, type JsonValue } from './json';
import { MAX_ID_LENGTH } from './validate';

import type {
  AgentCard,
  AgentProvider,
  AgentSkill,
  SecurityRequirement,
  SecurityScheme,
} from './types';

export const COMMERCE_CAPABILITY_PREFIX = 'com.dinakernel.commerce.';

export type CatalogActionClass = 'read' | 'quote' | 'write' | 'booking' | 'payment' | 'agentic';
export type ExecutorKind = 'plugin' | 'mcp_server' | 'tier1';

export interface ProjectionCapability {
  /** The capability name as configured on the listing. */
  capability: string;
  /** The official catalog id it resolves to, or `null` when custom or unknown. */
  canonical: string | null;
  actionClass: CatalogActionClass | null;
  publicExposureAllowed: boolean;
  paramsSchema?: JsonObject;
  schemaHash?: string;
  /**
   * Core's audit of the schema pair (`pinnedSchemaProblems(…, 'pinned_runtime')`
   * found nothing in the params schema or the result schema). A schema with a
   * keyword the validator would skip cannot be projected: the card would
   * promise a check the call never makes, on what it takes or what it gives.
   */
  schemasEnforceable: boolean;
  /** What §7.3's executor selection chose, or `null` when nothing supported can run it. */
  executor: ExecutorKind | null;
  displayName: string;
  description: string;
  tags: string[];
}

export interface ProjectionListing {
  rkey: string;
  status: 'draft' | 'active' | 'paused';
  discoverability: 'public' | 'unlisted' | 'known_only';
  surface: 'services' | 'talk';
  capabilities: ProjectionCapability[];
}

/** Who an extended card is for: what invocation would let this client call. */
export interface CardAudience {
  /** The client's public-skill scope (qualified skill ids or canonical names); empty means every public skill. */
  scope: readonly string[];
  /** The client's live grants: the listing and the capability (as the listing configures it) each opens. */
  grants: readonly { grantId: string; rkey: string; capability: string }[];
}

export interface CardProjectionInput {
  nodeDid: string;
  name: string;
  description: string;
  version: string;
  provider?: AgentProvider;
  documentationUrl?: string;
  iconUrl?: string;
  /** The gateway's JSON-RPC endpoint, the interface the card prefers. */
  interfaceUrl: string;
  /** The base of the gateway's REST binding (`A2A_REST_PATH`), listed second when given. */
  restInterfaceUrl?: string;
  securitySchemes: Record<string, SecurityScheme>;
  securityRequirements: SecurityRequirement[];
  flags: { streaming: boolean; pushNotifications: boolean; extendedAgentCard: boolean };
  listings: ProjectionListing[];
  /** Set for an extended card: the client it is for. Absent: the public card. */
  audience?: CardAudience;
  /**
   * The validator that will judge calls (Core's): an example it rejects is
   * left off the card, so an example is never a call that would be refused.
   */
  acceptsExample?: ExampleCheck;
}

/** Whether a call's params pass the skill's params schema, as invocation will judge them. */
export type ExampleCheck = (params: JsonObject, schema: JsonObject) => boolean;

export type ExclusionReason =
  | 'listing_not_active'
  | 'listing_not_public'
  | 'listing_not_services'
  | 'custom_capability'
  | 'commerce_capability'
  | 'no_action_class'
  | 'payment_class'
  | 'not_public_exposable'
  | 'no_schema_pair'
  | 'schema_unenforceable'
  /** The qualified skill id (`capability@rkey`) would be longer than a card allows. */
  | 'skill_id_too_long'
  /** The skill would take more of a card than one skill may (`skillShareFits`). */
  | 'skill_too_large'
  | 'no_executor'
  | 'ambiguous_skill'
  /** Granted access only: a public listing's skills are reached as public skills. */
  | 'listing_public';

/** How a client reaches a skill: as a public skill, or through a grant. */
export type SkillAccess = 'public' | 'granted';

export interface ProjectedSkill {
  skill: AgentSkill;
  rkey: string;
  canonical: string;
  paramsSchema: JsonObject;
  schemaHash: string;
  /** The grant a call to this skill carries; extended cards only. */
  grantId?: string;
}

/**
 * Why a listing capability is left off the card, or `null` when it is
 * projected. `granted` judges a capability a grant opens: its listing must
 * be unlisted or known_only, and the public-exposure rule does not apply.
 */
export function exclusionReason(
  listing: ProjectionListing,
  cap: ProjectionCapability,
  access: SkillAccess = 'public',
): ExclusionReason | null {
  if (listing.status !== 'active') return 'listing_not_active';
  if (access === 'public' && listing.discoverability !== 'public') return 'listing_not_public';
  if (access === 'granted' && listing.discoverability === 'public') return 'listing_public';
  if (listing.surface !== 'services') return 'listing_not_services';
  if (cap.capability.startsWith(COMMERCE_CAPABILITY_PREFIX)) return 'commerce_capability';
  if (cap.canonical === null) return 'custom_capability';
  if (cap.canonical.startsWith(COMMERCE_CAPABILITY_PREFIX)) return 'commerce_capability';
  if (ambiguousCanonicals(listing.capabilities).has(cap.canonical)) return 'ambiguous_skill';
  if (!skillIdFits(cap.canonical, listing.rkey)) return 'skill_id_too_long';
  if (cap.actionClass === null) return 'no_action_class';
  if (cap.actionClass === 'payment') return 'payment_class';
  if (access === 'public' && !cap.publicExposureAllowed) return 'not_public_exposable';
  if (cap.paramsSchema === undefined || cap.schemaHash === undefined || cap.schemaHash === '') {
    return 'no_schema_pair';
  }
  if (!cap.schemasEnforceable) return 'schema_unenforceable';
  if (!skillShareFits(listing.rkey, cap)) return 'skill_too_large';
  if (cap.executor === null) return 'no_executor';
  return null;
}

/**
 * The canonical capabilities one listing configures under more than one name
 * (a capability and its alias: `eta_query` and `bus_eta`). Each is ambiguous
 * whatever else is true of either entry: the card leaves its skill off
 * (`ambiguous_skill`) and invocation refuses every call to it, by any name,
 * so neither ever picks an entry silently (design §7.3). Core's invocation
 * calls this over the listing's configured keys, classified as projection
 * classifies them.
 */
export function ambiguousCanonicals(capabilities: readonly { canonical: string | null }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const { canonical } of capabilities) {
    if (canonical === null) continue;
    if (seen.has(canonical)) ambiguous.add(canonical);
    seen.add(canonical);
  }
  return ambiguous;
}

/** One projectable capability as a skill. Extended cards put the full envelope in the example. */
function projectedSkill(
  rkey: string,
  cap: ProjectionCapability,
  envelope: { full: boolean; grantId?: string },
  acceptsExample?: ExampleCheck,
): ProjectedSkill {
  const canonical = cap.canonical as string;
  const paramsSchema = cap.paramsSchema as JsonObject;
  const schemaHash = cap.schemaHash as string;
  const id = qualifySkill(canonical, rkey);
  const skill: AgentSkill = {
    id,
    name: cap.displayName,
    description: describeSkill(cap.description, paramsSchema, envelope.grantId !== undefined),
    tags: cap.tags.length > 0 ? [...cap.tags] : [canonical],
    inputModes: [JSON_MEDIA_TYPE],
    outputModes: [JSON_MEDIA_TYPE],
  };
  const sample = sampleFromSchema(paramsSchema);
  if (isPlainObject(sample) && (acceptsExample === undefined || acceptsExample(sample as JsonObject, paramsSchema))) {
    const call: JsonObject = { skill: id, params: sample };
    if (envelope.grantId !== undefined) call.grant_id = envelope.grantId;
    if (envelope.full) call.schema_hash = schemaHash;
    const example = canonicalize(call);
    // An example repeats what the schema says (a long const comes back whole); it is optional, so a long one is left off.
    if (utf8Bytes(example).length <= SAMPLE_MAX_EXAMPLE_BYTES) skill.examples = [example];
  }
  return {
    skill,
    rkey,
    canonical,
    paramsSchema,
    schemaHash,
    ...(envelope.grantId === undefined ? {} : { grantId: envelope.grantId }),
  };
}

/**
 * All projectable skills, sorted by id: the public card's, or with an
 * audience the extended card's — the public ones in the client's scope,
 * then one skill per capability a live grant opens (the first grant by id
 * when several open the same one).
 */
export function projectSkills(
  listings: ProjectionListing[],
  audience?: CardAudience,
  acceptsExample?: ExampleCheck,
): ProjectedSkill[] {
  const out: ProjectedSkill[] = [];
  const full = audience !== undefined;
  for (const listing of listings) {
    for (const cap of listing.capabilities) {
      if (exclusionReason(listing, cap) !== null) continue;
      const id = qualifySkill(cap.canonical as string, listing.rkey);
      if (audience !== undefined && audience.scope.length > 0) {
        if (!audience.scope.includes(id) && !audience.scope.includes(cap.canonical as string))
          continue;
      }
      out.push(projectedSkill(listing.rkey, cap, { full }, acceptsExample));
    }
  }
  if (audience !== undefined) {
    const taken = new Set(out.map((s) => s.skill.id));
    const grants = [...audience.grants].sort((a, b) =>
      a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0,
    );
    for (const grant of grants) {
      const listing = listings.find((l) => l.rkey === grant.rkey);
      const cap = listing?.capabilities.find((c) => c.capability === grant.capability);
      if (
        listing === undefined ||
        cap === undefined ||
        exclusionReason(listing, cap, 'granted') !== null
      )
        continue;
      const id = qualifySkill(cap.canonical as string, listing.rkey);
      if (taken.has(id)) continue;
      taken.add(id);
      out.push(projectedSkill(listing.rkey, cap, { full, grantId: grant.grantId }, acceptsExample));
    }
  }
  out.sort((a, b) => (a.skill.id < b.skill.id ? -1 : a.skill.id > b.skill.id ? 1 : 0));
  return out;
}

export type CardProjection =
  | { ok: true; card: AgentCard; skills: ProjectedSkill[] }
  | { ok: false; reason: 'no_projectable_skills' };

export function projectAgentCard(input: CardProjectionInput): CardProjection {
  const skills = projectSkills(input.listings, input.audience, input.acceptsExample);
  if (skills.length === 0) return { ok: false, reason: 'no_projectable_skills' };
  const skillContracts: JsonObject = {};
  for (const s of skills) {
    skillContracts[s.skill.id] = {
      paramsSchema: s.paramsSchema,
      schemaHash: s.schemaHash,
      ...(s.grantId === undefined ? {} : { grantId: s.grantId }),
    };
  }
  const card: AgentCard = {
    name: input.name,
    description: input.description,
    // In preference order (spec §5.3): JSON-RPC, then REST.
    supportedInterfaces: [
      {
        url: input.interfaceUrl,
        protocolBinding: PROTOCOL_BINDING_JSONRPC,
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
      ...(input.restInterfaceUrl === undefined
        ? []
        : [
            {
              url: input.restInterfaceUrl,
              protocolBinding: PROTOCOL_BINDING_HTTP_JSON,
              protocolVersion: A2A_PROTOCOL_VERSION,
            },
          ]),
    ],
    version: input.version,
    capabilities: {
      streaming: input.flags.streaming,
      pushNotifications: input.flags.pushNotifications,
      extensions: [
        {
          uri: DINA_A2A_EXTENSION_URI,
          description:
            'Dina invocation contract: the node DID; per skill, the params JSON Schema and its hash; and how a DID-bound client signs its requests.',
          params: {
            did: input.nodeDid,
            skills: skillContracts,
            requestSigning: { ...DINA_REQUEST_SIGNING, headers: [...DINA_REQUEST_SIGNING.headers] },
          },
        },
      ],
      extendedAgentCard: input.flags.extendedAgentCard,
    },
    defaultInputModes: [JSON_MEDIA_TYPE],
    defaultOutputModes: [JSON_MEDIA_TYPE],
    skills: skills.map((s) => s.skill),
  };
  if (input.provider !== undefined) card.provider = { ...input.provider };
  if (input.documentationUrl !== undefined) card.documentationUrl = input.documentationUrl;
  if (Object.keys(input.securitySchemes).length > 0)
    card.securitySchemes = { ...input.securitySchemes };
  if (input.securityRequirements.length > 0)
    card.securityRequirements = [...input.securityRequirements];
  if (input.iconUrl !== undefined) card.iconUrl = input.iconUrl;
  return { ok: true, card, skills };
}

/** Skill prose: the capability description plus the required params and their types. */
function describeSkill(description: string, schema: JsonObject, granted = false): string {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : [];
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  const parts = required.map((name) => {
    const prop = props[name];
    const type = isPlainObject(prop) && typeof prop.type === 'string' ? prop.type : 'value';
    return `${name} (${type})`;
  });
  const call = granted
    ? 'Call with one JSON data part {"skill": <this id>, "grant_id": <your grant>, "params": {...}}.'
    : 'Call with one JSON data part {"skill": <this id>, "params": {...}}.';
  return parts.length > 0
    ? `${description} ${call} Required params: ${parts.join(', ')}.`
    : `${description} ${call}`;
}

/** The grant id a share is measured with: the longest a call may carry. */
const LONGEST_GRANT_ID = 'g'.repeat(MAX_ID_LENGTH);

/**
 * Whether a skill fits its share of a card: its `skills[]` entry and its
 * extension contract, in the largest form any card gives it (granted, full
 * envelope, with its example), within `A2A_LIMITS.maxSkillShareBytes`. A
 * skill that cannot be canonicalized (nesting past 32, a lone surrogate)
 * does not fit. Projection leaves a skill that does not fit off the card;
 * Core's invocation asks the same function of the same capability, so no
 * call reaches a skill no card shows.
 */
/**
 * Whether a skill's id (`capability@rkey`) fits a card: at most
 * `MAX_ID_LENGTH`, or the whole card would be invalid. Projection leaves a
 * skill whose id does not fit off the card; Core's invocation asks the same
 * function, so no call reaches it by bare name or by reference either.
 */
export function skillIdFits(canonical: string, rkey: string): boolean {
  return qualifySkill(canonical, rkey).length <= MAX_ID_LENGTH;
}

export function skillShareFits(rkey: string, cap: ProjectionCapability): boolean {
  if (cap.canonical === null || cap.paramsSchema === undefined || cap.schemaHash === undefined) return false;
  try {
    const largest = projectedSkill(rkey, cap, { full: true, grantId: LONGEST_GRANT_ID });
    const share = canonicalize({
      skill: largest.skill as unknown as JsonValue,
      contract: { paramsSchema: largest.paramsSchema, schemaHash: largest.schemaHash, grantId: LONGEST_GRANT_ID },
    });
    return utf8Bytes(share).length <= A2A_LIMITS.maxSkillShareBytes;
  } catch (err) {
    if (err instanceof JcsError) return false;
    throw err;
  }
}

/** Keywords the sampler knows how to satisfy; annotations describe and never constrain. */
const SAMPLER_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  '$id',
  '$schema',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
]);

/**
 * Bounds on an example, past any of which the skill carries none: the
 * longest placeholder string, the most items in one array, the deepest
 * schema walked (Core refuses a listing schema deeper than 8), and the most
 * JSON values in the whole sample, counted as serialized (16 nested arrays
 * of 16 would otherwise be 16^16 values once written out).
 */
export const SAMPLE_MAX_LENGTH = 64;
export const SAMPLE_MAX_ITEMS = 16;
export const SAMPLE_MAX_DEPTH = 16;
export const SAMPLE_MAX_VALUES = 256;
/** The longest example call a skill carries, in canonical UTF-8 bytes. */
export const SAMPLE_MAX_EXAMPLE_BYTES = 2 * 1024;

/** Whether a JSON value is of a JSON Schema type (or of any type the schema allows). */
function ofSchemaType(value: unknown, type: unknown): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case 'object':
        return isPlainObject(value);
      case 'array':
        return Array.isArray(value);
      case 'string':
        return typeof value === 'string';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'null':
        return value === null;
      default:
        return false;
    }
  });
}

/**
 * A minimal value satisfying a schema, for the skill's `examples[]`. Best
 * effort: `undefined` whenever the schema uses a keyword outside
 * {@link SAMPLER_KEYWORDS} (a `pattern`, `format`, `exclusiveMinimum`,
 * `multipleOf`, `uniqueItems`, `oneOf`, …), passes one of the bounds
 * above, or bounds no placeholder meets, in which case the skill carries no
 * example and the prose and extension still describe the call. A `const`
 * or `enum` member is used only when it is of the schema's type. Total on
 * any JSON: it never throws. Core also checks every example with its own
 * validator before it goes on a card (`CardProjectionInput.acceptsExample`).
 */
export function sampleFromSchema(schema: unknown): JsonValue | undefined {
  return sample(schema, 0)?.value;
}

/** A sample and how many JSON values it holds once serialized. */
interface Sample {
  value: JsonValue;
  values: number;
}

/** A bound keyword's value: a non-negative integer, `fallback` when absent, null when malformed. */
function countBound(schema: Readonly<Record<string, unknown>>, key: string, fallback: number): number | null {
  if (!Object.prototype.hasOwnProperty.call(schema, key)) return fallback;
  const v = schema[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * How many JSON values `value` holds, counting no further than just past the
 * budget. Iterative, and it never spreads a container into a call: a
 * `const` of 200,000 items would overflow the stack as arguments.
 */
function valueCount(value: unknown): number {
  const over = SAMPLE_MAX_VALUES + 1;
  let n = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    n += 1;
    if (n >= over) return over;
    const members = Array.isArray(v) ? v : isPlainObject(v) ? Object.values(v) : null;
    if (members === null) continue;
    if (members.length >= over) return over;
    for (const member of members) stack.push(member);
  }
  return n;
}

function within(value: JsonValue, values: number): Sample | undefined {
  return values > SAMPLE_MAX_VALUES ? undefined : { value, values };
}

function sample(schema: unknown, depth: number): Sample | undefined {
  if (depth > SAMPLE_MAX_DEPTH || !isPlainObject(schema)) return undefined;
  for (const key of Object.keys(schema)) if (!SAMPLER_KEYWORDS.has(key)) return undefined;
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    const value = schema.const as JsonValue;
    return ofSchemaType(value, schema.type) ? within(value, valueCount(value)) : undefined;
  }
  if (Array.isArray(schema.enum)) {
    const member = schema.enum.find((m) => ofSchemaType(m, schema.type));
    return member === undefined ? undefined : within(member as JsonValue, valueCount(member));
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, JsonValue> = {};
      let values = 1;
      const props = isPlainObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const name of required) {
        if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(props, name)) {
          return undefined;
        }
        const v = sample(props[name], depth + 1);
        if (v === undefined) return undefined;
        out[name] = v.value;
        values += v.values;
        if (values > SAMPLE_MAX_VALUES) return undefined;
      }
      return { value: out, values };
    }
    case 'array': {
      const min = countBound(schema, 'minItems', 0);
      const max = countBound(schema, 'maxItems', Infinity);
      if (min === null || max === null || min > max || min > SAMPLE_MAX_ITEMS) return undefined;
      if (min === 0) return { value: [], values: 1 };
      const item = sample(schema.items, depth + 1);
      return item === undefined
        ? undefined
        : within(
            Array.from({ length: min }, () => item.value),
            1 + min * item.values,
          );
    }
    case 'string': {
      const min = countBound(schema, 'minLength', 0);
      const max = countBound(schema, 'maxLength', Infinity);
      return min === null || max === null || min > max || min > SAMPLE_MAX_LENGTH
        ? undefined
        : { value: 'x'.repeat(min), values: 1 };
    }
    case 'integer':
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : 0;
      const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
      const v = type === 'integer' ? Math.ceil(min) : min;
      return max !== undefined && v > max ? undefined : { value: v, values: 1 };
    }
    case 'boolean':
      return { value: false, values: 1 };
    case 'null':
      return { value: null, values: 1 };
    default:
      return undefined;
  }
}
