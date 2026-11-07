/**
 * `/v1/ask-records` routes (FIXES F11) — Brain's live ask records, kept in
 * Core so an ask waiting on approval survives a restart
 * (`ask/ask_record_repository.ts`).
 *
 *   POST /v1/ask-records         — upsert. Body: a record in snake_case;
 *       fields outside the record (a paused state, an answer) are dropped.
 *   GET  /v1/ask-records         — list. Response `{ records: [...] }`.
 *   POST /v1/ask-records/delete  — remove. Body `{ id }`. Response `{ removed }`.
 *
 * Auth: brain/admin allowlist (`authz.ts`). A missing repository is a 503.
 */

import {
  getAskRecordRepository,
  storedAskRecordToWire,
  wireToStoredAskRecord,
} from '../../ask/ask_record_repository';

import { ASK_RECORDS_DELETE, ASK_RECORDS_ROOT } from './paths';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

/** A question plus a few ids; 64 KiB leaves room for a long question. */
const BODY_MAX_BYTES = 64 * 1024;

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}

function handlePut(req: CoreRequest): CoreResponse {
  if (req.rawBody.byteLength > BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${BODY_MAX_BYTES} bytes`);
  }
  const repo = getAskRecordRepository();
  if (repo === null) return jsonError(503, 'ask records not wired');
  const record = wireToStoredAskRecord(req.body);
  if (record === null) {
    return jsonError(400, 'id, question, requester_did, a live status and the times are required');
  }
  repo.put(record);
  return { status: 200, body: { ok: true } };
}

function handleList(): CoreResponse {
  const repo = getAskRecordRepository();
  if (repo === null) return jsonError(503, 'ask records not wired');
  return { status: 200, body: { records: repo.list().map(storedAskRecordToWire) } };
}

function handleDelete(req: CoreRequest): CoreResponse {
  const repo = getAskRecordRepository();
  if (repo === null) return jsonError(503, 'ask records not wired');
  const id = (req.body as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || id === '') return jsonError(400, 'id is required');
  return { status: 200, body: { removed: repo.delete(id) } };
}

export function registerAskRecordRoutes(router: CoreRouter): void {
  router.post(ASK_RECORDS_ROOT, async (req) => handlePut(req));
  router.get(ASK_RECORDS_ROOT, async () => handleList());
  router.post(ASK_RECORDS_DELETE, async (req) => handleDelete(req));
}
