/**
 * A2A v1.0 wire types, in their ProtoJSON (camelCase) form (spec §5.5).
 * Mirrors `specification/a2a.proto` (package `lf.a2a.v1`) field for field.
 * Proto `google.protobuf.Struct` and `Value` fields are plain JSON here.
 *
 * Only the fields Dina reads or writes are typed precisely; anything else a
 * peer sends survives as an unknown member (spec §5.7: ignore unrecognized
 * fields), so a newer minor version never breaks a signature check.
 */

import type { JsonObject, JsonValue } from './json';

export const TASK_STATES = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Terminal states (spec §3.1.5): a task in one of these cannot be canceled. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export const ROLES = ['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT'] as const;
export type Role = (typeof ROLES)[number];

/** `Part`: exactly one of `text`, `raw` (base64), `url`, `data`. */
export interface Part {
  text?: string;
  raw?: string;
  url?: string;
  data?: JsonValue;
  metadata?: JsonObject;
  filename?: string;
  mediaType?: string;
}

export interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: JsonObject;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  /** ISO 8601 UTC, `Z` suffix (spec §5.6.1). */
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: JsonObject;
  extensions?: string[];
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: JsonObject;
}

export interface AgentInterface {
  url: string;
  protocolBinding: string;
  tenant?: string;
  protocolVersion: string;
}

export interface AgentProvider {
  url: string;
  organization: string;
}

export interface AgentExtension {
  uri?: string;
  description?: string;
  required?: boolean;
  params?: JsonObject;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface SecurityRequirement {
  schemes: Record<string, { list?: string[] }>;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: SecurityRequirement[];
}

export interface AgentCardSignature {
  protected: string;
  signature: string;
  header?: JsonObject;
}

/** A security scheme is a oneof; Dina only reads which branch is set. */
export type SecurityScheme = JsonObject;

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider?: AgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, SecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  signatures?: AgentCardSignature[];
  iconUrl?: string;
}

export interface AuthenticationInfo {
  scheme: string;
  credentials?: string;
}

export interface TaskPushNotificationConfig {
  tenant?: string;
  id?: string;
  taskId?: string;
  url: string;
  token?: string;
  authentication?: AuthenticationInfo;
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  taskPushNotificationConfig?: TaskPushNotificationConfig;
  historyLength?: number;
  returnImmediately?: boolean;
}

export interface SendMessageRequest {
  tenant?: string;
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: JsonObject;
}

/** `SendMessageResponse`: a oneof of `task` and `message` (proto `payload`). */
export type SendMessageResponse = { task: Task } | { message: Message };

export interface GetTaskRequest {
  tenant?: string;
  id: string;
  historyLength?: number;
}

export interface ListTasksRequest {
  tenant?: string;
  contextId?: string;
  status?: TaskState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts?: boolean;
}

export interface ListTasksResponse {
  tasks: Task[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

export interface CancelTaskRequest {
  tenant?: string;
  id: string;
  metadata?: JsonObject;
}
