/**
 * Format a service-query workflow event into a user-facing notification.
 *
 * Flow: Core's `CompleteWithDetails` (success / unavailable / error) or
 * `ExpireTasks` (timeout) produces a `WorkflowEvent` whose `details` payload
 * arrives at the requester's Brain. Guardian dispatches the event via
 * `D2DDispatcher` → a consumer registered by the orchestrator → this
 * formatter → the chat/telegram surface.
 *
 * The formatter is a **pure** function: no side effects, no network, no
 * persistence. Given the same `details`, the output is deterministic. This
 * makes the downstream UX trivially testable.
 *
 * Source: brain/src/service/service_query.py
 *         (format_service_query_result + _format_eta + _format_generic)
 */

import type { EtaQueryResult, EtaQueryStatus } from './capabilities/eta_query';

/** Shape Core emits in `workflow_event.details` for service_query tasks. */
export interface ServiceQueryEventDetails {
  /** One of "success" | "unavailable" | "error" | "expired". */
  response_status?: string;
  /** Capability name (e.g. "eta_query"). */
  capability?: string;
  /** Published service name — used as the display label. */
  service_name?: string;
  /**
   * Capability-specific result payload. Accepted as either a parsed JSON
   * object or its JSON string form (matches Core's mixed delivery).
   */
  result?: unknown;
  /** Populated on status === 'error'. */
  error?: string;
}

/**
 * Produce a single-string notification from a workflow event's details.
 *
 * Never throws. Unknown statuses or malformed payloads fall back to a
 * minimal "unexpected status" line so the user always gets a response.
 */
export function formatServiceQueryResult(details: ServiceQueryEventDetails): string {
  const status = details.response_status ?? '';
  const capability = details.capability ?? '';
  const serviceName =
    details.service_name !== undefined && details.service_name !== ''
      ? details.service_name
      : 'Service';

  if (status === 'expired') {
    return `No response from ${serviceName}.`;
  }
  if (status === 'success') {
    const formatter = FORMATTERS[capability] ?? formatGeneric;
    return formatter(details, serviceName);
  }
  if (status === 'unavailable') {
    // Issue #12: surface the reason when the provider supplied one
    // (e.g. 'approval_expired', 'not_on_route'). Generic fallback
    // preserves prior behaviour for providers that sent no reason.
    const reason =
      typeof details.error === 'string' && details.error !== '' ? ` (${details.error})` : '';
    return `${serviceName} — service unavailable${reason}.`;
  }
  if (status === 'error') {
    const errText =
      typeof details.error === 'string' && details.error !== '' ? details.error : 'unknown';
    return `${serviceName} — error: ${errText}`;
  }
  return `${serviceName} — unexpected status: ${status || '(empty)'}.`;
}

/**
 * Per-capability formatter table. New capabilities register here alongside
 * their registry entries. The fallback `formatGeneric` covers unregistered
 * capabilities without requiring updates to this module.
 */
const FORMATTERS: Record<string, (details: ServiceQueryEventDetails, name: string) => string> = {
  eta_query: formatEta,
  appointment_status: formatAppointmentStatus,
};

// ---------------------------------------------------------------------------
// eta_query
// ---------------------------------------------------------------------------

/**
 * Format an `EtaQueryResult` for plain-text chat.
 *
 * Output uses plain URLs (no Markdown link syntax) so Telegram's
 * auto-linkification renders them without requiring `parse_mode`.
 *
 * Cases:
 *   - `status: "not_on_route"` / `"out_of_service"` / `"not_found"` —
 *     surface `result.message` if present, else a generic fallback.
 *   - `status: "on_route"` (default) — build a multi-line summary with
 *     vehicle/route label, ETA (either "X min to <stop>" or "X minutes
 *     away"), and optional map URL.
 */
function formatEta(details: ServiceQueryEventDetails, name: string): string {
  const result = parseResultObject(details.result);
  const status: EtaQueryStatus = (result.status as EtaQueryStatus | undefined) ?? 'on_route';

  if (status === 'not_on_route') {
    return nonEmptyString(result.message) ?? `${name} doesn't serve your area.`;
  }
  if (status === 'out_of_service') {
    return nonEmptyString(result.message) ?? `${name} is not running at this time.`;
  }
  if (status === 'not_found') {
    return nonEmptyString(result.message) ?? `${name} — route not found.`;
  }

  // on_route: build the summary lines.
  const vehicle = nonEmptyString(result.vehicle_type) ?? 'Bus';
  const route = nonEmptyString(result.route_name);
  const routeLabel = route !== undefined ? `${vehicle} ${route}` : name;

  const lines: string[] = [routeLabel];

  const eta = typeof result.eta_minutes === 'number' ? result.eta_minutes : undefined;
  const stop = nonEmptyString(result.stop_name);

  if (eta !== undefined && stop !== undefined) {
    lines.push(`${eta} min to ${stop}`);
  } else if (eta !== undefined) {
    lines.push(`${eta} minutes away`);
  }

  const mapUrl = nonEmptyString(result.map_url);
  if (mapUrl !== undefined) {
    lines.push(mapUrl);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// appointment_status (WM-BRAIN-10)
// ---------------------------------------------------------------------------

/**
 * Format an appointment_status provider reply (Dr Carl demo).
 *
 * Port of `brain/src/service/service_query.py::_format_appointment_status`
 * from main-dina commits `17b12d1` + `50b48d7`. The provenance-first
 * header is load-bearing — it tells the user "this is a live reply
 * from an external provider, not Dina reasoning over the vault." See
 * the `test_service_query_formatters.py::test_never_returns_raw_json`
 * invariant: an unknown status must still degrade to a graceful
 * sentence, never a JSON dump.
 *
 * Expected result shape (from the provider):
 *   status: "confirmed" | "rescheduled" | "cancelled" | "not_found"
 *   date:   echoed back (may be empty)
 *   time:   echoed back (may be empty)
 *   note:   provider free-text (may be empty)
 *
 * The "when" clause is assembled defensively so empty date/time
 * collapse cleanly (no "on at" artifacts).
 */
function formatAppointmentStatus(details: ServiceQueryEventDetails, name: string): string {
  const result = parseResultObject(details.result);
  const status = stringOrEmpty(result.status).trim().toLowerCase();
  const date = stringOrEmpty(result.date).trim();
  const time = stringOrEmpty(result.time).trim();
  const note = stringOrEmpty(result.note).trim();

  // Build the " on <date> at <time>" (or partial) clause once.
  // Starts with a leading space so callers can concatenate directly
  // without worrying about double-spacing.
  let when = '';
  if (date !== '' && time !== '') {
    when = ` on ${date} at ${time}`;
  } else if (date !== '') {
    when = ` on ${date}`;
  } else if (time !== '') {
    when = ` at ${time}`;
  }

  const header = `\u{1F4EC} Reply from ${name}`; // 📬

  if (status === 'confirmed') {
    return `${header}\nYour appointment${when} is confirmed.`;
  }
  if (status === 'rescheduled') {
    let body = 'Your appointment has been rescheduled';
    if (when !== '') body += ` to${when}`;
    body += '.';
    if (note !== '') body += `\n${note}`;
    return `${header}\n${body}`;
  }
  if (status === 'cancelled') {
    let body = 'Your appointment has been cancelled.';
    if (note !== '') body += `\n${note}`;
    return `${header}\n${body}`;
  }
  if (status === 'not_found') {
    return `${header}\nNo record of your appointment was found.`;
  }
  // Unknown / missing / malformed status — NEVER dump JSON. Graceful
  // one-line fallback so the never-raw-JSON invariant holds.
  return `${header}\nUnexpected status: ${status === '' ? 'unknown' : status}`;
}

/**
 * Read an arbitrary `raw` value as a string, returning '' on anything
 * that is not a string (undefined / number / object). Used to coerce
 * fields off a loosely-typed `parseResultObject` return before we
 * trim and branch.
 */
function stringOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

/**
 * Catch-all formatter for capabilities that haven't registered a
 * bespoke renderer yet. Shows a truncated JSON stringification so the user
 * at least sees *something* rather than a silent empty bubble.
 */
function formatGeneric(details: ServiceQueryEventDetails, name: string): string {
  const result = parseResultObject(details.result);
  const summary = truncate(JSON.stringify(result), 200);
  return `${name} — response received: ${summary}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a `details.result` that may arrive as either a parsed object
 * (preferred) or as its JSON-string form. Malformed strings collapse to an
 * empty object — we never throw out of this module.
 */
function parseResultObject(raw: unknown): Partial<EtaQueryResult> & Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

/** Returns the string if it is a non-empty string, otherwise `undefined`. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}
