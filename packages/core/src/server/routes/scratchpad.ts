/**
 * Scratchpad HTTP routes.
 *
 *   POST /v1/scratchpad                     — upsert checkpoint.
 *     Body: { taskId, step, context }
 *     step=0 (DELETE_SENTINEL_STEP) deletes the row — matches the
 *     Python idiom `write_scratchpad(taskId, 0, {...})`.
 *
 *   GET  /v1/scratchpad/<taskId>            — read latest, or null
 *     on missing / stale (24h TTL).
 *
 *   DELETE /v1/scratchpad/<taskId>          — drop the row outright.
 *     Used by `ScratchpadService.clear` as an alternative to the
 *     step=0 delete marker; clearer intent.
 *
 * Auth: brain-scope (signed requests). Handlers are thin wrappers
 * around `scratchpad/service.ts` so tests can bypass HTTP and hit the
 * service directly.
 */

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';
import { SCRATCHPAD } from './paths';
import { checkpoint, clear, resume } from '../../scratchpad/service';

/** Upper bound on the checkpoint body — the context JSON can be
 *  chunky (accumulated reasoning state) but pathological payloads
 *  indicate a bug, not a legitimate checkpoint. 256 KiB matches the
 *  Go port's safety cap. */
const SCRATCHPAD_BODY_MAX_BYTES = 256 * 1024;

interface CheckpointBody {
  taskId?: unknown;
  /** Accepts camelCase and snake_case to match the Python client's
   *  wire format + our in-repo TS client's camelCase style. */
  task_id?: unknown;
  step?: unknown;
  context?: unknown;
}

export function registerScratchpadRoutes(router: CoreRouter): void {
  router.post(SCRATCHPAD, handleCheckpoint);
  router.get(`${SCRATCHPAD}/:taskId`, handleResume);
  router.delete(`${SCRATCHPAD}/:taskId`, handleClear);
}

async function handleCheckpoint(req: CoreRequest): Promise<CoreResponse> {
  if (req.rawBody.byteLength > SCRATCHPAD_BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${SCRATCHPAD_BODY_MAX_BYTES} bytes`);
  }
  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const body = req.body as CheckpointBody;

  const taskId =
    typeof body.taskId === 'string' && body.taskId !== ''
      ? body.taskId
      : typeof body.task_id === 'string' && body.task_id !== ''
        ? body.task_id
        : '';
  if (taskId === '') return jsonError(400, 'taskId is required');

  const stepRaw = body.step;
  if (typeof stepRaw !== 'number' || !Number.isInteger(stepRaw)) {
    return jsonError(400, 'step must be an integer');
  }

  const contextRaw = body.context;
  const context: Record<string, unknown> =
    contextRaw !== null && typeof contextRaw === 'object' && !Array.isArray(contextRaw)
      ? (contextRaw as Record<string, unknown>)
      : {};

  try {
    checkpoint(taskId, stepRaw, context);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { status: 'ok', taskId } };
}

async function handleResume(req: CoreRequest): Promise<CoreResponse> {
  const taskId = req.params.taskId ?? '';
  if (taskId === '') return jsonError(400, 'taskId is required');

  const entry = resume(taskId);
  if (entry === null) {
    // CoreClient.readScratchpad treats missing or stale checkpoints as null.
    // Preserve that shape.
    return { status: 200, body: null };
  }
  return {
    status: 200,
    body: {
      taskId: entry.taskId,
      step: entry.step,
      context: entry.context,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
  };
}

async function handleClear(req: CoreRequest): Promise<CoreResponse> {
  const taskId = req.params.taskId ?? '';
  if (taskId === '') return jsonError(400, 'taskId is required');
  clear(taskId);
  return { status: 200, body: { status: 'ok' } };
}

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}
