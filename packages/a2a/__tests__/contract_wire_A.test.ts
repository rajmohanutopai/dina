/**
 * Area A of the A2A test plan: the wire contract rules that had no test of
 * their own. Each test names its plan row; the rule comes from the design
 * (docs/A2A_GATEWAY_ARCHITECTURE.md), the plan (docs/A2A_IMPLEMENTATION_PLAN.md),
 * the build notes (implementation-notes.html, "A2A gateway") or the A2A
 * v1.0.1 spec and proto they cite.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_LIMITS,
  A2A_TO_OUTBOUND,
  AGENT_CARD_WELL_KNOWN_PATH,
  DINA_A2A_EXTENSION_URI,
  DID_BINDING_DOMAIN,
  MAX_CARD_SIGNATURES,
  WORKFLOW_TO_A2A,
  a2aError,
  base58btcDecode,
  base58btcEncode,
  base64Decode,
  base64Encode,
  base64urlDecode,
  base64urlEncode,
  base64urlEncodeUtf8,
  bytesToHex,
  canonicalize,
  cardPinText,
  cardSigningContent,
  cardSigningPayload,
  didBindingSigningInput,
  ed25519FromMultikey,
  ed25519Multikey,
  envelopeObject,
  exclusionReason,
  inboundView,
  isUuidV4,
  outboundDisposition,
  p256FromMultikey,
  p256Multikey,
  parseDeliveryClaim,
  parseDidBindingRequest,
  parseEnvelopeData,
  parseInvocationEnvelope,
  parseJsonRpcRequestText,
  parseJsonRpcResponseText,
  parseProtectedHeader,
  parseQualifiedSkill,
  parseStrictJson,
  projectAgentCard,
  restError,
  sanitizeRemoteParts,
  signAgentCard,
  untrustedJsonProblem,
  utf8Bytes,
  uuidV4FromBytes,
  validateAgentCardShape,
  verifyAgentCardSignatures,
  type AgentCardSignature,
  type CardProjectionInput,
  type JsonObject,
  type JwsVerifyFn,
  type JwsVerdict,
  type ProjectionCapability,
  type ProjectionListing,
} from '../src';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ETA_SCHEMA = {
  type: 'object',
  required: ['route', 'stop'],
  properties: { route: { type: 'string', minLength: 1 }, stop: { type: 'string' } },
};

const cap = (over: Partial<ProjectionCapability> = {}): ProjectionCapability => ({
  capability: 'eta_query',
  canonical: 'eta_query',
  actionClass: 'read',
  publicExposureAllowed: true,
  paramsSchema: ETA_SCHEMA,
  schemaHash: 'a'.repeat(64),
  schemasEnforceable: true,
  executor: 'tier1',
  displayName: 'ETA',
  description: 'Arrival time at a stop.',
  tags: ['transit'],
  ...over,
});

const listing = (over: Partial<ProjectionListing> = {}): ProjectionListing => ({
  rkey: 'self',
  status: 'active',
  discoverability: 'public',
  surface: 'services',
  capabilities: [cap()],
  ...over,
});

const projectionInput = (listings: ProjectionListing[]): CardProjectionInput => ({
  nodeDid: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
  name: 'Bus 42 Desk',
  description: 'Next-bus times.',
  version: '1',
  interfaceUrl: 'https://a2a.example.org/rpc',
  securitySchemes: {},
  securityRequirements: [],
  flags: { streaming: false, pushNotifications: false, extendedAgentCard: false },
  listings,
});

/** A small valid v1.0 card, fresh on every call. */
const baseCard = (): Record<string, unknown> => ({
  name: 'Agent',
  description: 'Does things',
  supportedInterfaces: [{ url: 'https://a.example/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  version: '1',
  capabilities: {},
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 's1', name: 'S', description: 'd', tags: ['t'] }],
});

// ---------------------------------------------------------------------------
// A.1 Pinned facts
// ---------------------------------------------------------------------------

describe('pinned A2A facts (plan §2)', () => {
  // Plan A1
  it('serves the public card at /.well-known/agent-card.json, the path the gateway routes (spec §8.2; plan §2 row 2)', () => {
    expect(AGENT_CARD_WELL_KNOWN_PATH).toBe('/.well-known/agent-card.json');
    // The gateway keeps its own name for the path; it must be this one, and the route it serves.
    const server = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'home-node-lite', 'a2a-gateway', 'src', 'server.ts'), 'utf8');
    expect(/export const AGENT_CARD_PATH = '([^']*)'/.exec(server)?.[1]).toBe(AGENT_CARD_WELL_KNOWN_PATH);
    expect(server).toMatch(/app\.get\(AGENT_CARD_PATH,/);
  });

  // Plan A2
  it('puts the extension version in its URI, and the card entry carries no version member (plan §2 row 8)', () => {
    expect(DINA_A2A_EXTENSION_URI).toMatch(/\/ext\/v1$/);
    const out = projectAgentCard(projectionInput([listing()]));
    if (!out.ok) throw new Error(out.reason);
    const extensions = out.card.capabilities.extensions ?? [];
    expect(extensions).toHaveLength(1);
    const entry = extensions[0] ?? {};
    expect(entry).toMatchObject({ uri: DINA_A2A_EXTENSION_URI });
    expect(entry).not.toHaveProperty('version');
    // Only the members AgentExtension has (a2a.proto v1.0.1); Dina's extension is never required (design §7.6).
    for (const k of Object.keys(entry)) expect(['uri', 'description', 'required', 'params']).toContain(k);
    expect((entry as { required?: unknown }).required).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A.2 JSON-RPC envelope
// ---------------------------------------------------------------------------

describe('JSON-RPC ids and response text', () => {
  const request = (id: string) => `{"jsonrpc":"2.0","id":${id},"method":"GetTask","params":{"id":"t1"}}`;

  // Plan A22
  it.each([
    ['an empty string', '""'],
    ['a string past 256 characters', JSON.stringify('x'.repeat(257))],
    ['the first unsafe integer (2^53)', '9007199254740992'],
    ['a boolean', 'true'],
    ['an object', '{"n":1}'],
    ['an array', '[1]'],
  ])('refuses %s as a request id: -32600 with id null, never echoed', (_name, id) => {
    const parsed = parseJsonRpcRequestText(request(id));
    if (parsed.ok || 'notification' in parsed) throw new Error('expected an error reply');
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.id).toBeNull();
  });

  // Plan A22
  it.each([
    ['a negative integer', '-5', -5],
    ['zero', '0', 0],
    ['the largest safe integer (2^53 - 1)', '9007199254740991', 9007199254740991],
    ['a string of exactly 256 characters', JSON.stringify('y'.repeat(256)), 'y'.repeat(256)],
  ])('accepts %s as a request id and keeps it', (_name, text, id) => {
    const parsed = parseJsonRpcRequestText(request(text));
    expect(parsed.ok && parsed.request.id).toBe(id);
  });

  // Plan A34
  it('reads a peer response strictly: two result members, or a __proto__ member, make it malformed', () => {
    expect(parseJsonRpcResponseText('{"jsonrpc":"2.0","id":1,"result":{"ok":true},"result":{"ok":false}}', 1)).toEqual({
      ok: false,
      malformed: 'json_duplicate_member',
    });
    expect(parseJsonRpcResponseText('{"jsonrpc":"2.0","id":1,"result":{"__proto__":{"x":1}}}', 1)).toEqual({
      ok: false,
      malformed: 'json_forbidden_member',
    });
  });

  // Plan A34
  it('matches a response id by type and value: "1" does not answer request 1', () => {
    expect(parseJsonRpcResponseText('{"jsonrpc":"2.0","id":"1","result":{}}', 1)).toEqual({ ok: false, malformed: 'id_mismatch' });
    expect(parseJsonRpcResponseText('{"jsonrpc":"2.0","id":1,"result":{}}', '1')).toEqual({ ok: false, malformed: 'id_mismatch' });
    expect(parseJsonRpcResponseText('{"jsonrpc":"2.0","id":1,"result":{}}', 1)).toEqual({ ok: true, result: {} });
  });
});

// ---------------------------------------------------------------------------
// A.3 Strict I-JSON
// ---------------------------------------------------------------------------

describe('strict I-JSON parsing (RFC 7493)', () => {
  // Plan A41
  it('refuses a lone surrogate written raw in a string or a key (RFC 7493 §2.1)', () => {
    expect(parseStrictJson('"a\ud800b"')).toEqual({ ok: false, reason: 'lone_surrogate' });
    expect(parseStrictJson('"\udc00"')).toEqual({ ok: false, reason: 'lone_surrogate' });
    expect(parseStrictJson('{"k\udc00":1}')).toEqual({ ok: false, reason: 'lone_surrogate' });
    // A raw pair is one character, and stays.
    const pair = String.fromCodePoint(0x1f600);
    expect(parseStrictJson(`"${pair}"`)).toEqual({ ok: true, value: pair });
  });

  // Plan A44
  it('refuses a 200,000-deep text as too deep, with no stack overflow', () => {
    const n = 200_000;
    expect(parseStrictJson('['.repeat(n) + ']'.repeat(n))).toEqual({ ok: false, reason: 'too_deep' });
    expect(parseStrictJson('{"a":'.repeat(n) + '1' + '}'.repeat(n))).toEqual({ ok: false, reason: 'too_deep' });
    let deep: unknown = 1;
    for (let i = 0; i < n; i += 1) deep = [deep];
    expect(untrustedJsonProblem(deep)).toBe('too_deep');
  });

  // Plan A44
  it('refuses a byte-order mark and a no-break space, which RFC 8259 does not count as whitespace', () => {
    const bom = String.fromCharCode(0xfeff);
    const nbsp = String.fromCharCode(0x00a0);
    expect(parseStrictJson(`${bom}{}`)).toEqual({ ok: false, reason: 'syntax' });
    expect(parseStrictJson(`${nbsp}{}`)).toEqual({ ok: false, reason: 'syntax' });
    expect(parseStrictJson(`{}${nbsp}`)).toEqual({ ok: false, reason: 'syntax' });
  });

  // Plan A44
  it('keeps members named after Object.prototype members as plain data', () => {
    const parsed = parseStrictJson('{"constructor":1,"toString":"x","hasOwnProperty":null,"valueOf":[]}');
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value).toEqual({ constructor: 1, toString: 'x', hasOwnProperty: null, valueOf: [] });
    expect(Object.keys(parsed.value as object).sort()).toEqual(['constructor', 'hasOwnProperty', 'toString', 'valueOf']);
  });
});

// ---------------------------------------------------------------------------
// A.4 RFC 8785
// ---------------------------------------------------------------------------

describe('RFC 8785 number form (Appendix B)', () => {
  const fromBits = (hex: string): number => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${hex}`));
    return view.getFloat64(0);
  };

  // Plan A49
  it.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('writes the double %s as %s', (bits, text) => {
    expect(canonicalize(fromBits(bits))).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// A.5 Card validator
// ---------------------------------------------------------------------------

describe('card validator: no __proto__, no excess depth', () => {
  // Plan A62
  it('refuses a card carrying a __proto__ member anywhere', () => {
    const top = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(baseCard()).slice(1)}`) as unknown;
    expect(validateAgentCardShape(top)).toBe('card_forbidden_member');
    const inSkill = JSON.parse(
      JSON.stringify(baseCard()).replace('"tags":["t"]', '"tags":["t"],"__proto__":{"admin":true}'),
    ) as unknown;
    expect(validateAgentCardShape(inSkill)).toBe('card_forbidden_member');
  });

  // Plan A62
  it('refuses a card nested deeper than the JSON depth cap', () => {
    let deep: unknown = 1;
    for (let i = 0; i <= A2A_LIMITS.maxJsonDepth; i += 1) deep = { d: deep };
    const card = { ...baseCard(), capabilities: { extensions: [{ uri: 'u', params: { deep } }] } };
    expect(validateAgentCardShape(card)).toBe('card_too_deep');
  });
});

// ---------------------------------------------------------------------------
// A.6 Card canonical form against a2a.proto v1.0.1
// ---------------------------------------------------------------------------

/**
 * The field rules of `specification/a2a.proto` (v1.0.1, package lf.a2a.v1),
 * written out from the proto: `required` is `field_behavior = REQUIRED`,
 * `optional` is a proto3 `optional` scalar (explicit presence). Every other
 * scalar, list and map is dropped at its default; a message field is kept
 * when present.
 */
type ProtoField =
  | { kind: 'string' | 'bool'; required?: true; optional?: true }
  | { kind: 'repeated' | 'map'; required?: true }
  | { kind: 'message'; of: string; required?: true }
  | { kind: 'struct' };

const str = (flag?: 'required' | 'optional'): ProtoField =>
  flag === 'required' ? { kind: 'string', required: true } : flag === 'optional' ? { kind: 'string', optional: true } : { kind: 'string' };
const bool = (flag?: 'optional'): ProtoField => (flag === 'optional' ? { kind: 'bool', optional: true } : { kind: 'bool' });
const list = (required?: 'required'): ProtoField => (required ? { kind: 'repeated', required: true } : { kind: 'repeated' });
const map = (required?: 'required'): ProtoField => (required ? { kind: 'map', required: true } : { kind: 'map' });
const msg = (of: string, required?: 'required'): ProtoField =>
  required ? { kind: 'message', of, required: true } : { kind: 'message', of };

const PROTO: Readonly<Record<string, Readonly<Record<string, ProtoField>>>> = {
  AgentCard: {
    name: str('required'),
    description: str('required'),
    supportedInterfaces: list('required'),
    provider: msg('AgentProvider'),
    version: str('required'),
    documentationUrl: str('optional'),
    capabilities: msg('AgentCapabilities', 'required'),
    securitySchemes: map(),
    securityRequirements: list(),
    defaultInputModes: list('required'),
    defaultOutputModes: list('required'),
    skills: list('required'),
    iconUrl: str('optional'),
  },
  AgentInterface: { url: str('required'), protocolBinding: str('required'), tenant: str(), protocolVersion: str('required') },
  AgentProvider: { url: str('required'), organization: str('required') },
  AgentExtension: { uri: str(), description: str(), required: bool(), params: { kind: 'struct' } },
  AgentCapabilities: { streaming: bool('optional'), pushNotifications: bool('optional'), extensions: list(), extendedAgentCard: bool('optional') },
  AgentSkill: {
    id: str('required'),
    name: str('required'),
    description: str('required'),
    tags: list('required'),
    examples: list(),
    inputModes: list(),
    outputModes: list(),
    securityRequirements: list(),
  },
  SecurityScheme: {
    apiKeySecurityScheme: msg('APIKeySecurityScheme'),
    httpAuthSecurityScheme: msg('HTTPAuthSecurityScheme'),
    oauth2SecurityScheme: msg('OAuth2SecurityScheme'),
    openIdConnectSecurityScheme: msg('OpenIdConnectSecurityScheme'),
    mtlsSecurityScheme: msg('MutualTlsSecurityScheme'),
  },
  APIKeySecurityScheme: { description: str(), location: str('required'), name: str('required') },
  HTTPAuthSecurityScheme: { description: str(), scheme: str('required'), bearerFormat: str() },
  OAuth2SecurityScheme: { description: str(), flows: msg('OAuthFlows', 'required'), oauth2MetadataUrl: str() },
  OpenIdConnectSecurityScheme: { description: str(), openIdConnectUrl: str('required') },
  MutualTlsSecurityScheme: { description: str() },
  OAuthFlows: {
    authorizationCode: msg('AuthorizationCodeOAuthFlow'),
    clientCredentials: msg('ClientCredentialsOAuthFlow'),
    implicit: msg('ImplicitOAuthFlow'),
    password: msg('PasswordOAuthFlow'),
    deviceCode: msg('DeviceCodeOAuthFlow'),
  },
  AuthorizationCodeOAuthFlow: {
    authorizationUrl: str('required'),
    tokenUrl: str('required'),
    refreshUrl: str(),
    scopes: map('required'),
    pkceRequired: bool(),
  },
  ClientCredentialsOAuthFlow: { tokenUrl: str('required'), refreshUrl: str(), scopes: map('required') },
  ImplicitOAuthFlow: { authorizationUrl: str(), refreshUrl: str(), scopes: map() },
  PasswordOAuthFlow: { tokenUrl: str(), refreshUrl: str(), scopes: map() },
  DeviceCodeOAuthFlow: { deviceAuthorizationUrl: str('required'), tokenUrl: str('required'), refreshUrl: str(), scopes: map('required') },
  SecurityRequirement: { schemes: map() },
  StringList: { list: list() },
};

/** Where each message sits in a card. */
const SCHEMES = ['securitySchemes', 's'];
const FLOWS = [...SCHEMES, 'oauth2SecurityScheme', 'flows'];
const PLACES: readonly [string, readonly (string | number)[]][] = [
  ['AgentCard', []],
  ['AgentInterface', ['supportedInterfaces', 0]],
  ['AgentProvider', ['provider']],
  ['AgentCapabilities', ['capabilities']],
  ['AgentExtension', ['capabilities', 'extensions', 0]],
  ['AgentSkill', ['skills', 0]],
  ['SecurityScheme', SCHEMES],
  ['APIKeySecurityScheme', [...SCHEMES, 'apiKeySecurityScheme']],
  ['HTTPAuthSecurityScheme', [...SCHEMES, 'httpAuthSecurityScheme']],
  ['OAuth2SecurityScheme', [...SCHEMES, 'oauth2SecurityScheme']],
  ['OpenIdConnectSecurityScheme', [...SCHEMES, 'openIdConnectSecurityScheme']],
  ['MutualTlsSecurityScheme', [...SCHEMES, 'mtlsSecurityScheme']],
  ['OAuthFlows', FLOWS],
  ['AuthorizationCodeOAuthFlow', [...FLOWS, 'authorizationCode']],
  ['ClientCredentialsOAuthFlow', [...FLOWS, 'clientCredentials']],
  ['ImplicitOAuthFlow', [...FLOWS, 'implicit']],
  ['PasswordOAuthFlow', [...FLOWS, 'password']],
  ['DeviceCodeOAuthFlow', [...FLOWS, 'deviceCode']],
  ['SecurityRequirement', ['securityRequirements', 0]],
  ['SecurityRequirement', ['skills', 0, 'securityRequirements', 0]],
  ['StringList', ['securityRequirements', 0, 'schemes', 'k']],
];

const rulesOf = (name: string): Readonly<Record<string, ProtoField>> => {
  const rules = PROTO[name];
  if (rules === undefined) throw new Error(`no proto rules for ${name}`);
  return rules;
};

/** What a message canonicalizes to when its sender left every field out. */
function blank(name: string): JsonObject {
  const out: JsonObject = {};
  for (const [field, rule] of Object.entries(rulesOf(name))) {
    if (!('required' in rule) || rule.required !== true) continue;
    if (rule.kind === 'string') out[field] = '';
    else if (rule.kind === 'repeated') out[field] = [];
    else if (rule.kind === 'map') out[field] = {};
    else if (rule.kind === 'message') out[field] = blank(rule.of);
  }
  return out;
}

/** Every scalar, list, map and Struct field spelled out at its default; message fields left unset. */
function atDefaults(name: string): JsonObject {
  const out: JsonObject = {};
  for (const [field, rule] of Object.entries(rulesOf(name))) {
    if (rule.kind === 'string') out[field] = '';
    else if (rule.kind === 'bool') out[field] = false;
    else if (rule.kind === 'repeated') out[field] = [];
    else if (rule.kind === 'map' || rule.kind === 'struct') out[field] = {};
  }
  return out;
}

/** The proto's answer for {@link atDefaults}: REQUIRED and `optional` kept, a set Struct kept, the rest dropped. */
function expectedAtDefaults(name: string): JsonObject {
  const out: JsonObject = {};
  for (const [field, rule] of Object.entries(rulesOf(name))) {
    if (rule.kind === 'message') {
      if (rule.required === true) out[field] = blank(rule.of);
    } else if (rule.kind === 'struct') {
      out[field] = {};
    } else if (rule.required === true || ('optional' in rule && rule.optional === true)) {
      out[field] = rule.kind === 'string' ? '' : rule.kind === 'bool' ? false : rule.kind === 'repeated' ? [] : {};
    }
  }
  return out;
}

function setIn(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): Record<string, unknown> {
  if (path.length === 0) return value as Record<string, unknown>;
  let node: Record<string | number, unknown> = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i] as string | number;
    const nextIsIndex = typeof path[i + 1] === 'number';
    if (node[key] === undefined) node[key] = nextIsIndex ? [] : {};
    node = node[key] as Record<string | number, unknown>;
  }
  node[path[path.length - 1] as string | number] = value;
  return root;
}

function getIn(root: unknown, path: readonly (string | number)[]): unknown {
  let node = root;
  for (const key of path) node = (node as Record<string | number, unknown>)[key];
  return node;
}

const canonicalAt = (path: readonly (string | number)[], value: unknown): unknown =>
  getIn(cardSigningContent(setIn(baseCard(), path, value)), path);

describe('card canonical form follows a2a.proto v1.0.1 field by field (spec §8.4.1, §5.7)', () => {
  // Plan A70
  it.each(PLACES.map(([name, path]) => [name, path.join('.') || '(root)', path] as const))(
    '%s at %s, sent empty, gets back exactly its REQUIRED fields at their defaults',
    (name, _where, path) => {
      expect(canonicalAt(path, {})).toEqual(blank(name));
    },
  );

  // Plan A70
  it.each(PLACES.map(([name, path]) => [name, path.join('.') || '(root)', path] as const))(
    '%s at %s, every field at its default, keeps REQUIRED and optional fields and a set Struct, and drops the rest',
    (name, _where, path) => {
      expect(canonicalAt(path, atDefaults(name))).toEqual(expectedAtDefaults(name));
    },
  );

  // Plan A70
  it.each(
    PLACES.flatMap(([name, path]) =>
      Object.entries(rulesOf(name))
        .filter(([, rule]) => rule.kind === 'message')
        .map(([field, rule]) => [name, field, path, (rule as { of: string }).of] as const),
    ),
  )('%s.%s, set but empty, is kept as a present message with its own REQUIRED fields', (_name, field, path, of) => {
    expect((canonicalAt(path, { [field]: {} }) as Record<string, unknown>)[field]).toEqual(blank(of));
  });

  // Plan A70
  it.each(PLACES.map(([name, path]) => [name, path.join('.') || '(root)', path] as const))(
    '%s at %s keeps every scalar that is off its default as sent',
    (name, _where, path) => {
      const sent: JsonObject = {};
      for (const [field, rule] of Object.entries(rulesOf(name))) {
        if (rule.kind === 'string') sent[field] = `v-${field}`;
        else if (rule.kind === 'bool') sent[field] = true;
      }
      expect(canonicalAt(path, sent)).toEqual({ ...blank(name), ...sent });
    },
  );
});

// ---------------------------------------------------------------------------
// A.6 / A.7 Card pin and JWS
// ---------------------------------------------------------------------------

describe('card JWS: caps, strict headers, one key per kid', () => {
  const edSecret = ed25519.utils.randomSecretKey();
  const edPublic = ed25519.getPublicKey(edSecret);
  const p256Secret = p256.utils.randomSecretKey();
  const p256Public = p256.getPublicKey(p256Secret);

  /** The node's key set: ed-1 is the Ed25519 key, p256-1 the P-256 key. */
  const verify: JwsVerifyFn = ({ header, signingInputs, signature }) => {
    if (header.alg === 'EdDSA' && header.kid === 'ed-1') return signingInputs.some((input) => ed25519.verify(signature, input, edPublic));
    if (header.alg === 'ES256' && header.kid === 'p256-1') return signingInputs.some((input) => p256.verify(signature, input, p256Public));
    return false;
  };
  const counting = (inner: JwsVerifyFn = verify) => {
    const seen: string[] = [];
    const fn: JwsVerifyFn = (args) => {
      seen.push(args.header.kid);
      return inner(args);
    };
    return { fn, seen };
  };
  const edSign = (card: Record<string, unknown>, kid = 'ed-1') =>
    signAgentCard(card, { alg: 'EdDSA', kid }, (input) => ed25519.sign(input, edSecret));

  /** A signature over `card` under a protected header written by hand. */
  const handSigned = (card: Record<string, unknown>, headerText: string): AgentCardSignature => {
    const protectedB64 = base64urlEncodeUtf8(headerText);
    const input = utf8Bytes(`${protectedB64}.${base64urlEncodeUtf8(cardSigningPayload(card))}`);
    return { protected: protectedB64, signature: base64urlEncode(ed25519.sign(input, edSecret)) };
  };

  // Plan A85
  it('checks at most eight signatures: a ninth makes the card invalid before any verifier runs', async () => {
    expect(MAX_CARD_SIGNATURES).toBe(8);
    const sig = await edSign(baseCard());
    const nine = counting();
    expect((await verifyAgentCardSignatures({ ...baseCard(), signatures: Array(9).fill(sig) }, nine.fn)).state).toBe('invalid');
    expect(nine.seen).toEqual([]);
    const eight = counting();
    expect((await verifyAgentCardSignatures({ ...baseCard(), signatures: Array(8).fill(sig) }, eight.fn)).state).toBe('verified');
  });

  // Plan A86
  it('refuses a protected header that names alg twice, or kid twice', async () => {
    // Two algs Dina supports: with no duplicate check, a first-wins parse would verify as EdDSA and a
    // last-wins parse would hand ES256 to the verifier, so either way the verifier would see it.
    const twice = '{"alg":"EdDSA","kid":"ed-1","alg":"ES256"}';
    expect(parseProtectedHeader(base64urlEncodeUtf8(twice))).toBeNull();
    expect(parseProtectedHeader(base64urlEncodeUtf8('{"alg":"EdDSA","kid":"other","kid":"ed-1"}'))).toBeNull();
    const probe = counting();
    const report = await verifyAgentCardSignatures({ ...baseCard(), signatures: [handSigned(baseCard(), twice)] }, probe.fn);
    expect(report.state).toBe('invalid');
    expect(probe.seen).toEqual([]);
  });

  // Plan A87
  it('reads alg, kid and jku from the protected header only: an unprotected header cannot rename them', async () => {
    const sig = await edSign(baseCard());
    const probe = counting();
    const report = await verifyAgentCardSignatures(
      { ...baseCard(), signatures: [{ ...sig, header: { alg: 'ES256', kid: 'p256-1', jku: 'https://evil.example/jwks.json' } }] },
      probe.fn,
    );
    expect(probe.seen).toEqual(['ed-1']);
    expect(report).toEqual({ state: 'verified', verifiedKids: ['ed-1'], verifiedSigners: ['#ed-1'] });
    // A kid only in the unprotected header names no key: the signature is not checked.
    const kidless = { ...handSigned(baseCard(), '{"alg":"EdDSA"}'), header: { kid: 'ed-1' } };
    const second = counting();
    expect((await verifyAgentCardSignatures({ ...baseCard(), signatures: [kidless] }, second.fn)).state).toBe('invalid');
    expect(second.seen).toEqual([]);
  });

  // Plan A88
  it('refuses a padded or standard-alphabet signature spelling before the verifier sees it', async () => {
    // Ed25519 signs the same bytes each time. With this fixed key the signature holds '-' or '_',
    // so its standard-alphabet spelling differs in the alphabet and needs no padding.
    const fixedSecret = new Uint8Array(32).fill(2);
    const fixedPublic = ed25519.getPublicKey(fixedSecret);
    const fixedVerify: JwsVerifyFn = ({ header, signingInputs, signature }) =>
      header.kid === 'fixed-1' && signingInputs.some((input) => ed25519.verify(signature, input, fixedPublic));
    const sig = await signAgentCard(baseCard(), { alg: 'EdDSA', kid: 'fixed-1' }, (input) => ed25519.sign(input, fixedSecret));
    const padded = `${sig.signature}==`;
    const standard = sig.signature.replace(/-/g, '+').replace(/_/g, '/');
    expect(standard).not.toBe(sig.signature);
    expect(standard).not.toContain('=');
    // A lenient decoder reads both spellings as the signed bytes: only the strict decode stands between them and the verifier.
    const signed = Buffer.from(base64urlDecode(sig.signature) ?? []);
    expect(signed).toHaveLength(64);
    expect(Buffer.from(padded, 'base64url')).toEqual(signed);
    expect(Buffer.from(standard, 'base64')).toEqual(signed);
    // The canonical spelling reaches the verifier and verifies.
    const genuine = counting(fixedVerify);
    expect((await verifyAgentCardSignatures({ ...baseCard(), signatures: [sig] }, genuine.fn)).state).toBe('verified');
    expect(genuine.seen).toEqual(['fixed-1']);
    for (const spelling of [padded, standard]) {
      const probe = counting(fixedVerify);
      const report = await verifyAgentCardSignatures({ ...baseCard(), signatures: [{ ...sig, signature: spelling }] }, probe.fn);
      expect([spelling, report.state]).toEqual([spelling, 'invalid']);
      expect(probe.seen).toEqual([]);
    }
  });

  // Plan A88
  it('counts a verifier that throws as a failed signature, and still checks the next one', async () => {
    const sig = await edSign(baseCard());
    const throwing: JwsVerifyFn = () => {
      throw new Error('key set unreachable');
    };
    expect((await verifyAgentCardSignatures({ ...baseCard(), signatures: [sig] }, throwing)).state).toBe('invalid');
    const retired = await edSign(baseCard(), 'retired');
    const partly: JwsVerifyFn = (args) => {
      if (args.header.kid === 'retired') throw new Error('unknown key');
      return verify(args);
    };
    expect(await verifyAgentCardSignatures({ ...baseCard(), signatures: [retired, sig] }, partly)).toEqual({
      state: 'verified',
      verifiedKids: ['ed-1'],
      verifiedSigners: ['#ed-1'],
    });
  });

  // Plan A89 (Core's own key-set verifier meets the same forgery in packages/core/__tests__/a2a/contract_wire_A.test.ts)
  it('fails a signature made by another key under the expected kid once the verifier refuses it', async () => {
    const intruder = p256.utils.randomSecretKey();
    const forged = await signAgentCard(baseCard(), { alg: 'ES256', kid: 'p256-1' }, (input) => p256.sign(input, intruder));
    expect((await verifyAgentCardSignatures({ ...baseCard(), signatures: [forged] }, verify)).state).toBe('invalid');
    const genuine = await signAgentCard(baseCard(), { alg: 'ES256', kid: 'p256-1' }, (input) => p256.sign(input, p256Secret));
    expect((await verifyAgentCardSignatures({ ...baseCard(), signatures: [genuine] }, verify)).state).toBe('verified');
  });

  // Plan A72
  it('keeps the pin across real randomized ES256 re-signs, and moves it on a new key, a lost signature or new content', async () => {
    const otherSecret = p256.utils.randomSecretKey();
    const otherPublic = p256.getPublicKey(otherSecret);
    const byThumbprint: JwsVerifyFn = ({ header, signingInputs, signature }): JwsVerdict => {
      const by = (key: Uint8Array) => signingInputs.some((input) => p256.verify(signature, input, key));
      if (header.kid === 'p256-1' && by(p256Public)) return { signer: 'thumb-1' };
      if (header.kid === 'p256-2' && by(otherPublic)) return { signer: 'thumb-2' };
      return false;
    };
    const pinOf = async (card: Record<string, unknown>) =>
      cardPinText(card, (await verifyAgentCardSignatures(card, byThumbprint)).verifiedSigners);
    const reSign = (content: Record<string, unknown>, kid: string, secret: Uint8Array) =>
      signAgentCard(content, { alg: 'ES256', kid }, (input) => p256.sign(input, secret, { extraEntropy: true }));

    const first = await reSign(baseCard(), 'p256-1', p256Secret);
    const second = await reSign(baseCard(), 'p256-1', p256Secret);
    expect(first.signature).not.toBe(second.signature);
    const pinned = await pinOf({ ...baseCard(), signatures: [first] });
    expect(await pinOf({ ...baseCard(), signatures: [second] })).toBe(pinned);

    const newKey = await reSign(baseCard(), 'p256-2', otherSecret);
    expect(await pinOf({ ...baseCard(), signatures: [newKey] })).not.toBe(pinned);
    expect(await pinOf(baseCard())).not.toBe(pinned);
    const changed = { ...baseCard(), description: 'Does other things' };
    expect(await pinOf({ ...changed, signatures: [await reSign(changed, 'p256-1', p256Secret)] })).not.toBe(pinned);
  });
});

// ---------------------------------------------------------------------------
// A.8 Card projection
// ---------------------------------------------------------------------------

describe('card projection: commerce and examples', () => {
  // Plan A93
  it('leaves commerce off the card when a listing names it by an alias (plan D2, §3.6)', () => {
    const alias = cap({ capability: 'quote_please', canonical: 'com.dinakernel.commerce.request_quote' });
    const pub = listing({ capabilities: [alias] });
    expect(exclusionReason(pub, alias)).toBe('commerce_capability');
    expect(projectAgentCard(projectionInput([pub]))).toEqual({ ok: false, reason: 'no_projectable_skills' });
    // A grant on a known_only listing opens no commerce skill either.
    const known = listing({ discoverability: 'known_only', capabilities: [alias] });
    expect(exclusionReason(known, alias, 'granted')).toBe('commerce_capability');
    const extended = projectAgentCard({
      ...projectionInput([known]),
      audience: { scope: [], grants: [{ grantId: 'g-1', rkey: 'self', capability: 'quote_please' }] },
    });
    expect(extended).toEqual({ ok: false, reason: 'no_projectable_skills' });
  });

  // Plan A104
  it('writes each example as the RFC 8785 text of its call, on the public and the extended card', () => {
    const pub = projectAgentCard(projectionInput([listing()]));
    const ext = projectAgentCard({ ...projectionInput([listing()]), audience: { scope: [], grants: [] } });
    for (const out of [pub, ext]) {
      if (!out.ok) throw new Error(out.reason);
      const example = out.card.skills[0]?.examples?.[0];
      if (example === undefined) throw new Error('expected an example');
      expect(example).toBe(canonicalize(JSON.parse(example)));
    }
  });
});

// ---------------------------------------------------------------------------
// A.9 Invocation envelope and skill names
// ---------------------------------------------------------------------------

describe('invocation envelope: prototype names and bounded selectors', () => {
  // Plan A126
  it('treats params named after Object.prototype members as plain data', () => {
    const params = JSON.parse('{"constructor":"c","toString":1,"hasOwnProperty":true,"valueOf":{}}') as JsonObject;
    const parsed = parseInvocationEnvelope([{ data: { skill: 'eta_query@self', params } }]);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.envelope.params).toEqual({ constructor: 'c', toString: 1, hasOwnProperty: true, valueOf: {} });
    expect(envelopeObject(parsed.envelope)).toEqual({ skill: 'eta_query@self', params });
  });

  // Plan A126
  it('refuses an envelope member named after an Object.prototype member as unknown', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(parseEnvelopeData({ skill: 'eta_query', params: {}, [name]: 'x' })).toEqual({
        ok: false,
        reason: 'unknown_envelope_member',
      });
    }
  });

  // Plan A122
  it('refuses a top-level __proto__ member of the envelope', () => {
    const data = JSON.parse('{"skill":"eta_query","params":{},"__proto__":{"grant_id":"g-1"}}') as unknown;
    expect(parseEnvelopeData(data)).toEqual({ ok: false, reason: 'unknown_envelope_member' });
  });

  // Plan A124
  it.each([
    ['an empty grant id', { grant_id: '' }, 'grant_id_malformed'],
    ['a grant id past 256 characters', { grant_id: 'g'.repeat(257) }, 'grant_id_malformed'],
    ['a grant id that is not text', { grant_id: 7 }, 'grant_id_malformed'],
    ['an empty schema hash', { schema_hash: '' }, 'schema_hash_malformed'],
    ['a schema hash one digit short', { schema_hash: 'a'.repeat(63) }, 'schema_hash_malformed'],
  ])('refuses %s', (_name, extra, reason) => {
    expect(parseEnvelopeData({ skill: 'eta_query', params: {}, ...extra })).toEqual({ ok: false, reason });
  });

  // Plan A124
  it('accepts a grant id of exactly 256 characters', () => {
    const parsed = parseEnvelopeData({ skill: 'eta_query', params: {}, grant_id: 'g'.repeat(256) });
    expect(parsed.ok && parsed.envelope.grantId).toBe('g'.repeat(256));
  });

  // Plan A129
  it.each(['eta_query@a:b', 'eta_query@.', 'eta_query@..', 'eta_query@a/b', 'eta_query@a b', `eta_query@${'k'.repeat(513)}`])(
    'refuses the skill name %p: its listing key fails Dina’s listing-rkey grammar (@dina/protocol)',
    (raw) => {
      expect(parseQualifiedSkill(raw)).toBeNull();
    },
  );

  // Plan A129
  it.each(['eta_query@self', 'eta_query@Az09._~-', 'eta_query@...', `eta_query@${'k'.repeat(512)}`])(
    'accepts the skill name %p: its listing key fits the grammar',
    (raw) => {
      const at = raw.indexOf('@');
      expect(parseQualifiedSkill(raw)).toEqual({ capability: raw.slice(0, at), rkey: raw.slice(at + 1) });
    },
  );
});

// ---------------------------------------------------------------------------
// A.10 State maps
// ---------------------------------------------------------------------------

describe('state maps, row by row', () => {
  // Plan A134
  it('reads a pending workflow task as SUBMITTED (design §7.4)', () => {
    expect(WORKFLOW_TO_A2A.pending).toEqual({ state: 'TASK_STATE_SUBMITTED' });
    expect(inboundView('pending')).toEqual({ state: 'TASK_STATE_SUBMITTED' });
  });

  // Plan A139
  it.each([
    ['TASK_STATE_SUBMITTED', { kind: 'running' }],
    ['TASK_STATE_WORKING', { kind: 'running' }],
    ['TASK_STATE_COMPLETED', { kind: 'completed' }],
    ['TASK_STATE_FAILED', { kind: 'fail', reason: 'remote_failed' }],
    ['TASK_STATE_REJECTED', { kind: 'fail', reason: 'remote_rejected' }],
    ['TASK_STATE_CANCELED', { kind: 'cancelled' }],
  ] as const)('outbound, a remote %s means %j (design §6.4)', (state, disposition) => {
    expect(A2A_TO_OUTBOUND[state]).toEqual(disposition);
    expect(outboundDisposition(state)).toEqual(disposition);
  });
});

// ---------------------------------------------------------------------------
// A.11 Result sanitation
// ---------------------------------------------------------------------------

describe('result sanitation never throws (design §6.5)', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const throwingGetter = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });

  // Plan A151
  it.each([
    ['a bigint', [{ data: { n: 1n } }]],
    ['a cycle', [{ data: cycle }]],
    ['a Date', [{ data: { at: new Date(0) } }]],
    ['a Map', [{ data: { m: new Map([['a', 1]]) } }]],
    ['NaN', [{ data: { n: Number.NaN } }]],
    ['Infinity', [{ data: { n: Number.POSITIVE_INFINITY } }]],
    ['undefined data', [{ data: undefined }]],
    ['a function', [{ data: { f: () => 1 } }]],
    ['a symbol', [{ data: { s: Symbol('s') } }]],
    ['a getter that throws', [{ data: throwingGetter }]],
    ['a null part', [null]],
    ['text that is not a string', [{ text: 5 }]],
    ['parts that are not a list', 'text'],
    ['no parts at all', undefined],
  ])('refuses %s with a reason and does not throw', (_name, parts) => {
    expect(() => sanitizeRemoteParts(parts)).not.toThrow();
    const out = sanitizeRemoteParts(parts);
    expect(out.ok).toBe(false);
    expect(!out.ok && typeof out.reason).toBe('string');
  });

  // Plan A147
  it('leaves text of exactly the cap whole and unflagged, and never cuts strings inside data', () => {
    // One astral character at the end: the cap counts code points, not UTF-16 units.
    const exact = `${'a'.repeat(A2A_LIMITS.maxTextCodePoints - 1)}😀`;
    const atCap = sanitizeRemoteParts([{ text: exact }]);
    if (!atCap.ok) throw new Error(atCap.reason);
    expect(atCap.result.truncated).toBe(false);
    expect((atCap.result.envelope.parts[0] as { text: string }).text).toBe(exact);
    const long = 'x'.repeat(A2A_LIMITS.maxTextCodePoints + 1000);
    const data = sanitizeRemoteParts([{ data: { s: long } }]);
    if (!data.ok) throw new Error(data.reason);
    expect(data.result.truncated).toBe(false);
    expect(data.result.envelope.parts[0]).toEqual({ data: { s: long } });
  });
});

// ---------------------------------------------------------------------------
// A.12 Delivery wire
// ---------------------------------------------------------------------------

describe('delivery claims are dropped whole when malformed (design §7.5)', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: 1,
    claim_id: 'c_1',
    target: 'sse',
    task_id: 't',
    seq: 1,
    event: { statusUpdate: { taskId: 't', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } },
    credential_gen: 0,
    ...over,
  });

  // Plan A166
  it('reads the base claim the cases below start from', () => {
    expect(parseDeliveryClaim({ items: [item()], closed: [], fenced: [] })).not.toBeNull();
    expect(parseDeliveryClaim({ items: [item()], closed: ['t'], fenced: [{ client: 'f'.repeat(32), before_gen: 1 }] })).not.toBeNull();
  });

  // Plan A166
  it.each([
    ['an event with a member beside its payload', { items: [item({ event: { ...item().event, extra: 1 } })], closed: [], fenced: [] }],
    ['closed tasks that are not a list', { items: [item()], closed: 't', fenced: [] }],
    ['fences that are not a list', { items: [item()], closed: [], fenced: { client: 'f'.repeat(32), before_gen: 1 } }],
    ['items that are not a list', { items: item(), closed: [], fenced: [] }],
    ['a zero sequence number', { items: [item({ seq: 0 })], closed: [], fenced: [] }],
  ])('drops a claim with %s', (_name, value) => {
    expect(parseDeliveryClaim(value)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A.13 REST errors
// ---------------------------------------------------------------------------

describe('REST errors follow A2A’s mapping (spec §5.4, §11.6)', () => {
  // Plan A178
  it.each([
    ['taskNotFound', 404, 'NOT_FOUND', 'TASK_NOT_FOUND'],
    ['taskNotCancelable', 400, 'FAILED_PRECONDITION', 'TASK_NOT_CANCELABLE'],
    ['pushNotificationNotSupported', 400, 'FAILED_PRECONDITION', 'PUSH_NOTIFICATION_NOT_SUPPORTED'],
    ['unsupportedOperation', 400, 'FAILED_PRECONDITION', 'UNSUPPORTED_OPERATION'],
    ['contentTypeNotSupported', 400, 'INVALID_ARGUMENT', 'CONTENT_TYPE_NOT_SUPPORTED'],
    ['invalidAgentResponse', 500, 'INTERNAL', 'INVALID_AGENT_RESPONSE'],
    ['extendedAgentCardNotConfigured', 400, 'FAILED_PRECONDITION', 'EXTENDED_AGENT_CARD_NOT_CONFIGURED'],
    ['extensionSupportRequired', 400, 'FAILED_PRECONDITION', 'EXTENSION_SUPPORT_REQUIRED'],
    ['versionNotSupported', 400, 'FAILED_PRECONDITION', 'VERSION_NOT_SUPPORTED'],
  ] as const)('%s answers %i %s with A2A’s reason %s first', (kind, http, status, reason) => {
    const out = restError(a2aError(kind));
    expect(out.status).toBe(http);
    expect(out.body).toEqual({
      error: {
        code: http,
        status,
        message: a2aError(kind).message,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org', metadata: {} }],
      },
    });
  });

  // Plan A178
  it('answers a code A2A does not map as 500 INTERNAL, keeping its message', () => {
    const out = restError({ code: -32099, message: 'odd' });
    expect(out.status).toBe(500);
    expect(out.body.error).toMatchObject({ code: 500, status: 'INTERNAL', message: 'odd' });
  });
});

// ---------------------------------------------------------------------------
// A.14 DID binding wire
// ---------------------------------------------------------------------------

describe('DID binding: nothing can add a line to the signing input', () => {
  const CHALLENGE = `dch_${'A'.repeat(43)}`;
  const SIG = 'ab'.repeat(64);

  // Plan A182
  it.each([
    ['a DID ending in a newline', 'did:plc:abc\n', CHALLENGE],
    ['a DID with a newline inside', 'did:plc:abc\nevil', CHALLENGE],
    ['a DID ending in a carriage return', 'did:plc:abc\r', CHALLENGE],
    ['a challenge ending in a newline', 'did:plc:abc', `${CHALLENGE}\n`],
    ['a challenge with a newline inside', 'did:plc:abc', `dch_${'A'.repeat(21)}\n${'A'.repeat(21)}`],
  ])('refuses %s', (_name, did, challenge) => {
    expect(parseDidBindingRequest(JSON.stringify({ did, challenge, signature: SIG }))).toBeNull();
  });

  // Plan A182
  it.each([
    ['did:plc', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', CHALLENGE],
    ['did:web with a port', 'did:web:a.example%3A8443', CHALLENGE],
    ['did:web with a path', 'did:web:a.example:users:alice', CHALLENGE],
    ['did:key', `did:key:${ed25519Multikey(ed25519.getPublicKey(new Uint8Array(32).fill(5)))}`, CHALLENGE],
    ['a challenge using - and _', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', `dch_${'-_'.repeat(21)}A`],
    // The DID and challenge the refusals above start from, accepted as they are.
    ['the DID the refusals start from', 'did:plc:abc', CHALLENGE],
  ])('builds a five-line signing input from an accepted request: %s', (_name, did, challenge) => {
    const req = parseDidBindingRequest(JSON.stringify({ did, challenge, signature: SIG }));
    if (req === null) throw new Error('expected a request');
    const lines = didBindingSigningInput({ nodeDid: 'did:plc:n', clientId: 'ac_1', did: req.did, challenge: req.challenge }).split('\n');
    expect(lines).toEqual([DID_BINDING_DOMAIN, 'did:plc:n', 'ac_1', did, challenge]);
  });
});

// ---------------------------------------------------------------------------
// A.15 Directory envelope vectors
// ---------------------------------------------------------------------------

describe('directory envelope vectors', () => {
  const V = JSON.parse(readFileSync(join(__dirname, '..', 'conformance', 'vectors', 'directory_envelope.json'), 'utf8')) as {
    envelope: { value: Record<string, unknown>; signing_text: string };
    signing_text_sha256: string;
  };

  // Plan A186
  it('signs the RFC 8785 text of the envelope without sig, whose sha256 is frozen for other runtimes', () => {
    const { sig: _sig, ...unsigned } = V.envelope.value;
    expect(canonicalize(unsigned)).toBe(V.envelope.signing_text);
    expect(bytesToHex(sha256(utf8Bytes(V.envelope.signing_text)))).toBe(V.signing_text_sha256);
  });
});

// ---------------------------------------------------------------------------
// A.16 Multikeys
// ---------------------------------------------------------------------------

describe('multikeys refuse near misses', () => {
  const edKey = ed25519.getPublicKey(new Uint8Array(32).fill(7));
  const pKey = p256.getPublicKey(new Uint8Array(32).fill(9), true);
  const multibase = (bytes: number[]) => `z${base58btcEncode(Uint8Array.from(bytes))}`;

  // Plan A199
  it('refuses a key with an extra leading 1 (a zero byte before the prefix)', () => {
    const ed = ed25519Multikey(edKey);
    const pp = p256Multikey(pKey);
    expect(ed25519FromMultikey(`z1${ed.slice(1)}`)).toBeNull();
    expect(p256FromMultikey(`z1${pp.slice(1)}`)).toBeNull();
    expect(base58btcDecode(`1${ed.slice(1)}`)?.[0]).toBe(0);
  });

  // Plan A199
  it('refuses a P-256 point that is not compressed, and an Ed25519 key of 33 bytes', () => {
    const uncompressedPrefix = [0x80, 0x24, 0x04, ...pKey.slice(1)];
    expect(p256FromMultikey(multibase(uncompressedPrefix))).toBeNull();
    expect(() => p256Multikey(Uint8Array.from([0x04, ...pKey.slice(1)]))).toThrow();
    expect(ed25519FromMultikey(multibase([0xed, 0x01, ...edKey, 0]))).toBeNull();
    expect(() => ed25519Multikey(Uint8Array.from([...edKey, 0]))).toThrow();
    // The genuine forms still read.
    expect(p256FromMultikey(multibase([0x80, 0x24, ...pKey]))).toEqual(pKey);
    expect(ed25519FromMultikey(multibase([0xed, 0x01, ...edKey]))).toEqual(edKey);
  });
});

// ---------------------------------------------------------------------------
// A.17 Ids
// ---------------------------------------------------------------------------

describe('external ids are fresh lower-case UUIDv4s (A2A-I5)', () => {
  // Plan A205
  it('refuses an upper-case UUID, and leaves the random bytes it was given untouched', () => {
    const random = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
    const copy = random.slice();
    const id = uuidV4FromBytes(random);
    expect(random).toEqual(copy);
    expect(isUuidV4(id)).toBe(true);
    expect(isUuidV4(id.toUpperCase())).toBe(false);
    expect(id[14]).toBe('4');
    expect('89ab').toContain(id[19] ?? '');
    expect(uuidV4FromBytes(Uint8Array.from({ length: 16 }, (_, i) => i * 13))).not.toBe(id);
  });
});

// ---------------------------------------------------------------------------
// A.17 Codecs
// ---------------------------------------------------------------------------

describe('base64 and base64url: one spelling per byte string (design §8.2)', () => {
  const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const same = (a: Uint8Array | null, b: Uint8Array): boolean => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

  // Plan A206
  it.each([
    ['base64url', base64urlEncode, base64urlDecode, URL_ALPHABET],
    ['base64', base64Encode, base64Decode, STD_ALPHABET],
  ] as const)('%s: of the 64 characters that could end the text, only the canonical one decodes to the same bytes', (_name, encode, decode, alphabet) => {
    for (const bytes of [Uint8Array.of(0xab), Uint8Array.of(0xab, 0xcd), Uint8Array.of(1, 2, 3, 0xff)]) {
      const text = encode(bytes);
      const unpadded = text.replace(/=+$/, '');
      const padding = text.slice(unpadded.length);
      const last = unpadded.length - 1;
      const spellings = [...alphabet]
        .map((c) => `${unpadded.slice(0, last)}${c}${padding}`)
        .filter((t) => same(decode(t), bytes));
      expect(spellings).toEqual([text]);
    }
  });

  // Plan A206
  it.each([
    ['a trailing newline', 'AQID\n'],
    ['a leading space', ' AQID'],
    ['a space inside', 'AQ ID'],
    ['a MIME line break', 'AQ\r\nID'],
    ['a newline after the padding', 'AQ==\n'],
    ['padding alone', '===='],
  ])('base64 refuses %s', (_name, text) => {
    expect(base64Decode(text)).toBeNull();
  });
});
