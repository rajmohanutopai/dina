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

import {
  findByPreferredFor as directoryFindByPreferredFor,
  setPreferredFor as directorySetPreferredFor,
  getContact,
  isTrustLevel,
  TRUST_LEVELS,
  resolveByName as directoryResolveByName,
  findByAlias as directoryFindByAlias,
  addContactIfNotExists as directoryAddContactIfNotExists,
  updateContact as directoryUpdateContact,
  listContacts as directoryListContacts,
  deleteContact as directoryDeleteContact,
  setPaperIdentity as directorySetPaperIdentity,
  setContactChannels as directorySetContactChannels,
  checkPaperIdentity as directoryCheckPaperIdentity,
  checkContactChannels as directoryCheckContactChannels,
} from '../../contacts/directory';
import {
  getServiceDecisionRepository,
  type ServiceDecision,
} from '../../contacts/service_decisions_repository';

import {
  CONTACTS_BY_PREFERENCE,
  CONTACTS_LOOKUP,
  CONTACTS_SERVICE_DECISIONS,
  CONTACT_UPDATE,
  CONTACTS_ROOT,
} from './paths';

import type { TaxRegistration, TradeIdentityFinding } from '../../commerce/trade_identity';
import type { Contact, TrustLevel } from '../../contacts/directory';
import type { CoreRequest, CoreResponse, CoreRouter } from '../router';


/**
 * Dependencies for the contacts handlers. All callers resolve the
 * contact state via the module-global directory (set up at boot);
 * tests can inject fakes here instead of reaching into the directory
 * so the handlers stay unit-testable without a full app boot.
 */
export interface ContactRoutesOptions {
  /** List all contacts (backs `GET /v1/contacts`). Defaults to the
   *  module-global directory function; tests inject their own fake. */
  listContacts?: () => Contact[];
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
  /**
   * List the owner-private contact-service decision log (newest first).
   * Defaults to the module-global decision repository; returns `[]` when no
   * repo is wired. Tests inject a fake.
   */
  listServiceDecisions?: (limit: number) => ServiceDecision[];
  /**
   * Set a contact's paper identity (§5.D — legal name / registrations /
   * billing address). Defaults to the module-global directory; returns the
   * findings, so a refusal names every problem at once.
   */
  setPaperIdentity?: (
    did: string,
    identity: Parameters<typeof directorySetPaperIdentity>[1],
  ) => TradeIdentityFinding[];
  /**
   * Set a contact's messaging channels (§5.D — phone / e-mail, stored in the
   * people graph). Defaults to the module-global directory.
   */
  setContactChannels?: (
    did: string,
    channels: Parameters<typeof directorySetContactChannels>[1],
  ) => TradeIdentityFinding[];
  /**
   * Judge a paper identity / channels WITHOUT writing. The route checks BOTH
   * halves of a trade-details save before committing either, so a refusal on
   * one never leaves the other applied. Default to the directory's own.
   */
  checkPaperIdentity?: (
    did: string,
    identity: Parameters<typeof directorySetPaperIdentity>[1],
  ) => TradeIdentityFinding[];
  checkContactChannels?: (
    did: string,
    channels: Parameters<typeof directorySetContactChannels>[1],
  ) => TradeIdentityFinding[];
  /**
   * Remove a contact. Defaults to the module-global directory. Backs
   * DELETE /v1/contacts/:did — so the web thin-client (no in-process
   * directory) can remove a contact from the authoritative Core store
   * instead of a non-authoritative local copy. Returns true when a row
   * was removed, false when the DID wasn't a contact.
   */
  deleteContact?: (did: string) => boolean;
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
  serviceDecisions: (req: CoreRequest) => Promise<CoreResponse>;
  listAll: (req: CoreRequest) => Promise<CoreResponse>;
  deleteContact: (req: CoreRequest) => Promise<CoreResponse>;
} {
  const findFn = options.findByPreferredFor ?? directoryFindByPreferredFor;
  const setFn = options.setPreferredFor ?? directorySetPreferredFor;
  const getFn = options.getContact ?? getContact;
  const resolveNameFn = options.resolveByName ?? directoryResolveByName;
  const findAliasFn = options.findByAlias ?? directoryFindByAlias;
  const addFn = options.addContact ?? directoryAddContactIfNotExists;
  const listAllFn = options.listContacts ?? directoryListContacts;
  const listDecisionsFn =
    options.listServiceDecisions ??
    ((limit: number) => getServiceDecisionRepository()?.list(limit) ?? []);
  const deleteFn = options.deleteContact ?? directoryDeleteContact;
  const setPaperFn = options.setPaperIdentity ?? directorySetPaperIdentity;
  const setChannelsFn = options.setContactChannels ?? directorySetContactChannels;
  const checkPaperFn = options.checkPaperIdentity ?? directoryCheckPaperIdentity;
  const checkChannelsFn = options.checkContactChannels ?? directoryCheckContactChannels;
  return {
    findByPreference: (req) => handleFindByPreference(req, findFn),
    updateContact: (req) =>
      handleUpdateContact(req, {
        setPreferredFor: setFn,
        getContact: getFn,
        setPaperIdentity: setPaperFn,
        setContactChannels: setChannelsFn,
        checkPaperIdentity: checkPaperFn,
        checkContactChannels: checkChannelsFn,
      }),
    lookup: (req) => handleLookup(req, getFn, resolveNameFn, findAliasFn),
    addContact: (req) => handleAddContact(req, addFn),
    serviceDecisions: (req) => handleServiceDecisions(req, listDecisionsFn),
    listAll: (req) => handleListContacts(req, listAllFn),
    deleteContact: (req) => handleDeleteContact(req, deleteFn),
  };
}

export function registerContactsRoutes(
  router: CoreRouter,
  options: ContactRoutesOptions = {},
): void {
  const {
    findByPreference,
    updateContact,
    lookup,
    addContact,
    serviceDecisions,
    listAll,
    deleteContact,
  } = makeContactsHandlers(options);
  router.get(CONTACTS_BY_PREFERENCE, findByPreference);
  router.get(CONTACTS_LOOKUP, lookup);
  // Register the literal sub-path BEFORE the catch-all PUT/:did so it isn't
  // shadowed; GET-only anyway, but kept adjacent to the other GET reads.
  router.get(CONTACTS_SERVICE_DECISIONS, serviceDecisions);
  router.put(CONTACT_UPDATE, updateContact);
  router.delete(CONTACT_UPDATE, deleteContact);
  router.post(CONTACTS_ROOT, addContact);
  // GET /v1/contacts — list ALL contacts (backs the web People/Talk screen,
  // whose `useContacts` reads the contact directory; in the thin-client the
  // in-process directory is empty, so it must fetch from Core). Registered
  // after the literal sub-paths so it matches only the exact root.
  router.get(CONTACTS_ROOT, listAll);
}

// ---------------------------------------------------------------------------
// GET /v1/contacts — list ALL contacts. Response: `{ contacts: Contact[] }`
// (owner-private; the whole /v1/contacts prefix is Brain + Admin only).
// ---------------------------------------------------------------------------
async function handleListContacts(
  _req: CoreRequest,
  listFn: () => Contact[],
): Promise<CoreResponse> {
  return { status: 200, body: { contacts: listFn() } };
}

// ---------------------------------------------------------------------------
// DELETE /v1/contacts/:did — remove a contact. Response: `{ deleted: boolean }`.
// `deleted=false` when the DID wasn't a contact — DELETE is idempotent, so a
// no-op is still 200, not 404. Owner-private (the whole prefix is Brain + Admin).
// ---------------------------------------------------------------------------
async function handleDeleteContact(
  req: CoreRequest,
  deleteFn: (did: string) => boolean,
): Promise<CoreResponse> {
  const did = typeof req.params.did === 'string' ? req.params.did.trim() : '';
  if (did === '') {
    return jsonError(400, 'did path parameter is required');
  }
  return { status: 200, body: { deleted: deleteFn(did) } };
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
  trust_level?: unknown;
  display_name?: unknown;
  /** §5.D — the paper identity, all tri-state like `preferred_for`. */
  legal_name?: unknown;
  registrations?: unknown;
  billing_address?: unknown;
  /** §5.D — the channels a rail would message. Stored in the people graph. */
  phone?: unknown;
  email?: unknown;
}

const UPDATE_BODY_MAX_BYTES = 16 * 1024;

interface UpdateContactDeps {
  setPreferredFor: (did: string, categories: readonly string[]) => void;
  getContact: (did: string) => Contact | null;
  setPaperIdentity: (did: string, identity: Parameters<typeof directorySetPaperIdentity>[1]) => TradeIdentityFinding[];
  setContactChannels: (
    did: string,
    channels: Parameters<typeof directorySetContactChannels>[1],
  ) => TradeIdentityFinding[];
  checkPaperIdentity: (did: string, identity: Parameters<typeof directorySetPaperIdentity>[1]) => TradeIdentityFinding[];
  checkContactChannels: (
    did: string,
    channels: Parameters<typeof directorySetContactChannels>[1],
  ) => TradeIdentityFinding[];
}

async function handleUpdateContact(req: CoreRequest, deps: UpdateContactDeps): Promise<CoreResponse> {
  const setFn = deps.setPreferredFor;
  const getFn = deps.getContact;
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

  // trust_level / display_name — the two policy fields a server owner
  // can otherwise never change (the invite ceremony writes 'verified',
  // but a hand-added contact starts 'unknown', and the inbound
  // commerce.trade gate refuses 'unknown'). Until now these fields were
  // SILENTLY IGNORED and the route still answered "updated".
  if (body.trust_level !== undefined) {
    if (!isTrustLevel(body.trust_level)) {
      return jsonError(400, `trust_level must be one of: ${TRUST_LEVELS.join(', ')}`);
    }
    try {
      directoryUpdateContact(did, { trustLevel: body.trust_level });
    } catch (err) {
      return jsonError(500, (err as Error).message);
    }
  }
  if (body.display_name !== undefined) {
    if (typeof body.display_name !== 'string' || body.display_name.trim() === '') {
      return jsonError(400, 'display_name must be a non-empty string');
    }
    try {
      directoryUpdateContact(did, { displayName: body.display_name });
    } catch (err) {
      return jsonError(500, (err as Error).message);
    }
  }

  // §5.D — the paper identity. Read the three fields together and apply them
  // in ONE domain call: a caller correcting a GSTIN and an address at once gets
  // both findings, and a refusal leaves neither half applied.
  const wantsPaper =
    body.legal_name !== undefined || body.registrations !== undefined || body.billing_address !== undefined;
  let paperIdentity: Parameters<typeof directorySetPaperIdentity>[1] | null = null;
  if (wantsPaper) {
    const identity: Parameters<typeof directorySetPaperIdentity>[1] = {};
    if (body.legal_name !== undefined) {
      if (typeof body.legal_name !== 'string') return jsonError(400, 'legal_name must be a string');
      identity.legalName = body.legal_name;
    }
    if (body.registrations !== undefined) {
      if (!Array.isArray(body.registrations)) {
        return jsonError(400, 'registrations must be an array of {scheme, value}');
      }
      const registrations: TaxRegistration[] = [];
      for (const entry of body.registrations) {
        const row = (entry ?? {}) as Record<string, unknown>;
        if (typeof row.scheme !== 'string' || typeof row.value !== 'string') {
          return jsonError(400, 'each registration needs a string scheme and value');
        }
        registrations.push({ scheme: row.scheme as TaxRegistration['scheme'], value: row.value });
      }
      identity.registrations = registrations;
    }
    if (body.billing_address !== undefined) {
      if (body.billing_address === null) {
        identity.billingAddress = null;
      } else {
        const wire = body.billing_address as Record<string, unknown>;
        if (typeof wire !== 'object') return jsonError(400, 'billing_address must be an object or null');
        const text = (value: unknown): string => (typeof value === 'string' ? value : '');
        identity.billingAddress = {
          line1: text(wire.line1),
          ...(text(wire.line2) !== '' ? { line2: text(wire.line2) } : {}),
          city: text(wire.city),
          ...(text(wire.region) !== '' ? { region: text(wire.region) } : {}),
          ...(text(wire.postal_code) !== '' ? { postalCode: text(wire.postal_code) } : {}),
          country: text(wire.country),
        };
      }
    }
    paperIdentity = identity;
  }

  // §5.D — the channels a rail would message. Same tri-state: absent leaves
  // them, an empty string or null clears one.
  let channelsInput: Parameters<typeof directorySetContactChannels>[1] | null = null;
  if (body.phone !== undefined || body.email !== undefined) {
    const channels: Parameters<typeof directorySetContactChannels>[1] = {};
    for (const field of ['phone', 'email'] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (value !== null && typeof value !== 'string') {
        return jsonError(400, `${field} must be a string or null`);
      }
      channels[field] = value;
    }
    channelsInput = channels;
  }

  // ALL OR NOTHING across the two stores. The paper identity lives on the
  // contact row and the channels in the people graph; judging both before
  // committing either is what makes "identity_invalid" mean the same thing
  // whichever half objected — nothing was written.
  if (paperIdentity !== null || channelsInput !== null) {
    let findings: TradeIdentityFinding[];
    try {
      findings = [
        ...(paperIdentity !== null ? deps.checkPaperIdentity(did, paperIdentity) : []),
        ...(channelsInput !== null ? deps.checkContactChannels(did, channelsInput) : []),
      ];
    } catch (err) {
      return jsonError(500, (err as Error).message);
    }
    if (findings.length > 0) {
      return { status: 400, body: { error: 'identity_invalid', findings } };
    }
    try {
      if (paperIdentity !== null) deps.setPaperIdentity(did, paperIdentity);
      if (channelsInput !== null) deps.setContactChannels(did, channelsInput);
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
// GET /v1/contacts/service-decisions?limit=N — owner-private decision log
// ---------------------------------------------------------------------------
//
// The grantor's reviewable record of inbound grant-requests + how policy
// responded (CONTACT_SERVICES_ARCHITECTURE.md §2/§10). Surfaced in the Activity
// tab. OWNER-PRIVATE: this sub-path is carved out of the broader `/v1/contacts`
// rule to allow ONLY the owner's surfaces (Admin + Device) — Brain is explicitly
// denied so the LLM can't read social-tier outcomes (see authz.ts). The data is
// never sent to a requester. Read-only.

const DECISIONS_DEFAULT_LIMIT = 100;
const DECISIONS_MAX_LIMIT = 500;

async function handleServiceDecisions(
  req: CoreRequest,
  listFn: (limit: number) => ServiceDecision[],
): Promise<CoreResponse> {
  const raw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
  const limit =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, DECISIONS_MAX_LIMIT) : DECISIONS_DEFAULT_LIMIT;
  const decisions = listFn(limit);
  return { status: 200, body: { decisions, count: decisions.length } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): CoreResponse {
  return { status, body: { error: message } };
}
