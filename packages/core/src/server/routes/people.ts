/**
 * People-graph routes — write-only HTTP surface used by Brain's
 * post-publish people-graph extractor when it runs out-of-process
 * (home-node-lite). Mobile dispatches the same `applyExtraction` call
 * in-process; lite has to round-trip through HTTP because Brain never
 * touches SQLite.
 *
 *   POST /v1/people/apply-extraction — write the result of an LLM
 *       identity extraction into the people graph. Body is the
 *       structured `ExtractionResult` (the same shape `linksToExtractionResult`
 *       produces). Response: the repo's `ApplyExtractionResponse`.
 *
 * Auth: brain-side allowlist. The signed-auth middleware fires before
 * the handler — only callers whose DID resolves to `service:brain` (or
 * a device key with full access) reach this handler.
 */

import { log } from '../../logging/structured';
import { getPeopleRepository, type PeopleRepository } from '../../people/repository';
import { getVaultRepository } from '../../vault/repository';

import { PEOPLE_APPLY_EXTRACTION, PEOPLE_BY_DID, PEOPLE_FIND, PEOPLE_LIST } from './paths';

import type { ExtractionResult, ApplyExtractionResponse, Person } from '../../people/domain';
import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

/** Body size cap — 256 KiB is generous for a single extraction. */
const APPLY_EXTRACTION_BODY_MAX_BYTES = 256 * 1024;

export interface PeopleRouteOptions {
  /**
   * Repository resolver. Defaults to the module-global registered via
   * `setPeopleRepository`. Tests inject their own.
   */
  resolveRepo?: () => PeopleRepository | null;
}

/**
 * Build the handler bound to the given dependencies. Exported
 * separately from `registerPeopleRoutes` so unit tests can invoke it
 * directly without running the full router's signed-auth pipeline.
 */
export function makePeopleHandlers(options: PeopleRouteOptions = {}): {
  applyExtraction: (req: CoreRequest) => Promise<CoreResponse>;
  list: () => Promise<CoreResponse>;
  find: (req: CoreRequest) => Promise<CoreResponse>;
  findByDid: (req: CoreRequest) => Promise<CoreResponse>;
} {
  const resolveRepo = options.resolveRepo ?? getPeopleRepository;
  return {
    applyExtraction: (req) => handleApplyExtraction(req, resolveRepo),
    list: () => handleList(resolveRepo),
    find: (req) => handleFind(req, resolveRepo),
    findByDid: (req) => handleFindByDid(req, resolveRepo),
  };
}

export function registerPeopleRoutes(router: CoreRouter, options: PeopleRouteOptions = {}): void {
  const { applyExtraction, list, find, findByDid } = makePeopleHandlers(options);
  router.post(PEOPLE_APPLY_EXTRACTION, applyExtraction);
  // /find + /by-did must be registered before /list-style prefix matches;
  // CoreRouter uses exact path matching so all work, but listing the
  // specific paths first keeps intent obvious.
  router.get(PEOPLE_FIND, find);
  router.get(PEOPLE_BY_DID, findByDid);
  router.get(PEOPLE_LIST, list);
}

// ---------------------------------------------------------------------------
// POST /v1/people/apply-extraction
// ---------------------------------------------------------------------------

async function handleApplyExtraction(
  req: CoreRequest,
  resolveRepo: () => PeopleRepository | null,
): Promise<CoreResponse> {
  if (req.rawBody.byteLength > APPLY_EXTRACTION_BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${APPLY_EXTRACTION_BODY_MAX_BYTES} bytes`);
  }
  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }

  // The body must already be a well-formed ExtractionResult — Brain
  // produces it via `linksToExtractionResult`. We do minimal shape
  // checks here; deep validation is the repo's job (it cross-checks
  // surface/owner relations on apply).
  const body = req.body as Partial<ExtractionResult>;
  if (typeof body.sourceItemId !== 'string' || body.sourceItemId.trim() === '') {
    return jsonError(400, 'sourceItemId is required');
  }
  if (typeof body.extractorVersion !== 'string' || body.extractorVersion.trim() === '') {
    return jsonError(400, 'extractorVersion is required');
  }
  if (!Array.isArray(body.results)) {
    return jsonError(400, 'results must be an array');
  }

  const repo = resolveRepo();
  if (repo === null) {
    return jsonError(503, 'people repository not wired');
  }

  let applied: ApplyExtractionResponse;
  try {
    applied = repo.applyExtraction(body as ExtractionResult);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }

  // Out-of-process subject linking (home-node-lite): Core owns both the
  // people graph AND the persona vaults, so when the Brain tells us
  // which persona the source item lives in, we write the structured
  // recall edge (`vault_item_subjects`) here — the out-of-process
  // counterpart of the in-process post_publish step 5b. Fail-soft:
  // recall enrichment, never fails the extraction apply.
  const persona = typeof (req.body as { persona?: unknown }).persona === 'string'
    ? ((req.body as { persona?: string }).persona as string)
    : '';
  if (persona !== '' && applied.personIds && applied.personIds.length > 0) {
    const vaultRepo = getVaultRepository(persona);
    if (vaultRepo !== null) {
      for (const personId of applied.personIds) {
        try {
          vaultRepo.linkSubjectSync(body.sourceItemId, personId, {
            source: 'llm',
            confidence: 'medium',
          });
        } catch (err) {
          // The subject link is enrichment — a failure must NOT fail the
          // extraction apply (the people graph is already written). But
          // it MUST be visible: a silently-dropped link means did->person
          // recall quietly degrades while the apply reports success. Log
          // it (metadata only — no vault content) so the degradation is
          // observable.
          log(
            'warn',
            `people.apply.subject_link_failed persona=${persona} item=${body.sourceItemId} person=${personId}`,
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
    }
  }

  return { status: 200, body: applied as unknown as Record<string, unknown> };
}

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}

// ---------------------------------------------------------------------------
// GET /v1/people — list every confirmed/suggested person
// ---------------------------------------------------------------------------
//
// Used by the brain's reasoning agent (out-of-process in lite, in-process
// on mobile via the same repository). Returns the full person list with
// hydrated surfaces so the LLM can match a user's mention against any
// surface form ("Emma", "Em", "my daughter Emma").
//
// Rejected people are hidden by the repository's `listPeople()` contract;
// we don't filter here.

async function handleList(resolveRepo: () => PeopleRepository | null): Promise<CoreResponse> {
  const repo = resolveRepo();
  if (repo === null) {
    return jsonError(503, 'people repository not wired');
  }
  let people: Person[];
  try {
    people = repo.listPeople();
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { people: people as unknown as Record<string, unknown>[] } };
}

// ---------------------------------------------------------------------------
// GET /v1/people/find?surface=Emma — find people by surface form
// ---------------------------------------------------------------------------
//
// Lowercased + trimmed match against `Person.surfaces[*].normalizedSurface`.
// Multiple people may share a surface (two contacts named "Alex"); we
// return every match so the LLM can ask for clarification when it sees
// > 1 row. Surfaces with `status: 'rejected'` are not considered.
//
// Query: `surface` (required). Empty / missing → 400.

async function handleFind(
  req: CoreRequest,
  resolveRepo: () => PeopleRepository | null,
): Promise<CoreResponse> {
  const raw = req.query.surface;
  const surface = typeof raw === 'string' ? raw.trim() : '';
  if (surface === '') {
    return jsonError(400, 'surface query parameter is required');
  }
  const repo = resolveRepo();
  if (repo === null) {
    return jsonError(503, 'people repository not wired');
  }
  const needle = surface.toLowerCase();
  let people: Person[];
  try {
    people = repo.listPeople();
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  const matches = people.filter((p) =>
    (p.surfaces ?? []).some(
      (s) => s.status !== 'rejected' && s.normalizedSurface === needle,
    ),
  );
  return { status: 200, body: { people: matches as unknown as Record<string, unknown>[] } };
}

// ---------------------------------------------------------------------------
// GET /v1/people/by-did?did=did:plc:… — resolve a person by identity DID
// ---------------------------------------------------------------------------
//
// The out-of-process counterpart of `resolveByIdentity('did', …)`. Lite's
// staging drain calls this to resolve an inbound D2D sender DID to a person
// so it can seed that person's subject-linked memories into the agentic loop.
async function handleFindByDid(
  req: CoreRequest,
  resolveRepo: () => PeopleRepository | null,
): Promise<CoreResponse> {
  const raw = req.query.did;
  const did = typeof raw === 'string' ? raw.trim() : '';
  if (did === '') {
    return jsonError(400, 'did query parameter is required');
  }
  const repo = resolveRepo();
  if (repo === null) {
    return jsonError(503, 'people repository not wired');
  }
  let person: Person | null;
  try {
    person = repo.resolveByIdentity('did', did);
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
  return { status: 200, body: { person: (person as unknown as Record<string, unknown>) ?? null } };
}
