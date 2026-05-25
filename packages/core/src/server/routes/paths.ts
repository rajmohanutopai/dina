/**
 * Route path constants — single source of truth for all API paths.
 *
 * Every route, authz rule, and client call must reference these constants.
 * This prevents the exact class of bug where Brain calls /v1/staging/extend
 * but Core exposes /v1/staging/extend-lease.
 */

// ---------------------------------------------------------------
// Health
// ---------------------------------------------------------------

export const HEALTHZ = '/healthz';

// ---------------------------------------------------------------
// Vault
// ---------------------------------------------------------------

export const VAULT_STORE = '/v1/vault/store';
export const VAULT_STORE_BATCH = '/v1/vault/store/batch';
export const VAULT_QUERY = '/v1/vault/query';
export const VAULT_ITEM = '/v1/vault/item'; // + /:id
export const VAULT_KV = '/v1/vault/kv'; // + /:key

// ---------------------------------------------------------------
// Staging
// ---------------------------------------------------------------

export const STAGING_INGEST = '/v1/staging/ingest';
export const STAGING_CLAIM = '/v1/staging/claim';
export const STAGING_RESOLVE = '/v1/staging/resolve';
export const STAGING_FAIL = '/v1/staging/fail';
export const STAGING_EXTEND_LEASE = '/v1/staging/extend-lease';

// ---------------------------------------------------------------
// Identity
// ---------------------------------------------------------------

export const DID_ROOT = '/v1/did';
export const DID_SIGN = '/v1/did/sign';
export const DID_VERIFY = '/v1/did/verify';
export const DID_DOCUMENT = '/v1/did/document';

// ---------------------------------------------------------------
// Personas
// ---------------------------------------------------------------

export const PERSONAS_LIST = '/v1/personas';
export const PERSONA_UNLOCK = '/v1/persona/unlock';
export const PERSONA_LOCK = '/v1/persona/lock';

// ---------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------

export const CONTACTS_ROOT = '/v1/contacts';
/**
 * PC-CORE-10: contacts whose `preferred_for` list contains the given
 * category. Drives the reasoning agent's `find_preferred_provider`
 * tool — a dental-intent query looks up `category=dental` and gets
 * back the user's go-to dentist(s) without an AppView round-trip.
 */
export const CONTACTS_BY_PREFERENCE = '/v1/contacts/by-preference';
/** Look up one contact by DID / name / alias — GET ?q=… */
export const CONTACTS_LOOKUP = '/v1/contacts/lookup';
/** PC-CORE-11: PUT /v1/contacts/:did — update mutable contact fields. */
export const CONTACT_UPDATE = '/v1/contacts/:did';

// ---------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------

export const APPROVALS_ROOT = '/v1/approvals';

// ---------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------

// Collection root — POST creates, GET lists by `?persona=`.
export const REMINDERS_ROOT = '/v1/reminders';
// Pending sub-resource — GET lists every pending reminder due before `?now=`.
export const REMINDERS_PENDING = '/v1/reminders/pending';

// ---------------------------------------------------------------
// PII
// ---------------------------------------------------------------

export const PII_SCRUB = '/v1/pii/scrub';

// ---------------------------------------------------------------
// Audit
// ---------------------------------------------------------------

export const AUDIT_APPEND = '/v1/audit/append';
export const AUDIT_QUERY = '/v1/audit/query';
export const AUDIT_VERIFY = '/v1/audit/verify';

// ---------------------------------------------------------------
// Notify
// ---------------------------------------------------------------

export const NOTIFY = '/v1/notify';

// ---------------------------------------------------------------
// D2D Messaging
// ---------------------------------------------------------------

export const MSG_SEND = '/v1/msg/send';
export const MSG_INBOX = '/v1/msg/inbox';

// ---------------------------------------------------------------
// Devices
// ---------------------------------------------------------------

export const DEVICES_ROOT = '/v1/devices';

// ---------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------

export const EXPORT = '/v1/export';
export const IMPORT = '/v1/import';

// ---------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------

export const WORKFLOW_TASKS = '/v1/workflow/tasks';
export const WORKFLOW_TASKS_CLAIM = '/v1/workflow/tasks/claim';
/** `:id` suffixes for per-task endpoints. Interpolate with the actual id. */
export const WORKFLOW_TASK = (id: string): string => `/v1/workflow/tasks/${id}`;
export const WORKFLOW_TASK_HEARTBEAT = (id: string): string => `/v1/workflow/tasks/${id}/heartbeat`;
export const WORKFLOW_TASK_PROGRESS = (id: string): string => `/v1/workflow/tasks/${id}/progress`;
export const WORKFLOW_TASK_APPROVE = (id: string): string => `/v1/workflow/tasks/${id}/approve`;
export const WORKFLOW_TASK_CANCEL = (id: string): string => `/v1/workflow/tasks/${id}/cancel`;
export const WORKFLOW_TASK_COMPLETE = (id: string): string => `/v1/workflow/tasks/${id}/complete`;
export const WORKFLOW_TASK_FAIL = (id: string): string => `/v1/workflow/tasks/${id}/fail`;

export const WORKFLOW_EVENTS = '/v1/workflow/events';
export const WORKFLOW_EVENT_ACK = (id: number | string): string => `/v1/workflow/events/${id}/ack`;
export const WORKFLOW_EVENT_FAIL = (id: number | string): string =>
  `/v1/workflow/events/${id}/fail`;

// ---------------------------------------------------------------
// Service (requester-side query + provider-side respond)
// ---------------------------------------------------------------

export const SERVICE_QUERY = '/v1/service/query';
export const SERVICE_RESPOND = '/v1/service/respond';
export const SERVICE_CONFIG = '/v1/service/config';

// ---------------------------------------------------------------
// Working Memory (per-persona salience + ToC)
// ---------------------------------------------------------------

export const MEMORY_TOPIC_TOUCH = '/v1/memory/topic/touch';
export const MEMORY_TOC = '/v1/memory/toc';

// ---------------------------------------------------------------
// People graph — write-side endpoint used by Brain's post-publish
// people-graph extractor. Brain's drain composes the structured
// `ExtractionResult` from the LLM-derived links and POSTs it here;
// Core dispatches to the registered `PeopleRepository.applyExtraction`
// (the only sync method the drain needs).
// ---------------------------------------------------------------

export const PEOPLE_APPLY_EXTRACTION = '/v1/people/apply-extraction';
/** GET — list every confirmed/suggested person (rejected hidden). */
export const PEOPLE_LIST = '/v1/people';
/** GET — find people whose surfaces match a name (query: `?surface=Emma`). */
export const PEOPLE_FIND = '/v1/people/find';
/** GET — resolve a person by identity DID (query: `?did=did:plc:…`). */
export const PEOPLE_BY_DID = '/v1/people/by-did';

// ---------------------------------------------------------------
// Scratchpad — cognitive checkpoints for multi-step reasoning
// (nudge pipeline, agent-action approvals, crash-report staging).
// Scratchpad routes used by brain-side crash recovery. Matches the
// CoreClient client methods already in place (writeScratchpad/readScratchpad).
// ---------------------------------------------------------------

export const SCRATCHPAD = '/v1/scratchpad';

// ---------------------------------------------------------------
// User-facing API
// ---------------------------------------------------------------

export const API_ASK = '/api/v1/ask';
export const API_REMEMBER = '/api/v1/remember';

// ---------------------------------------------------------------
// Policy
// ---------------------------------------------------------------

export const POLICY_ACTIONS = '/v1/policy/actions';
export const POLICY_ACTION = '/v1/policy/actions/:action';
