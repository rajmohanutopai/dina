/**
 * Contacts routes (PC-CORE-10 + PC-CORE-11).
 *
 *   GET /v1/contacts/by-preference?category=X — contacts whose
 *       `preferred_for` list contains the given category. Drives the
 *       reasoning agent's `find_preferred_provider` resolver for
 *       live-state queries. Empty / whitespace category → 400.
 *
 *   PUT /v1/contacts/:did — update mutable contact fields. For V1
 *       the mobile port accepts ONLY `preferred_for` (the brain
 *       preference-binder, PC-BRAIN-13, writes through this
 *       endpoint). Other fields stay in-process for now; adding
 *       them is additive and does not break this surface.
 *
 * Auth: the whole `/v1/contacts/*` prefix is Brain + Admin (see
 * `auth/authz.ts`). `signed` auth is applied by the router default.
 *
 * Port of `core/internal/handler/contact.go` —
 * `HandleFindContactsByPreference` + the preferred_for branch of
 * `HandleUpdateContact`.
 */

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';
import { CONTACTS_BY_PREFERENCE, CONTACTS_LOOKUP, CONTACT_UPDATE, CONTACTS_ROOT } from './paths';
import type { Contact, TrustLevel } from '../../contacts/directory';
import {
  findByPreferredFor as directoryFindByPreferredFor,
  setPreferredFor as directorySetPreferredFor,
  getContact,
  isTrustLevel,
  TRUST_LEVELS,
  resolveByName as directoryResolveByName,
  findByAlias as directoryFindByAlias,
  addContactIfNotExists as directoryAddContactIfNotExists,
} from '../../contacts/directory';

/**
 * Dependencies for the contacts handlers. All callers resolve the
 * contact state via the module-global directory (set up at boot);
 * tests can inject fakes here instead of reaching into the directory
 * so the handlers stay unit-testable without a full app boot.
 */
export interface ContactRoutesOptions {
  /**
   * Resolve contacts that have `category` in their `preferred_for`
   * list. Defaults to the module-global directory function. Tests
   * inject their own fake.
   */
  findByPreferredFor?: (category: string) => Contact[];
  /**
   * Replace a contact's `preferred_for` list. Throws when the contact
   * doesn't exist (the handler maps that to a 404). Defaults to the
   * module-global directory function.
   */
  setPreferredFor?: (did: string, categories: readonly string[]) => void;
  /**
   * Check whether a contact exists (for 404 semantics on the PUT
   * endpoint when no preferred_for field is supplied). Defaults to
   * the module-global directory function.
   */
  getContact?: (did: string) => Contact | null;
  /** Resolve a contact by display name (case-insensitive). Defaults to
   *  the module-global directory function. */
  resolveByName?: (name: string) => Contact | null;
  /** Resolve a contact by alias. Defaults to the module-global directory. */
  findByAlias?: (alias: string) => Contact | null;
  /**
   * Add a contact (idempotent). Defaults to the module-global directory.
   * Needed so a headless / lite node can record a contact over the API —
   * mobile does this in-process via `addContact`, but lite had no add
   * route, so an inbound D2D from a peer you *meant* to trust still
   * quarantined (resolveSender saw no contact). POST /v1/contacts closes
   * that gap.
   */
  addContact?: (
    did: string,
    displayName: string,
    trustLevel?: TrustLevel,
  ) => { contact: Contact; created: boolean };
}

// ---------------------------------------------------------------------------
// Factory (unit-test seam) + production registration
// ---------------------------------------------------------------------------

/**
 * Build the handler functions bound to the given deps. Exported
 * separately from `registerContactsRoutes` so tests can invoke them
 * directly without running the router's signed-auth pipeline.
 */
export function makeContactsHandlers(options: ContactRoutesOptions = {}): {
  findByPreference: (req: CoreRequest) => Promise<CoreResponse>;
  updateContact: (req: CoreRequest) => Promise<CoreResponse>;
  lookup: (req: CoreRequest) => Promise<CoreResponse>;
  addContact: (req: CoreRequest) => Promise<CoreResponse>;
} {
  const findFn = options.findByPreferredFor ?? directoryFindByPreferredFor;
  const setFn = options.setPreferredFor ?? directorySetPreferredFor;
  const getFn = options.getContact ?? getContact;
  const resolveNameFn = options.resolveByName ?? directoryResolveByName;
  const findAliasFn = options.findByAlias ?? directoryFindByAlias;
  const addFn = options.addContact ?? directoryAddContactIfNotExists;
  return {
    findByPreference: (req) => handleFindByPreference(req, findFn),
    updateContact: (req) => handleUpdateContact(req, setFn, getFn),
    lookup: (req) => handleLookup(req, getFn, resolveNameFn, findAliasFn),
    addContact: (req) => handleAddContact(req, addFn),
  };
}

export function registerContactsRoutes(
  router: CoreRouter,
  options: ContactRoutesOptions = {},
): void {
  const { findByPreference, updateContact, lookup, addContact } = makeContactsHandlers(options);
  router.get(CONTACTS_BY_PREFERENCE, findByPreference);
  router.get(CONTACTS_LOOKUP, lookup);
  router.put(CONTACT_UPDATE, updateContact);
  router.post(CONTACTS_ROOT, addContact);
}

// ---------------------------------------------------------------------------
// GET /v1/contacts/lookup?q=…  — resolve one contact by DID / name / alias
// ---------------------------------------------------------------------------
//
// Backs the reasoning agent's `contact_lookup` tool out-of-process (lite),
// where the contact directory lives in Core, not Brain. Same resolution
// order the in-process tool uses: DID → display name → alias. Response:
// `{ contact: Contact | null }`.

async function handleLookup(
  req: CoreRequest,
  getFn: (did: string) => Contact | null,
  resolveNameFn: (name: string) => Contact | null,
  findAliasFn: (alias: string) => Contact | null,
): Promise<CoreResponse> {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q === '') {
    return jsonError(400, 'q query parameter is required');
  }
  const contact =
    (q.startsWith('did:') ? getFn(q) : null) ?? resolveNameFn(q) ?? findAliasFn(q) ?? null;
  return { status: 200, body: { contact } };
}

// ---------------------------------------------------------------------------
// GET /v1/contacts/by-preference
// ---------------------------------------------------------------------------

async function handleFindByPreference(
  req: CoreRequest,
  findFn: (category: string) => Contact[],
): Promise<CoreResponse> {
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  if (category === '') {
    return jsonError(400, 'category query parameter is required');
  }
  const contacts = findFn(category);
  return {
    status: 200,
    body: { contacts, count: contacts.length },
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/contacts/:did
// ---------------------------------------------------------------------------

/**
 * Body shape accepted by the PUT endpoint.
 *
 * `preferred_for` uses undefined ↔ don't-touch, `[]` ↔ clear-all
 * semantics. An explicit `null` is rejected at the parse layer so
 * callers can't accidentally clear via a truthy-check bug.
 */
interface UpdateContactBody {
  preferred_for?: unknown;
}

const UPDATE_BODY_MAX_BYTES = 16 * 1024;

async function handleUpdateContact(
  req: CoreRequest,
  setFn: (did: string, categories: readonly string[]) => void,
  getFn: (did: string) => Contact | null,
): Promise<CoreResponse> {
  if (req.rawBody.byteLength > UPDATE_BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${UPDATE_BODY_MAX_BYTES} bytes`);
  }
  const did = typeof req.params.did === 'string' ? req.params.did.trim() : '';
  if (did === '') {
    return jsonError(400, 'did path parameter is required');
  }
  if (getFn(did) === null) {
    return jsonError(404, `contact ${did} not found`);
  }

  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const body = req.body as UpdateContactBody;

  // preferred_for uses tri-state "don't touch / clear / replace".
  // undefined  → untouched (no-op for this field).
  // []         → clear all preferences.
  // string[]   → replace. Normalisation happens inside setPreferredFor.
  // Everything else → 400.
  if (body.preferred_for !== undefined) {
    if (!Array.isArray(body.preferred_for)) {
      return jsonError(400, 'preferred_for must be an array of strings');
    }
    const categories = body.preferred_for;
    for (const c of categories) {
      if (typeof c !== 'string') {
        return jsonError(400, 'preferred_for entries must be strings');
      }
    }
    try {
      setFn(did, categories as string[]);
    } catch (err) {
      return jsonError(500, (err as Error).message);
    }
  }

  return { status: 200, body: { status: 'updated' } };
}

// ---------------------------------------------------------------------------
// POST /v1/contacts
// ---------------------------------------------------------------------------

/** Body shape accepted by the POST endpoint. */
interface AddContactBody {
  did?: unknown;
  display_name?: unknown;
  trust_level?: unknown;
}

const ADD_BODY_MAX_BYTES = 16 * 1024;

/**
 * Add (or no-op-return) a contact. Idempotent — re-adding an existing
 * contact returns `{ created: false }` rather than erroring, so a seed
 * step is safe to re-run. Defaults the trust level to `verified` because
 * an explicit add-over-the-API is a deliberate "I know this peer" action;
 * pass `trust_level` to override.
 */
async function handleAddContact(
  req: CoreRequest,
  addFn: (
    did: string,
    displayName: string,
    trustLevel?: TrustLevel,
  ) => { contact: Contact; created: boolean },
): Promise<CoreResponse> {
  if (req.rawBody.byteLength > ADD_BODY_MAX_BYTES) {
    return jsonError(413, `body exceeds ${ADD_BODY_MAX_BYTES} bytes`);
  }
  if (req.body === undefined || req.body === null || typeof req.body !== 'object') {
    return jsonError(400, 'body must be a JSON object');
  }
  const body = req.body as AddContactBody;
  const did = typeof body.did === 'string' ? body.did.trim() : '';
  if (did === '') {
    return jsonError(400, 'did is required');
  }
  const displayName =
    typeof body.display_name === 'string' && body.display_name.trim() !== ''
      ? body.display_name.trim()
      : did;
  // Validate against the real enum — never cast a raw wire string. The
  // projection treats anything !== 'blocked' as gate-eligible, so a bogus
  // trust_level would otherwise make the contact effectively trusted.
  if (body.trust_level !== undefined && !isTrustLevel(body.trust_level)) {
    return jsonError(400, `invalid trust_level (expected one of: ${TRUST_LEVELS.join(', ')})`);
  }
  const trustLevel: TrustLevel = body.trust_level ?? 'verified';
  try {
    const { contact, created } = addFn(did, displayName, trustLevel);
    return { status: 200, body: { contact, created } };
  } catch (err) {
    return jsonError(500, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}
