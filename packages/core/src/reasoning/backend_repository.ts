import {
  isReasoningAvailability,
  isReasoningBackendKind,
  isReasoningSensitivity,
  isReasoningTaskKind,
  type ReasoningAvailability,
  type ReasoningBackendBinding,
  type ReasoningBackendKind,
  type ReasoningSensitivity,
  type ReasoningTaskKind,
} from './domain';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface RegisterReasoningBackendInput {
  backendId: string;
  kind: ReasoningBackendKind;
  principalDid: string;
  allowedTaskKinds: ReasoningTaskKind[];
  maxSensitivity: ReasoningSensitivity;
  availability: ReasoningAvailability;
  modelClass?: string;
  selectedByOwnerDid: string;
  expiresAtMs?: number | null;
  expectedVersion: number | null;
  nowMs?: number;
}

export class ReasoningBackendConflictError extends Error {
  constructor() {
    super('reasoning backend policy version conflict');
    this.name = 'ReasoningBackendConflictError';
  }
}

export interface ReasoningBackendRepository {
  get(backendId: string): ReasoningBackendBinding | null;
  getActiveForPrincipal(principalDid: string, nowMs?: number): ReasoningBackendBinding[];
  list(): ReasoningBackendBinding[];
  register(input: RegisterReasoningBackendInput): ReasoningBackendBinding;
  revoke(
    backendId: string,
    expectedVersion: number,
    selectedByOwnerDid: string,
    nowMs?: number,
  ): boolean;
}

const COLS = [
  'backend_id',
  'kind',
  'principal_did',
  'allowed_task_kinds_json',
  'max_sensitivity',
  'availability',
  'model_class',
  'policy_version',
  'selected_by_owner_did',
  'enabled',
  'created_at',
  'updated_at',
  'expires_at',
  'revoked_at',
].join(', ');

const ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const DID_RE = /^did:[^:\s]+:\S+$/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateInput(input: RegisterReasoningBackendInput): void {
  if (!ID_RE.test(input.backendId)) throw new Error('invalid reasoning backend id');
  if (!DID_RE.test(input.principalDid) || input.principalDid.length > 512) {
    throw new Error('invalid reasoning backend principal DID');
  }
  if (!DID_RE.test(input.selectedByOwnerDid) || input.selectedByOwnerDid.length > 512) {
    throw new Error('invalid reasoning backend owner DID');
  }
  if (!isReasoningBackendKind(input.kind)) throw new Error('invalid reasoning backend kind');
  if (!isReasoningAvailability(input.availability)) {
    throw new Error('invalid reasoning backend availability');
  }
  if (!isReasoningSensitivity(input.maxSensitivity)) {
    throw new Error('invalid reasoning backend sensitivity');
  }
  if (
    input.allowedTaskKinds.length === 0 ||
    input.allowedTaskKinds.some((kind) => !isReasoningTaskKind(kind))
  ) {
    throw new Error('reasoning backend requires allowed task kinds');
  }
  if (
    input.modelClass !== undefined &&
    (input.modelClass.length > 256 || hasControlCharacter(input.modelClass))
  ) {
    throw new Error('invalid reasoning backend model class');
  }
  if (
    input.expiresAtMs !== undefined &&
    input.expiresAtMs !== null &&
    (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs < 0)
  ) {
    throw new Error('invalid reasoning backend expiry');
  }
  if (
    input.expectedVersion !== null &&
    (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
  ) {
    throw new Error('invalid reasoning backend policy version');
  }
  if (input.nowMs !== undefined && (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)) {
    throw new Error('invalid reasoning backend timestamp');
  }
}

function parseKinds(raw: unknown): ReasoningTaskKind[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((kind) => !isReasoningTaskKind(kind))
    ) {
      return null;
    }
    return [...new Set(parsed)] as ReasoningTaskKind[];
  } catch {
    return null;
  }
}

function rowToBinding(row: DBRow): ReasoningBackendBinding | null {
  const allowedTaskKinds = parseKinds(row.allowed_task_kinds_json);
  const policyVersion = Number(row.policy_version);
  const createdAtMs = Number(row.created_at);
  const updatedAtMs = Number(row.updated_at);
  const expiresAtMs = row.expires_at == null ? null : Number(row.expires_at);
  const revokedAtMs = row.revoked_at == null ? null : Number(row.revoked_at);
  if (
    typeof row.backend_id !== 'string' ||
    !ID_RE.test(row.backend_id) ||
    !isReasoningBackendKind(row.kind) ||
    typeof row.principal_did !== 'string' ||
    !DID_RE.test(row.principal_did) ||
    row.principal_did.length > 512 ||
    allowedTaskKinds === null ||
    !isReasoningSensitivity(row.max_sensitivity) ||
    !isReasoningAvailability(row.availability) ||
    !Number.isSafeInteger(policyVersion) ||
    policyVersion < 1 ||
    typeof row.selected_by_owner_did !== 'string' ||
    !DID_RE.test(row.selected_by_owner_did) ||
    row.selected_by_owner_did.length > 512 ||
    (Number(row.enabled) !== 0 && Number(row.enabled) !== 1) ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    !Number.isSafeInteger(updatedAtMs) ||
    updatedAtMs < 0 ||
    (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0)) ||
    (revokedAtMs !== null && (!Number.isSafeInteger(revokedAtMs) || revokedAtMs < 0))
  ) {
    return null;
  }
  return {
    backendId: row.backend_id,
    kind: row.kind,
    principalDid: row.principal_did,
    allowedTaskKinds,
    maxSensitivity: row.max_sensitivity,
    availability: row.availability,
    ...(typeof row.model_class === 'string' && row.model_class !== ''
      ? { modelClass: row.model_class }
      : {}),
    policyVersion,
    selectedByOwnerDid: row.selected_by_owner_did,
    enabled: Number(row.enabled) === 1,
    createdAtMs,
    updatedAtMs,
    expiresAtMs,
    revokedAtMs,
  };
}

function isActive(binding: ReasoningBackendBinding, nowMs: number): boolean {
  return (
    binding.enabled &&
    binding.revokedAtMs === null &&
    (binding.expiresAtMs === null || binding.expiresAtMs > nowMs)
  );
}

export class SQLiteReasoningBackendRepository implements ReasoningBackendRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(backendId: string): ReasoningBackendBinding | null {
    const row = this.db.query(
      `SELECT ${COLS} FROM reasoning_backends WHERE backend_id = ? LIMIT 1`,
      [backendId],
    )[0];
    return row ? rowToBinding(row) : null;
  }

  getActiveForPrincipal(
    principalDid: string,
    nowMs: number = Date.now(),
  ): ReasoningBackendBinding[] {
    return this.list().filter(
      (binding) => binding.principalDid === principalDid && isActive(binding, nowMs),
    );
  }

  list(): ReasoningBackendBinding[] {
    const bindings: ReasoningBackendBinding[] = [];
    for (const row of this.db.query(`SELECT ${COLS} FROM reasoning_backends`, [])) {
      const binding = rowToBinding(row);
      if (binding !== null) bindings.push(binding);
    }
    return bindings.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  register(input: RegisterReasoningBackendInput): ReasoningBackendBinding {
    validateInput(input);
    const now = input.nowMs ?? Date.now();
    const kinds = [...new Set(input.allowedTaskKinds)].sort();
    let result: ReasoningBackendBinding | null = null;
    this.db.transaction(() => {
      const existing = this.get(input.backendId);
      if (existing === null) {
        if (input.expectedVersion !== null) throw new ReasoningBackendConflictError();
        result = {
          backendId: input.backendId,
          kind: input.kind,
          principalDid: input.principalDid,
          allowedTaskKinds: kinds,
          maxSensitivity: input.maxSensitivity,
          availability: input.availability,
          ...(input.modelClass ? { modelClass: input.modelClass } : {}),
          policyVersion: 1,
          selectedByOwnerDid: input.selectedByOwnerDid,
          enabled: true,
          createdAtMs: now,
          updatedAtMs: now,
          expiresAtMs: input.expiresAtMs ?? null,
          revokedAtMs: null,
        };
        this.db.execute(
          `INSERT INTO reasoning_backends (${COLS})
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?, NULL)`,
          [
            result.backendId,
            result.kind,
            result.principalDid,
            JSON.stringify(result.allowedTaskKinds),
            result.maxSensitivity,
            result.availability,
            result.modelClass ?? null,
            result.selectedByOwnerDid,
            result.createdAtMs,
            result.updatedAtMs,
            result.expiresAtMs,
          ],
        );
        return;
      }
      if (input.expectedVersion !== existing.policyVersion) {
        throw new ReasoningBackendConflictError();
      }
      result = {
        ...existing,
        kind: input.kind,
        principalDid: input.principalDid,
        allowedTaskKinds: kinds,
        maxSensitivity: input.maxSensitivity,
        availability: input.availability,
        ...(input.modelClass ? { modelClass: input.modelClass } : { modelClass: undefined }),
        policyVersion: existing.policyVersion + 1,
        selectedByOwnerDid: input.selectedByOwnerDid,
        enabled: true,
        updatedAtMs: now,
        expiresAtMs: input.expiresAtMs ?? null,
        revokedAtMs: null,
      };
      const affected = this.db.run(
        `UPDATE reasoning_backends
         SET kind = ?, principal_did = ?, allowed_task_kinds_json = ?,
             max_sensitivity = ?, availability = ?, model_class = ?,
             policy_version = ?, selected_by_owner_did = ?, enabled = 1,
             updated_at = ?, expires_at = ?, revoked_at = NULL
         WHERE backend_id = ? AND policy_version = ?`,
        [
          result.kind,
          result.principalDid,
          JSON.stringify(result.allowedTaskKinds),
          result.maxSensitivity,
          result.availability,
          result.modelClass ?? null,
          result.policyVersion,
          result.selectedByOwnerDid,
          result.updatedAtMs,
          result.expiresAtMs,
          result.backendId,
          existing.policyVersion,
        ],
      );
      if (affected !== 1) throw new ReasoningBackendConflictError();
    });
    if (result === null) throw new Error('reasoning backend registration failed');
    return result;
  }

  revoke(
    backendId: string,
    expectedVersion: number,
    selectedByOwnerDid: string,
    nowMs: number = Date.now(),
  ): boolean {
    return (
      this.db.run(
        `UPDATE reasoning_backends
         SET enabled = 0, policy_version = policy_version + 1,
             selected_by_owner_did = ?, updated_at = ?, revoked_at = ?
         WHERE backend_id = ? AND policy_version = ?
           AND enabled = 1 AND revoked_at IS NULL`,
        [selectedByOwnerDid, nowMs, nowMs, backendId, expectedVersion],
      ) === 1
    );
  }
}

export class InMemoryReasoningBackendRepository implements ReasoningBackendRepository {
  private readonly rows = new Map<string, ReasoningBackendBinding>();

  get(backendId: string): ReasoningBackendBinding | null {
    const row = this.rows.get(backendId);
    return row ? { ...row, allowedTaskKinds: [...row.allowedTaskKinds] } : null;
  }

  getActiveForPrincipal(
    principalDid: string,
    nowMs: number = Date.now(),
  ): ReasoningBackendBinding[] {
    return this.list().filter(
      (binding) => binding.principalDid === principalDid && isActive(binding, nowMs),
    );
  }

  list(): ReasoningBackendBinding[] {
    return [...this.rows.values()]
      .map((row) => ({ ...row, allowedTaskKinds: [...row.allowedTaskKinds] }))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  register(input: RegisterReasoningBackendInput): ReasoningBackendBinding {
    validateInput(input);
    const existing = this.rows.get(input.backendId);
    if (
      (existing === undefined && input.expectedVersion !== null) ||
      (existing !== undefined && existing.policyVersion !== input.expectedVersion)
    ) {
      throw new ReasoningBackendConflictError();
    }
    const now = input.nowMs ?? Date.now();
    const row: ReasoningBackendBinding = {
      backendId: input.backendId,
      kind: input.kind,
      principalDid: input.principalDid,
      allowedTaskKinds: [...new Set(input.allowedTaskKinds)].sort(),
      maxSensitivity: input.maxSensitivity,
      availability: input.availability,
      ...(input.modelClass ? { modelClass: input.modelClass } : {}),
      policyVersion: (existing?.policyVersion ?? 0) + 1,
      selectedByOwnerDid: input.selectedByOwnerDid,
      enabled: true,
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      expiresAtMs: input.expiresAtMs ?? null,
      revokedAtMs: null,
    };
    this.rows.set(row.backendId, row);
    return { ...row, allowedTaskKinds: [...row.allowedTaskKinds] };
  }

  revoke(
    backendId: string,
    expectedVersion: number,
    selectedByOwnerDid: string,
    nowMs: number = Date.now(),
  ): boolean {
    const existing = this.rows.get(backendId);
    if (
      existing === undefined ||
      existing.policyVersion !== expectedVersion ||
      existing.revokedAtMs !== null
    ) {
      return false;
    }
    this.rows.set(backendId, {
      ...existing,
      enabled: false,
      policyVersion: existing.policyVersion + 1,
      selectedByOwnerDid,
      updatedAtMs: nowMs,
      revokedAtMs: nowMs,
    });
    return true;
  }
}

let repository: ReasoningBackendRepository | null = null;

export function setReasoningBackendRepository(next: ReasoningBackendRepository | null): void {
  repository = next;
}

export function getReasoningBackendRepository(): ReasoningBackendRepository | null {
  return repository;
}
