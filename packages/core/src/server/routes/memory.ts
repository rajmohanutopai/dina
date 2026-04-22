/**
 * Working-memory routes (WM-CORE-07).
 *
 *   POST /v1/memory/topic/touch — ingest-time increment of a
 *       topic's EWMA counters. Body:
 *         { persona, topic, kind, sample_item_id? }
 *       Resolves `topic` through the persona's alias map FIRST, then
 *       touches the canonical row. Returns the canonical name so
 *       Brain can log / cross-reference.
 *
 *   GET  /v1/memory/toc?persona=a,b,c&limit=50 — read the current
 *       Table of Contents (ToC). Missing `persona` = all unlocked
 *       personas. `limit` default 50, capped at 200.
 *
 * Port of `core/internal/handler/memory.go`. Behavioural parity
 * points (mirrored from the Go port / design doc §7 and §8):
 *
 *   - An empty / unknown persona on `touch` returns 200 with
 *     `{status: "skipped"}` rather than 400 — the contract is "soft
 *     no-op when the persona is locked", not "reject the caller".
 *     This matters because ingest is fire-and-forget; returning a
 *     4xx here would surface as a Brain-side warning for a race the
 *     user caused (e.g. locking the persona mid-ingest).
 *
 *   - The ToC handler skips the `identity` Tier-0 persona
 *     explicitly (via the service layer — handlers don't know about
 *     it).
 *
 * Auth: both routes sit under `/v1/memory/*` which is on the
 * Brain-allowlist prefix (see WM-CORE-08). `signed` auth is applied
 * by the router's default auth mode.
 */

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';
import { MEMORY_TOC, MEMORY_TOPIC_TOUCH } from './paths';
import { getMemoryService, type MemoryService } from '../../memory/service';
import { getTopicRepository, type TopicRepository } from '../../memory/repository';
import { isTopicKind, type TopicKind } from '../../memory/domain';

/** Body size cap for touch — 16 KiB matches the Go port's limit. */
const TOUCH_BODY_MAX_BYTES = 16 * 1024;

/** Default limit when the caller doesn't pass one. */
const DEFAULT_TOC_LIMIT = 50;
/** Hard ceiling on the ToC size — prevents a dumb caller from
 *  asking for 100k rows. Matches the Go port. */
const MAX_TOC_LIMIT = 200;

export interface MemoryRouteOptions {
  /**
   * Repository resolver for the touch handler. Defaults to the
   * module-global per-persona map. Tests inject their own.
   */
  resolveRepo?: (persona: string) => TopicRepository | null;
  /**
   * Clock. Defaults to `Math.floor(Date.now() / 1000)`. Tests pin
   * it for deterministic assertion on the row's last_update.
   */
  nowSecFn?: () => number;
  /**
   * Explicit MemoryService for the `/toc` handler. Defaults to the
   * module-global `getMemoryService()`. Tests pass their own so the
   * route doesn't depend on a process-global.
   */
  memoryService?: MemoryService | null;
}

/**
 * Build the two handler functions bound to the given dependencies.
 * Exported separately from `registerMemoryRoutes` so unit tests can
 * invoke them directly without running the full router's signed-auth
 * pipeline. `registerMemoryRoutes` is the production entry point; it
 * delegates here.
 */
export function makeMemoryHandlers(options: MemoryRouteOptions = {}): {
  touch: (req: CoreRequest) => Promise<CoreResponse>;
  toc: (req: CoreRequest) => Promise<CoreResponse>;
} {
  const resolveRepo = options.resolveRepo ?? getTopicRepository;
  const nowSecFn = options.nowSecFn ?? (() => Math.floor(Date.now() / 1000));
  const memoryService = options.memoryService ?? null;
  return {
    touch: (req) => handleTouch(req, resolveRepo, nowSecFn),
    toc: (req) => handleToc(req, memoryService),
  };
}

export function registerMemoryRoutes(router: CoreRouter, options: MemoryRouteOptions = {}): void {
  const { touch, toc } = makeMemoryHandlers(options);
  router.post(MEMORY_TOPIC_TOUCH, touch);
  router.get(MEMORY_TOC, toc);
}

// ---------------------------------------------------------------------------
// POST /v1/memory/topic/touch
// ---------------------------------------------------------------------------

interface TouchBody {
  persona?: unknown;
  topic?: unknown;
  kind?: unknown;
  sample_item_id?: unknown;
}

async function handleTouch(
  req: CoreRequest,
  resolveRepo: (persona: string) => TopicRepository | null,
  nowSecFn: () => number,
): Promise<CoreResponse> {
  if (req.rawBody.byteLength > TOUCH_BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${TOUCH_BODY_MAX_BYTES} bytes`);
  }

  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const body = req.body as TouchBody;

  const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  const kindRaw = body.kind;
  if (persona === '') return jsonError(400, 'persona is required');
  if (topic === '') return jsonError(400, 'topic is required');
  if (!isTopicKind(kindRaw)) {
    return jsonError(400, 'kind must be "entity" or "theme"');
  }
  const kind: TopicKind = kindRaw;

  const repo = resolveRepo(persona);
  if (repo === null) {
    // Soft no-op: the persona is locked / never opened. Return 200
    // so the caller doesn't treat a user-caused race as a bug.
    return {
      status: 200,
      body: { status: 'skipped', reason: 'persona not open' },
    };
  }

  const sampleItemId = optionalString(body.sample_item_id);

  const canonical = await repo.resolveAlias(topic);
  try {
    await repo.touch({
      topic: canonical,
      kind,
      nowUnix: nowSecFn(),
      sampleItemId,
    });
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }

  return {
    status: 200,
    body: { status: 'ok', canonical },
  };
}

// ---------------------------------------------------------------------------
// GET /v1/memory/toc
// ---------------------------------------------------------------------------

async function handleToc(
  req: CoreRequest,
  injectedService: MemoryService | null,
): Promise<CoreResponse> {
  const service = injectedService ?? getMemoryService();
  if (service === null) {
    return jsonError(503, 'memory service not wired');
  }

  const personas = parsePersonaFilter(req.query.persona);
  const limit = clampLimit(parseUnsignedInt(req.query.limit, DEFAULT_TOC_LIMIT));

  const entries = await service.toc(personas, limit);

  return {
    status: 200,
    body: { entries, limit },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse the `persona` query param into an array:
 *   undefined | '' → undefined (means "all unlocked personas")
 *   'a'             → ['a']
 *   'a,b,c'         → ['a', 'b', 'c']  (empty segments dropped)
 */
function parsePersonaFilter(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return parts.length > 0 ? parts : undefined;
}

/**
 * Parse an unsigned integer from a query-string value, falling back
 * to `defaultValue` on missing / negative / non-numeric input. Kept
 * local rather than pulling in the workflow route's `parseUnsignedNumber`
 * — that one accepts floats, which the ToC limit cannot use.
 */
function parseUnsignedInt(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return defaultValue;
  return n;
}

function clampLimit(n: number): number {
  if (n <= 0) return DEFAULT_TOC_LIMIT;
  return Math.min(n, MAX_TOC_LIMIT);
}

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}
