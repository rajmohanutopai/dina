/**
 * Transport-agnostic response types for chat commands.
 *
 * Port of `brain/src/domain/response.py`. Every command handler
 * produces one of these shapes; channel renderers (mobile-UI native
 * card components, Telegram MarkdownV2, Bluesky facets, CLI text)
 * decide how to present each kind. The contract:
 *
 *   - Handlers DO NOT format for a specific transport — they return
 *     structured data in a typed envelope.
 *   - Every envelope carries a `text` field that's a safe plain-
 *     language rendering, so a channel that can't render a particular
 *     kind (e.g. a text-only log tail) still has something to show.
 *   - The mobile UI uses the `kind` discriminator to pick a card
 *     component: `TrustScoreCard`, `ContactListView`, `ConfirmDialog`,
 *     `StatusPanel`, etc.
 *
 * This is a pure types + constructor module — no side effects, no
 * imports from app layers. Safe to read from the mobile UI.
 */

// ---------------------------------------------------------------------------
// Base + format hint
// ---------------------------------------------------------------------------

/**
 * Format hint for channels that honour it. PLAIN = channel should not
 * apply rich-text styling. RICH = channel may use native formatting
 * (bold / italic / code spans) for the `text` field. Mobile-UI
 * typically ignores this and renders via the `kind` dispatcher.
 */
export type TextFormat = 'plain' | 'rich';

/**
 * The discriminated-union parent. Every concrete response has:
 *   - `kind` — the discriminator the UI reads.
 *   - `text` — safe plain-language rendering for channels that don't
 *     know the kind (acts as the telegram/CLI fallback body).
 *   - `format` — rich-text hint.
 */
export interface BotResponseBase {
  text: string;
  format?: TextFormat;
}

// ---------------------------------------------------------------------------
// Concrete kinds
// ---------------------------------------------------------------------------

/** Plain text response — the default for any handler that has no
 *  structured payload. Matches Python's base `BotResponse`. */
export interface PlainResponse extends BotResponseBase {
  kind: 'plain';
}

/** Rich-text response — same body shape as plain, just flagging the
 *  channel may apply native formatting. Matches Python's
 *  `RichResponse`. */
export interface RichResponse extends BotResponseBase {
  kind: 'rich';
  format: 'rich';
}

/** One option a user can pick in a `ConfirmResponse`. */
export interface ConfirmOption {
  /** Button label — channel picks the visual treatment. */
  label: string;
  /** Stable action identifier the handler expects back (e.g. "confirm",
   *  "cancel", "block", "trust"). */
  action: string;
  /** Opaque data the channel echoes back with the action. Use for
   *  request-correlation ids or pre-validated args. */
  data?: Record<string, unknown>;
}

/** Response that asks the user to pick an option before anything
 *  happens. Matches Python's `ConfirmResponse`. Mobile UI renders
 *  this as a modal / action sheet. */
export interface ConfirmResponse extends BotResponseBase {
  kind: 'confirm';
  format: 'rich';
  options: ConfirmOption[];
}

/** Node status envelope — rendered as a status card on mobile. Matches
 *  Python's `StatusResponse`. */
export interface StatusResponse extends BotResponseBase {
  kind: 'status';
  did: string;
  status: string;
  version: string;
}

/** One contact in a `ContactListResponse`. Loose-typed because
 *  different callers carry different subsets of contact fields.
 *  `displayName` + `did` are the minimum the UI needs to render a
 *  row. */
export interface ContactListEntry {
  displayName: string;
  did: string;
  relationship?: string;
  data_responsibility?: string;
  trustLevel?: string;
  [key: string]: unknown;
}

/** Contact-list response — rendered as a list view on mobile. */
export interface ContactListResponse extends BotResponseBase {
  kind: 'contact_list';
  contacts: ContactListEntry[];
}

/** Trust-score response — rendered as a trust card. Matches Python's
 *  `TrustScoreResponse`. */
export interface TrustScoreResponse extends BotResponseBase {
  kind: 'trust_score';
  displayName: string;
  did: string;
  /** Overall score — numeric (0-1) or a descriptor ("trusted",
   *  "unverified", "untrusted"). Leaves room for whatever the trust
   *  resolver returns; UI displays as-is. */
  score: number | string | null;
  totalAttestations: number;
  positiveAttestations: number;
  vouchCount: number;
}

/** D2D-send confirmation. */
export interface SendResponse extends BotResponseBase {
  kind: 'send';
  contact: string;
  messageType: string;
  messageText: string;
}

/** Error envelope. Matches Python's `ErrorResponse`. Carries the
 *  same `text` the UI shows but `kind:'error'` lets the UI style it
 *  differently (red banner, error icon). */
export interface ErrorResponse extends BotResponseBase {
  kind: 'error';
}

/** Discriminated union — every handler returns one of these. */
export type BotResponse =
  | PlainResponse
  | RichResponse
  | ConfirmResponse
  | StatusResponse
  | ContactListResponse
  | TrustScoreResponse
  | SendResponse
  | ErrorResponse;

// ---------------------------------------------------------------------------
// Constructors — pure, keeps call sites tight
// ---------------------------------------------------------------------------

export const plainResponse = (text: string): PlainResponse => ({
  kind: 'plain',
  text,
  format: 'plain',
});

export const richResponse = (text: string): RichResponse => ({
  kind: 'rich',
  text,
  format: 'rich',
});

export const errorResponse = (text: string): ErrorResponse => ({
  kind: 'error',
  text,
  format: 'plain',
});

export const confirmResponse = (
  text: string,
  options: ConfirmOption[],
): ConfirmResponse => ({
  kind: 'confirm',
  text,
  format: 'rich',
  options,
});

export const statusResponse = (args: {
  did: string;
  status: string;
  version: string;
  text?: string;
}): StatusResponse => ({
  kind: 'status',
  text: args.text ?? `${args.status} (${args.version})`,
  did: args.did,
  status: args.status,
  version: args.version,
});

export const contactListResponse = (
  contacts: ContactListEntry[],
  text?: string,
): ContactListResponse => ({
  kind: 'contact_list',
  text: text ?? defaultContactListText(contacts),
  contacts,
});

export const trustScoreResponse = (args: {
  displayName: string;
  did: string;
  score: number | string | null;
  totalAttestations: number;
  positiveAttestations: number;
  vouchCount: number;
  text?: string;
}): TrustScoreResponse => ({
  kind: 'trust_score',
  text: args.text ?? defaultTrustScoreText(args),
  displayName: args.displayName,
  did: args.did,
  score: args.score,
  totalAttestations: args.totalAttestations,
  positiveAttestations: args.positiveAttestations,
  vouchCount: args.vouchCount,
});

export const sendResponse = (args: {
  contact: string;
  messageType: string;
  messageText: string;
  text?: string;
}): SendResponse => ({
  kind: 'send',
  text: args.text ?? `Sent ${args.messageType} to ${args.contact}.`,
  contact: args.contact,
  messageType: args.messageType,
  messageText: args.messageText,
});

// ---------------------------------------------------------------------------
// Helpers — rendering fallbacks so every typed response has a safe
// plain-text body for channels that don't know the kind.
// ---------------------------------------------------------------------------

function defaultContactListText(contacts: ContactListEntry[]): string {
  if (contacts.length === 0) return 'No contacts.';
  const lines = contacts
    .slice(0, 20)
    .map((c) => `- ${c.displayName} (${c.did.slice(0, 16)}…)`);
  const extra = contacts.length > 20 ? `\n… and ${contacts.length - 20} more.` : '';
  return `${contacts.length} contact${contacts.length === 1 ? '' : 's'}:\n${lines.join('\n')}${extra}`;
}

function defaultTrustScoreText(args: {
  displayName: string;
  score: number | string | null;
  totalAttestations: number;
  positiveAttestations: number;
  vouchCount: number;
}): string {
  const scoreStr = args.score === null ? 'no score' : String(args.score);
  return (
    `${args.displayName}: ${scoreStr}. ` +
    `${args.positiveAttestations}/${args.totalAttestations} positive attestations, ` +
    `${args.vouchCount} vouch${args.vouchCount === 1 ? '' : 'es'}.`
  );
}
