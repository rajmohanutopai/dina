/**
 * Task 6.4 — PDS record CRUD: createRecord / putRecord /
 * getRecord / deleteRecord / listRecords.
 *
 * The five verbs for interacting with records in an actor's PDS
 * repo. Maps directly to the `com.atproto.repo.*` xRPC surface:
 *
 *   - **createRecord** — POSTs a new record. Server generates the
 *     rkey if the caller omits it. Returns `{uri, cid}`.
 *   - **putRecord** — upsert at a specific rkey. Idempotent.
 *     Returns `{uri, cid}`.
 *   - **getRecord** — fetches `{uri, cid, value}` for a given
 *     repo/collection/rkey. 404 → `{ok: false, reason: 'not_found'}`.
 *   - **deleteRecord** — removes a record. Idempotent (200 even
 *     when the record already didn't exist).
 *   - **listRecords** — paginated listing for a collection.
 *     Returns `{records, cursor}`.
 *
 * **Framework-free**: `pdsClient` is injected (same shape as the
 * one used by `SessionManager` task 6.2). Production wires the
 * signed-HTTP client; tests pass scripted stubs.
 *
 * **Lexicon validation** (task 6.5) is NOT integrated here —
 * that's the caller's job. Separating validation from transport
 * keeps this primitive small + lets callers skip validation when
 * they've already passed it (e.g. after a ProfileBuilder roundtrip).
 *
 * **Error taxonomy** (mirrors 6.2):
 *   - `invalid_input` — argument validation failed before HTTP.
 *   - `not_found` — getRecord/deleteRecord saw 404.
 *   - `rate_limited` — 429.
 *   - `rejected_by_pds` — 4xx/5xx with structured body.
 *   - `network_error` — transport threw.
 *   - `malformed_response` — 2xx with body not matching spec.
 *
 * **Never throws**.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 6b task 6.4.
 */

export type RepoRequestKind =
  | 'createRecord'
  | 'putRecord'
  | 'getRecord'
  | 'deleteRecord'
  | 'listRecords';

export interface RepoClientResult {
  status: number;
  body: Record<string, unknown> | null;
}

export type RepoClientFn = (
  kind: RepoRequestKind,
  payload: Record<string, unknown>,
  bearer: string,
) => Promise<RepoClientResult>;

export interface RecordCrudClientOptions {
  pdsClient: RepoClientFn;
  /** Used as the `repo` / `bearer`. */
  did: string;
  bearer: string;
  onEvent?: (event: RecordCrudEvent) => void;
}

export type RecordCrudEvent =
  | { kind: 'request'; op: RepoRequestKind; collection: string; rkey?: string }
  | { kind: 'response'; op: RepoRequestKind; status: number }
  | { kind: 'rejected'; op: RepoRequestKind; reason: string };

// ── Result shapes ──────────────────────────────────────────────────────

export interface CreateRecordInput {
  collection: string;
  /** Optional — server generates if omitted. */
  rkey?: string;
  record: Record<string, unknown>;
  /** Validate the collection schema server-side before writing. Default false. */
  validate?: boolean;
}

export interface PutRecordInput {
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
}

export interface CreatedRecord {
  uri: string;
  cid: string;
}

export interface FetchedRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

export interface ListRecordsInput {
  collection: string;
  limit?: number;
  cursor?: string;
  reverse?: boolean;
}

export interface ListedRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

export interface ListRecordsResult {
  records: ListedRecord[];
  cursor: string | null;
}

// ── Outcomes ───────────────────────────────────────────────────────────

export type RepoRejectionReason =
  | 'invalid_input'
  | 'not_found'
  | 'rate_limited'
  | 'rejected_by_pds'
  | 'network_error'
  | 'malformed_response';

export type WriteOutcome =
  | { ok: true; result: CreatedRecord }
  | { ok: false; reason: Exclude<RepoRejectionReason, 'not_found'>; error: string; status?: number; detail?: string };

export type GetOutcome =
  | { ok: true; result: FetchedRecord }
  | { ok: false; reason: RepoRejectionReason; error: string; status?: number; detail?: string };

export type DeleteOutcome =
  | { ok: true }
  | { ok: false; reason: Exclude<RepoRejectionReason, 'not_found'>; error: string; status?: number; detail?: string };

export type ListOutcome =
  | { ok: true; result: ListRecordsResult }
  | { ok: false; reason: Exclude<RepoRejectionReason, 'not_found'>; error: string; status?: number; detail?: string };

export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 50;

const COLLECTION_RE = /^[a-z][a-zA-Z0-9.-]{0,253}$/;
/** Max 512 chars ASCII letters/digits/dash/underscore/period. */
const RKEY_RE = /^[a-zA-Z0-9._:-]{1,512}$/;

/**
 * Create the record-CRUD client. The `did` + `bearer` pair is
 * baked into each verb so callers don't thread them through every
 * method. Rotate via a new instance after `refreshSession`.
 */
export class RecordCrudClient {
  private readonly pdsClient: RepoClientFn;
  private readonly did: string;
  private readonly bearer: string;
  private readonly onEvent?: (event: RecordCrudEvent) => void;

  constructor(opts: RecordCrudClientOptions) {
    if (typeof opts?.pdsClient !== 'function') {
      throw new TypeError('RecordCrudClient: pdsClient is required');
    }
    if (typeof opts.did !== 'string' || opts.did === '') {
      throw new TypeError('RecordCrudClient: did is required');
    }
    if (typeof opts.bearer !== 'string' || opts.bearer === '') {
      throw new TypeError('RecordCrudClient: bearer is required');
    }
    this.pdsClient = opts.pdsClient;
    this.did = opts.did;
    this.bearer = opts.bearer;
    this.onEvent = opts.onEvent;
  }

  async createRecord(input: CreateRecordInput): Promise<WriteOutcome> {
    const bad = validateCreate(input);
    if (bad !== null) return rejectInvalid('createRecord', bad, this.onEvent);
    this.onEvent?.({
      kind: 'request',
      op: 'createRecord',
      collection: input.collection,
      ...(input.rkey !== undefined ? { rkey: input.rkey } : {}),
    });
    const payload: Record<string, unknown> = {
      repo: this.did,
      collection: input.collection,
      record: input.record,
      validate: input.validate === true,
    };
    if (input.rkey !== undefined) payload.rkey = input.rkey;
    const result = await this.call('createRecord', payload);
    if (!result.ok) return mapWriteError('createRecord', result, this.onEvent);
    return extractCreated(result.body, 'createRecord', this.onEvent);
  }

  async putRecord(input: PutRecordInput): Promise<WriteOutcome> {
    const bad = validatePut(input);
    if (bad !== null) return rejectInvalid('putRecord', bad, this.onEvent);
    this.onEvent?.({
      kind: 'request',
      op: 'putRecord',
      collection: input.collection,
      rkey: input.rkey,
    });
    const result = await this.call('putRecord', {
      repo: this.did,
      collection: input.collection,
      rkey: input.rkey,
      record: input.record,
    });
    if (!result.ok) return mapWriteError('putRecord', result, this.onEvent);
    return extractCreated(result.body, 'putRecord', this.onEvent);
  }

  async getRecord(input: {
    did?: string;
    collection: string;
    rkey: string;
  }): Promise<GetOutcome> {
    const targetDid = input.did ?? this.did;
    const bad = validateGet({ ...input, did: targetDid });
    if (bad !== null) {
      this.onEvent?.({ kind: 'rejected', op: 'getRecord', reason: 'invalid_input' });
      return { ok: false, reason: 'invalid_input', error: bad };
    }
    this.onEvent?.({
      kind: 'request',
      op: 'getRecord',
      collection: input.collection,
      rkey: input.rkey,
    });
    const result = await this.call('getRecord', {
      repo: targetDid,
      collection: input.collection,
      rkey: input.rkey,
    });
    if (!result.ok) {
      if (result.status === 404) {
        this.onEvent?.({ kind: 'rejected', op: 'getRecord', reason: 'not_found' });
        return {
          ok: false,
          reason: 'not_found',
          error: 'record not found',
          status: 404,
        };
      }
      return mapGetError(result, this.onEvent);
    }
    const body = result.body;
    if (
      body === null ||
      typeof body.uri !== 'string' ||
      typeof body.cid !== 'string' ||
      body.value === null ||
      typeof body.value !== 'object' ||
      Array.isArray(body.value)
    ) {
      this.onEvent?.({ kind: 'rejected', op: 'getRecord', reason: 'malformed_response' });
      return {
        ok: false,
        reason: 'malformed_response',
        error: 'getRecord body missing uri/cid/value',
      };
    }
    this.onEvent?.({ kind: 'response', op: 'getRecord', status: 200 });
    return {
      ok: true,
      result: {
        uri: body.uri as string,
        cid: body.cid as string,
        value: body.value as Record<string, unknown>,
      },
    };
  }

  async deleteRecord(input: { collection: string; rkey: string }): Promise<DeleteOutcome> {
    const bad = validateDelete(input);
    if (bad !== null) {
      this.onEvent?.({ kind: 'rejected', op: 'deleteRecord', reason: 'invalid_input' });
      return { ok: false, reason: 'invalid_input', error: bad };
    }
    this.onEvent?.({
      kind: 'request',
      op: 'deleteRecord',
      collection: input.collection,
      rkey: input.rkey,
    });
    const result = await this.call('deleteRecord', {
      repo: this.did,
      collection: input.collection,
      rkey: input.rkey,
    });
    if (!result.ok) {
      return mapDeleteError(result, this.onEvent);
    }
    this.onEvent?.({ kind: 'response', op: 'deleteRecord', status: result.status });
    return { ok: true };
  }

  async listRecords(input: ListRecordsInput & { did?: string }): Promise<ListOutcome> {
    const targetDid = input.did ?? this.did;
    const bad = validateList({ ...input, did: targetDid });
    if (bad !== null) {
      this.onEvent?.({ kind: 'rejected', op: 'listRecords', reason: 'invalid_input' });
      return { ok: false, reason: 'invalid_input', error: bad };
    }
    this.onEvent?.({
      kind: 'request',
      op: 'listRecords',
      collection: input.collection,
    });
    const payload: Record<string, unknown> = {
      repo: targetDid,
      collection: input.collection,
      limit: input.limit ?? DEFAULT_LIST_LIMIT,
    };
    if (input.cursor !== undefined) payload.cursor = input.cursor;
    if (input.reverse !== undefined) payload.reverse = input.reverse;
    const result = await this.call('listRecords', payload);
    if (!result.ok) return mapListError(result, this.onEvent);
    const body = result.body;
    if (body === null || !Array.isArray(body.records)) {
      this.onEvent?.({
        kind: 'rejected',
        op: 'listRecords',
        reason: 'malformed_response',
      });
      return {
        ok: false,
        reason: 'malformed_response',
        error: 'listRecords body missing records array',
      };
    }
    const records: ListedRecord[] = [];
    for (const r of body.records) {
      if (r === null || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      if (typeof rec.uri !== 'string' || typeof rec.cid !== 'string') continue;
      if (rec.value === null || typeof rec.value !== 'object' || Array.isArray(rec.value)) continue;
      records.push({
        uri: rec.uri,
        cid: rec.cid,
        value: rec.value as Record<string, unknown>,
      });
    }
    const cursor = typeof body.cursor === 'string' && body.cursor !== '' ? body.cursor : null;
    this.onEvent?.({ kind: 'response', op: 'listRecords', status: 200 });
    return { ok: true, result: { records, cursor } };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async call(
    kind: RepoRequestKind,
    payload: Record<string, unknown>,
  ): Promise<
    | { ok: true; status: number; body: Record<string, unknown> | null }
    | { ok: false; status: number; body: Record<string, unknown> | null }
  > {
    let result: RepoClientResult;
    try {
      result = await this.pdsClient(kind, payload, this.bearer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 0, body: { error: msg } };
    }
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, status: result.status, body: result.body };
    }
    return { ok: false, status: result.status, body: result.body };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function validateCreate(input: CreateRecordInput): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (!COLLECTION_RE.test(input.collection)) return 'collection malformed';
  if (input.rkey !== undefined && !RKEY_RE.test(input.rkey)) return 'rkey malformed';
  if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) {
    return 'record must be an object';
  }
  return null;
}

function validatePut(input: PutRecordInput): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (!COLLECTION_RE.test(input.collection)) return 'collection malformed';
  if (!RKEY_RE.test(input.rkey)) return 'rkey malformed';
  if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) {
    return 'record must be an object';
  }
  return null;
}

function validateGet(input: { did: string; collection: string; rkey: string }): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (typeof input.did !== 'string' || !input.did.startsWith('did:')) return 'did malformed';
  if (!COLLECTION_RE.test(input.collection)) return 'collection malformed';
  if (!RKEY_RE.test(input.rkey)) return 'rkey malformed';
  return null;
}

function validateDelete(input: { collection: string; rkey: string }): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (!COLLECTION_RE.test(input.collection)) return 'collection malformed';
  if (!RKEY_RE.test(input.rkey)) return 'rkey malformed';
  return null;
}

function validateList(input: ListRecordsInput & { did: string }): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (typeof input.did !== 'string' || !input.did.startsWith('did:')) return 'did malformed';
  if (!COLLECTION_RE.test(input.collection)) return 'collection malformed';
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_LIST_LIMIT
    ) {
      return `limit must be integer in [1, ${MAX_LIST_LIMIT}]`;
    }
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string') return 'cursor must be a string';
  }
  if (input.reverse !== undefined && typeof input.reverse !== 'boolean') {
    return 'reverse must be a boolean';
  }
  return null;
}

function rejectInvalid(
  op: RepoRequestKind,
  detail: string,
  onEvent?: (event: RecordCrudEvent) => void,
): WriteOutcome {
  onEvent?.({ kind: 'rejected', op, reason: 'invalid_input' });
  return { ok: false, reason: 'invalid_input', error: detail };
}

function extractCreated(
  body: Record<string, unknown> | null,
  op: RepoRequestKind,
  onEvent?: (event: RecordCrudEvent) => void,
): WriteOutcome {
  if (
    body === null ||
    typeof body.uri !== 'string' ||
    typeof body.cid !== 'string' ||
    body.uri === '' ||
    body.cid === ''
  ) {
    onEvent?.({ kind: 'rejected', op, reason: 'malformed_response' });
    return {
      ok: false,
      reason: 'malformed_response',
      error: `${op} body missing uri/cid`,
    };
  }
  onEvent?.({ kind: 'response', op, status: 200 });
  return { ok: true, result: { uri: body.uri, cid: body.cid } };
}

function mapWriteError(
  op: RepoRequestKind,
  result: { status: number; body: Record<string, unknown> | null },
  onEvent?: (event: RecordCrudEvent) => void,
): WriteOutcome {
  return mapErrorCommon(op, result, onEvent) as WriteOutcome;
}

function mapGetError(
  result: { status: number; body: Record<string, unknown> | null },
  onEvent?: (event: RecordCrudEvent) => void,
): GetOutcome {
  return mapErrorCommon('getRecord', result, onEvent) as GetOutcome;
}

function mapDeleteError(
  result: { status: number; body: Record<string, unknown> | null },
  onEvent?: (event: RecordCrudEvent) => void,
): DeleteOutcome {
  return mapErrorCommon('deleteRecord', result, onEvent) as DeleteOutcome;
}

function mapListError(
  result: { status: number; body: Record<string, unknown> | null },
  onEvent?: (event: RecordCrudEvent) => void,
): ListOutcome {
  return mapErrorCommon('listRecords', result, onEvent) as ListOutcome;
}

function mapErrorCommon(
  op: RepoRequestKind,
  result: { status: number; body: Record<string, unknown> | null },
  onEvent?: (event: RecordCrudEvent) => void,
):
  | { ok: false; reason: 'rate_limited' | 'rejected_by_pds' | 'network_error'; error: string; status?: number } {
  const body = result.body as { error?: string } | null;
  if (result.status === 0) {
    onEvent?.({ kind: 'rejected', op, reason: 'network_error' });
    return {
      ok: false,
      reason: 'network_error',
      error: body?.error ?? `${op} transport failed`,
    };
  }
  if (result.status === 429) {
    onEvent?.({ kind: 'rejected', op, reason: 'rate_limited' });
    return {
      ok: false,
      reason: 'rate_limited',
      error: body?.error ?? 'rate limited',
      status: 429,
    };
  }
  onEvent?.({ kind: 'rejected', op, reason: 'rejected_by_pds' });
  return {
    ok: false,
    reason: 'rejected_by_pds',
    status: result.status,
    error: body?.error ?? `${op} failed with status ${result.status}`,
  };
}
