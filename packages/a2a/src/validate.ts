/**
 * Structural validators for the v1.0 shapes Dina receives from peers.
 * Each returns `null` when valid, or a short reason (never peer content).
 *
 * Required fields follow `field_behavior = REQUIRED` in the proto, and a
 * required repeated field needs at least one element (spec §5.7). Unknown
 * members are allowed (spec §5.7: ignore unrecognized fields). Strings that
 * carry identifiers are bounded so a peer cannot hand Dina a megabyte id.
 */

import { hasOwn, isPlainObject } from './json';
import { untrustedJsonProblem } from './strict_json';
import { ROLES, TASK_STATES, type TaskState } from './types';

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const STATE_SET: ReadonlySet<string> = new Set(TASK_STATES);

export const MAX_ID_LENGTH = 256;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function optionalString(obj: Record<string, unknown>, key: string): boolean {
  return !hasOwn(obj, key) || typeof obj[key] === 'string';
}

function optionalObject(obj: Record<string, unknown>, key: string): boolean {
  return !hasOwn(obj, key) || isPlainObject(obj[key]);
}

function optionalStringArray(obj: Record<string, unknown>, key: string): boolean {
  if (!hasOwn(obj, key)) return true;
  const v = obj[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function requiredStringArray(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && STATE_SET.has(value);
}

const PART_CONTENT_KEYS = ['text', 'raw', 'url', 'data'] as const;

/** Which `Part.content` branch is set, or `null` when not exactly one. */
export function partContentKind(
  part: Record<string, unknown>,
): (typeof PART_CONTENT_KEYS)[number] | null {
  const present = PART_CONTENT_KEYS.filter((k) => hasOwn(part, k));
  return present.length === 1 ? (present[0] ?? null) : null;
}

export function validatePart(value: unknown): string | null {
  if (!isPlainObject(value)) return 'part_not_object';
  const kind = partContentKind(value);
  if (kind === null) return 'part_content_not_exactly_one';
  if (kind === 'text' && typeof value.text !== 'string') return 'part_text_not_string';
  if (kind === 'raw' && typeof value.raw !== 'string') return 'part_raw_not_string';
  if (kind === 'url' && typeof value.url !== 'string') return 'part_url_not_string';
  if (!optionalObject(value, 'metadata')) return 'part_metadata_not_object';
  if (!optionalString(value, 'filename')) return 'part_filename_not_string';
  if (!optionalString(value, 'mediaType')) return 'part_media_type_not_string';
  return null;
}

function validateParts(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return 'parts_required';
  for (const part of value) {
    const err = validatePart(part);
    if (err !== null) return err;
  }
  return null;
}

export function validateMessage(value: unknown): string | null {
  if (!isPlainObject(value)) return 'message_not_object';
  if (!isId(value.messageId)) return 'message_id_invalid';
  if (
    typeof value.role !== 'string' ||
    !ROLE_SET.has(value.role) ||
    value.role === 'ROLE_UNSPECIFIED'
  ) {
    return 'message_role_invalid';
  }
  const partsErr = validateParts(value.parts);
  if (partsErr !== null) return partsErr;
  if (hasOwn(value, 'contextId') && !isId(value.contextId)) return 'message_context_id_invalid';
  if (hasOwn(value, 'taskId') && !isId(value.taskId)) return 'message_task_id_invalid';
  if (!optionalObject(value, 'metadata')) return 'message_metadata_not_object';
  if (!optionalStringArray(value, 'extensions')) return 'message_extensions_invalid';
  if (!optionalStringArray(value, 'referenceTaskIds')) return 'message_reference_task_ids_invalid';
  return null;
}

/** ISO 8601 UTC with `Z` (spec §5.6.1), optional fraction; a real calendar instant. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  // Reject impossible dates that Date.parse rolls over (e.g. 2026-02-30).
  return new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

export function validateTaskStatus(value: unknown): string | null {
  if (!isPlainObject(value)) return 'status_not_object';
  if (!isTaskState(value.state)) return 'status_state_invalid';
  if (hasOwn(value, 'message')) {
    const err = validateMessage(value.message);
    if (err !== null) return `status_${err}`;
  }
  if (hasOwn(value, 'timestamp') && !isIsoUtcTimestamp(value.timestamp)) {
    return 'status_timestamp_invalid';
  }
  return null;
}

export function validateArtifact(value: unknown): string | null {
  if (!isPlainObject(value)) return 'artifact_not_object';
  if (!isId(value.artifactId)) return 'artifact_id_invalid';
  if (!optionalString(value, 'name')) return 'artifact_name_not_string';
  if (!optionalString(value, 'description')) return 'artifact_description_not_string';
  const partsErr = validateParts(value.parts);
  if (partsErr !== null) return `artifact_${partsErr}`;
  if (!optionalObject(value, 'metadata')) return 'artifact_metadata_not_object';
  return null;
}

export function validateTask(value: unknown): string | null {
  if (!isPlainObject(value)) return 'task_not_object';
  if (!isId(value.id)) return 'task_id_invalid';
  if (hasOwn(value, 'contextId') && !isId(value.contextId)) return 'task_context_id_invalid';
  const statusErr = validateTaskStatus(value.status);
  if (statusErr !== null) return statusErr;
  if (hasOwn(value, 'artifacts')) {
    if (!Array.isArray(value.artifacts)) return 'task_artifacts_not_array';
    for (const a of value.artifacts) {
      const err = validateArtifact(a);
      if (err !== null) return err;
    }
  }
  if (hasOwn(value, 'history')) {
    if (!Array.isArray(value.history)) return 'task_history_not_array';
    for (const m of value.history) {
      const err = validateMessage(m);
      if (err !== null) return `history_${err}`;
    }
  }
  if (!optionalObject(value, 'metadata')) return 'task_metadata_not_object';
  return null;
}

export type SendMessageResult =
  | { kind: 'task'; task: Record<string, unknown> }
  | { kind: 'message'; message: Record<string, unknown> };

/**
 * A `SendMessageResponse` is a oneof of `task` and `message` (proto
 * `payload`). Exactly one must be present and valid.
 */
export function parseSendMessageResult(value: unknown): SendMessageResult | { error: string } {
  if (!isPlainObject(value)) return { error: 'response_not_object' };
  const hasTask = hasOwn(value, 'task');
  const hasMessage = hasOwn(value, 'message');
  if (hasTask === hasMessage) return { error: 'response_payload_not_exactly_one' };
  if (hasTask) {
    const err = validateTask(value.task);
    return err === null
      ? { kind: 'task', task: value.task as Record<string, unknown> }
      : { error: err };
  }
  const err = validateMessage(value.message);
  return err === null
    ? { kind: 'message', message: value.message as Record<string, unknown> }
    : { error: err };
}

export function validateAgentCardShape(value: unknown): string | null {
  if (!isPlainObject(value)) return 'card_not_object';
  const form = untrustedJsonProblem(value);
  if (form !== null) return form === 'forbidden_member' ? 'card_forbidden_member' : 'card_too_deep';
  for (const key of ['name', 'description', 'version'] as const) {
    if (typeof value[key] !== 'string') return `card_${key}_required`;
  }
  if (!Array.isArray(value.supportedInterfaces) || value.supportedInterfaces.length === 0) {
    return 'card_supported_interfaces_required';
  }
  for (const iface of value.supportedInterfaces) {
    if (!isPlainObject(iface)) return 'card_interface_not_object';
    if (typeof iface.url !== 'string' || iface.url === '') return 'card_interface_url_required';
    if (typeof iface.protocolBinding !== 'string' || iface.protocolBinding === '') {
      return 'card_interface_binding_required';
    }
    if (typeof iface.protocolVersion !== 'string' || iface.protocolVersion === '') {
      return 'card_interface_version_required';
    }
    if (!optionalString(iface, 'tenant')) return 'card_interface_tenant_not_string';
  }
  if (hasOwn(value, 'provider')) {
    const p = value.provider;
    if (!isPlainObject(p) || typeof p.url !== 'string' || typeof p.organization !== 'string') {
      return 'card_provider_invalid';
    }
  }
  if (!isPlainObject(value.capabilities)) return 'card_capabilities_required';
  const caps = value.capabilities;
  for (const flag of ['streaming', 'pushNotifications', 'extendedAgentCard'] as const) {
    if (hasOwn(caps, flag) && typeof caps[flag] !== 'boolean')
      return `card_capabilities_${flag}_invalid`;
  }
  if (hasOwn(caps, 'extensions')) {
    if (!Array.isArray(caps.extensions)) return 'card_extensions_not_array';
    for (const ext of caps.extensions) {
      if (!isPlainObject(ext)) return 'card_extension_not_object';
      if (!optionalString(ext, 'uri') || !optionalString(ext, 'description'))
        return 'card_extension_invalid';
      if (hasOwn(ext, 'required') && typeof ext.required !== 'boolean')
        return 'card_extension_invalid';
      if (!optionalObject(ext, 'params')) return 'card_extension_invalid';
    }
  }
  if (!requiredStringArray(value, 'defaultInputModes')) return 'card_default_input_modes_required';
  if (!requiredStringArray(value, 'defaultOutputModes'))
    return 'card_default_output_modes_required';
  if (!Array.isArray(value.skills) || value.skills.length === 0) return 'card_skills_required';
  for (const skill of value.skills) {
    if (!isPlainObject(skill)) return 'card_skill_not_object';
    if (!isId(skill.id)) return 'card_skill_id_invalid';
    if (typeof skill.name !== 'string' || typeof skill.description !== 'string') {
      return 'card_skill_text_required';
    }
    if (!requiredStringArray(skill, 'tags')) return 'card_skill_tags_required';
    for (const key of ['examples', 'inputModes', 'outputModes'] as const) {
      if (!optionalStringArray(skill, key)) return `card_skill_${key}_invalid`;
    }
  }
  if (hasOwn(value, 'signatures')) {
    if (!Array.isArray(value.signatures)) return 'card_signatures_not_array';
    for (const sig of value.signatures) {
      if (
        !isPlainObject(sig) ||
        typeof sig.protected !== 'string' ||
        typeof sig.signature !== 'string'
      ) {
        return 'card_signature_invalid';
      }
      if (!optionalObject(sig, 'header')) return 'card_signature_invalid';
    }
  }
  if (!optionalObject(value, 'securitySchemes')) return 'card_security_schemes_not_object';
  if (hasOwn(value, 'securityRequirements') && !Array.isArray(value.securityRequirements)) {
    return 'card_security_requirements_not_array';
  }
  if (!optionalString(value, 'documentationUrl') || !optionalString(value, 'iconUrl')) {
    return 'card_url_not_string';
  }
  return null;
}
