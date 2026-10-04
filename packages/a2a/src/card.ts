/**
 * Agent Card canonical form (spec §8.4.1, §5.7).
 *
 * A card is signed over RFC 8785 JCS of the card with `signatures` removed
 * and default values stripped by proto field-presence rules:
 *  - a REQUIRED field is always kept, even at its default;
 *  - an `optional` scalar is kept when present (it was explicitly set);
 *  - any other scalar is dropped at its default (`''`, `false`, `0`);
 *  - a repeated or map field that is not REQUIRED is dropped when empty;
 *  - a message field is kept when present, its own members stripped by the
 *    same rules.
 *
 * A REQUIRED field a ProtoJSON emitter left out (it omits default values)
 * is put back at its default, and a member whose value is `null` (ProtoJSON's
 * "unset") is dropped, so a card re-serialized by a proto-based stack
 * canonicalizes to the same bytes.
 *
 * Members the table does not know are kept verbatim. A newer minor version
 * may add fields; stripping or rewriting them would break the signature of
 * a card that is perfectly valid. `google.protobuf.Struct` contents (extension
 * params, signature headers) are opaque JSON and are never stripped inside.
 *
 * The table follows `specification/a2a.proto` (v1.0.1) field by field.
 *
 * The reference SDK signs another form ({@link cardSdkSigningPayload}); a
 * card's two forms differ when it holds an empty value or a member the proto
 * does not know, so Dina verifies a signature over either and signs its own
 * card over both when they differ (design §6.6).
 *
 * A card carrying a `__proto__` member, or nested deeper than the JSON depth
 * cap, has no canonical form here: these functions throw `CardFormError`.
 */

import { A2A_LIMITS } from './constants';
import { canonicalize } from './jcs';
import { bytesToHex, isPlainObject, type JsonObject, type JsonValue } from './json';
import { untrustedJsonProblem } from './strict_json';

export class CardFormError extends Error {
  constructor(readonly reason: 'forbidden_member' | 'too_deep') {
    super(`card: ${reason}`);
    this.name = 'CardFormError';
  }
}

type FieldRule =
  /** A REQUIRED string: kept even when empty, put back as `''` when absent. */
  | { kind: 'required' }
  | { kind: 'optional' }
  | { kind: 'scalar' }
  | { kind: 'repeated'; of?: MessageRule; required?: boolean }
  | { kind: 'map'; of?: MessageRule; required?: boolean }
  | { kind: 'message'; rule: MessageRule; required?: boolean }
  | { kind: 'struct' };

type MessageRule = Readonly<Record<string, FieldRule>>;

const REQUIRED: FieldRule = { kind: 'required' };
const OPTIONAL: FieldRule = { kind: 'optional' };
const SCALAR: FieldRule = { kind: 'scalar' };
const STRUCT: FieldRule = { kind: 'struct' };

const STRING_LIST: MessageRule = { list: { kind: 'repeated' } };
const SECURITY_REQUIREMENT: MessageRule = { schemes: { kind: 'map', of: STRING_LIST } };

const AUTH_CODE_FLOW: MessageRule = {
  authorizationUrl: REQUIRED,
  tokenUrl: REQUIRED,
  refreshUrl: SCALAR,
  scopes: { kind: 'map', required: true },
  pkceRequired: SCALAR,
};
const CLIENT_CREDENTIALS_FLOW: MessageRule = {
  tokenUrl: REQUIRED,
  refreshUrl: SCALAR,
  scopes: { kind: 'map', required: true },
};
const IMPLICIT_FLOW: MessageRule = {
  authorizationUrl: SCALAR,
  refreshUrl: SCALAR,
  scopes: { kind: 'map' },
};
const PASSWORD_FLOW: MessageRule = {
  tokenUrl: SCALAR,
  refreshUrl: SCALAR,
  scopes: { kind: 'map' },
};
const DEVICE_CODE_FLOW: MessageRule = {
  deviceAuthorizationUrl: REQUIRED,
  tokenUrl: REQUIRED,
  refreshUrl: SCALAR,
  scopes: { kind: 'map', required: true },
};
const OAUTH_FLOWS: MessageRule = {
  authorizationCode: { kind: 'message', rule: AUTH_CODE_FLOW },
  clientCredentials: { kind: 'message', rule: CLIENT_CREDENTIALS_FLOW },
  implicit: { kind: 'message', rule: IMPLICIT_FLOW },
  password: { kind: 'message', rule: PASSWORD_FLOW },
  deviceCode: { kind: 'message', rule: DEVICE_CODE_FLOW },
};
const SECURITY_SCHEME: MessageRule = {
  apiKeySecurityScheme: {
    kind: 'message',
    rule: { description: SCALAR, location: REQUIRED, name: REQUIRED },
  },
  httpAuthSecurityScheme: {
    kind: 'message',
    rule: { description: SCALAR, scheme: REQUIRED, bearerFormat: SCALAR },
  },
  oauth2SecurityScheme: {
    kind: 'message',
    rule: {
      description: SCALAR,
      flows: { kind: 'message', rule: OAUTH_FLOWS, required: true },
      oauth2MetadataUrl: SCALAR,
    },
  },
  openIdConnectSecurityScheme: {
    kind: 'message',
    rule: { description: SCALAR, openIdConnectUrl: REQUIRED },
  },
  mtlsSecurityScheme: { kind: 'message', rule: { description: SCALAR } },
};

const AGENT_INTERFACE: MessageRule = {
  url: REQUIRED,
  protocolBinding: REQUIRED,
  tenant: SCALAR,
  protocolVersion: REQUIRED,
};
const AGENT_PROVIDER: MessageRule = { url: REQUIRED, organization: REQUIRED };
const AGENT_EXTENSION: MessageRule = {
  uri: SCALAR,
  description: SCALAR,
  required: SCALAR,
  params: STRUCT,
};
const AGENT_CAPABILITIES: MessageRule = {
  streaming: OPTIONAL,
  pushNotifications: OPTIONAL,
  extensions: { kind: 'repeated', of: AGENT_EXTENSION },
  extendedAgentCard: OPTIONAL,
};
const AGENT_SKILL: MessageRule = {
  id: REQUIRED,
  name: REQUIRED,
  description: REQUIRED,
  tags: { kind: 'repeated', required: true },
  examples: { kind: 'repeated' },
  inputModes: { kind: 'repeated' },
  outputModes: { kind: 'repeated' },
  securityRequirements: { kind: 'repeated', of: SECURITY_REQUIREMENT },
};
const AGENT_CARD: MessageRule = {
  name: REQUIRED,
  description: REQUIRED,
  supportedInterfaces: { kind: 'repeated', of: AGENT_INTERFACE, required: true },
  provider: { kind: 'message', rule: AGENT_PROVIDER },
  version: REQUIRED,
  documentationUrl: OPTIONAL,
  capabilities: { kind: 'message', rule: AGENT_CAPABILITIES, required: true },
  securitySchemes: { kind: 'map', of: SECURITY_SCHEME },
  securityRequirements: { kind: 'repeated', of: SECURITY_REQUIREMENT },
  defaultInputModes: { kind: 'repeated', required: true },
  defaultOutputModes: { kind: 'repeated', required: true },
  skills: { kind: 'repeated', of: AGENT_SKILL, required: true },
  signatures: { kind: 'repeated' },
  iconUrl: OPTIONAL,
};

function isDefaultScalar(value: unknown): boolean {
  return value === '' || value === false || value === 0;
}

/** What a pass does with a member the table does not know: §8.4.1 keeps it; a proto parser drops it. */
type UnknownMembers = 'keep' | 'drop';

function stripMessage(
  value: Record<string, unknown>,
  rule: MessageRule,
  unknown: UnknownMembers = 'keep',
): JsonObject {
  const out: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    // ProtoJSON writes `null` for an unset field; absent and null are one state.
    if (member === undefined || member === null) continue;
    const field = Object.prototype.hasOwnProperty.call(rule, key) ? rule[key] : undefined;
    if (field === undefined) {
      if (unknown === 'keep') out[key] = member as JsonValue;
      continue;
    }
    const kept = stripField(member, field, unknown);
    if (kept !== undefined) out[key] = kept;
  }
  for (const [key, field] of Object.entries(rule)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    const restored = requiredDefault(field);
    if (restored !== undefined) out[key] = restored;
  }
  return out;
}

/** The value a REQUIRED field takes when an emitter left it out; undefined when not REQUIRED. */
function requiredDefault(field: FieldRule): JsonValue | undefined {
  switch (field.kind) {
    case 'required':
      return '';
    case 'repeated':
      return field.required === true ? [] : undefined;
    case 'map':
      return field.required === true ? {} : undefined;
    case 'message':
      return field.required === true ? stripMessage({}, field.rule) : undefined;
    default:
      return undefined;
  }
}

function stripField(value: unknown, field: FieldRule, unknown: UnknownMembers): JsonValue | undefined {
  switch (field.kind) {
    case 'required':
    case 'optional':
    case 'struct':
      return value as JsonValue;
    case 'scalar':
      return isDefaultScalar(value) ? undefined : (value as JsonValue);
    case 'message':
      return isPlainObject(value) ? stripMessage(value, field.rule, unknown) : (value as JsonValue);
    case 'repeated': {
      if (!Array.isArray(value)) return value as JsonValue;
      if (value.length === 0 && field.required !== true) return undefined;
      const of = field.of;
      return of === undefined
        ? (value as JsonValue[])
        : value.map((item) =>
            isPlainObject(item) ? stripMessage(item, of, unknown) : (item as JsonValue),
          );
    }
    case 'map': {
      if (!isPlainObject(value)) return value as JsonValue;
      const entries = Object.entries(value);
      if (entries.length === 0 && field.required !== true) return undefined;
      const of = field.of;
      if (of === undefined) return value as JsonObject;
      const out: JsonObject = {};
      for (const [k, v] of entries)
        out[k] = isPlainObject(v) ? stripMessage(v, of, unknown) : (v as JsonValue);
      return out;
    }
  }
}

function assertCardForm(card: Record<string, unknown>): void {
  const problem = untrustedJsonProblem(card, A2A_LIMITS.maxJsonDepth);
  if (problem !== null) throw new CardFormError(problem);
}

/** The card with default values stripped and `signatures` removed. */
export function cardSigningContent(card: Record<string, unknown>): JsonObject {
  assertCardForm(card);
  const { signatures: _signatures, ...rest } = card;
  return stripMessage(rest, AGENT_CARD);
}

/** RFC 8785 bytes a card signature covers (the JWS payload, before base64url). */
export function cardSigningPayload(card: Record<string, unknown>): string {
  return canonicalize(cardSigningContent(card));
}

/**
 * The payload the reference SDK signs and verifies (a2a-sdk 1.2.1,
 * `a2a.utils.signing`): the card read into the proto, so a member the proto
 * does not know is dropped at every level; printed back by ProtoJSON with
 * `signatures` removed; then every empty string, list and object, and every
 * null, removed at any depth, REQUIRED fields and Struct contents included.
 *
 * It departs from §8.4.1, which keeps a REQUIRED field at its default and an
 * unknown member as written. The two forms of one card differ when it holds
 * an empty value (a scope-less security requirement, `{"bearer": {}}`, which
 * every bearer card carries) or a member the proto does not know (the
 * `url`, `preferredTransport` and `protocolVersion` a dual-version SDK card
 * adds for v0.3 clients). The SDK form covers less: a signature over it
 * vouches for none of the card's empty values and unknown members. The pin
 * still covers them ({@link cardPinText} hashes the §8.4.1 content), so a
 * change to either re-gates the owner's review.
 */
export function cardSdkSigningPayload(card: Record<string, unknown>): string {
  assertCardForm(card);
  const { signatures: _signatures, ...rest } = card;
  return canonicalize(withoutEmpties(stripMessage(rest, AGENT_CARD, 'drop')) ?? null);
}

/** The SDK's `_clean_empty`: `''`, `[]`, `{}` and `null` go at any depth; undefined when nothing is left. */
function withoutEmpties(value: JsonValue): JsonValue | undefined {
  if (value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const kept = value.flatMap((item) => {
      const cleaned = withoutEmpties(item);
      return cleaned === undefined ? [] : [cleaned];
    });
    return kept.length === 0 ? undefined : kept;
  }
  if (!isPlainObject(value)) return value;
  const kept: JsonObject = {};
  for (const [key, member] of Object.entries(value)) {
    const cleaned = withoutEmpties(member);
    if (cleaned !== undefined) kept[key] = cleaned;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** The forms a card signature may cover: §8.4.1, and the reference SDK's. */
export type CardSigningForm = 'spec' | 'a2a_sdk';

/** The payload of one form. */
export function cardFormPayload(card: Record<string, unknown>, form: CardSigningForm): string {
  return form === 'spec' ? cardSigningPayload(card) : cardSdkSigningPayload(card);
}

/** The forms a signer covers so that both kinds of verifier accept the card: one when they coincide. */
export function cardSigningForms(card: Record<string, unknown>): CardSigningForm[] {
  return cardSigningPayload(card) === cardSdkSigningPayload(card) ? ['spec'] : ['spec', 'a2a_sdk'];
}

/**
 * The canonical text a registration pins (design §6.1): the signed content
 * plus the identities of the keys that verified a signature on it, sorted.
 *
 * Signature BYTES are left out on purpose. ECDSA signatures are randomized,
 * so a publisher that re-signs unchanged content on every restart would
 * otherwise look like a changed card and void the owner's bindings each
 * time. What should re-gate the owner is a change in content or in who
 * vouches for it: a new key, a lost signature, a signature that stops
 * verifying. Each of those changes this text.
 */
export function cardPinText(
  card: Record<string, unknown>,
  verifiedSigners: readonly string[],
): string {
  const signers = [...new Set(verifiedSigners)].sort();
  return canonicalize({ content: cardSigningContent(card), signers });
}

/** Lowercase sha256 hex of {@link cardPinText}. `sha256` is injected; this package has no crypto. */
export function cardPinHash(
  card: Record<string, unknown>,
  verifiedSigners: readonly string[],
  sha256: (bytes: Uint8Array) => Uint8Array,
): string {
  return bytesToHex(sha256(new TextEncoder().encode(cardPinText(card, verifiedSigners))));
}
