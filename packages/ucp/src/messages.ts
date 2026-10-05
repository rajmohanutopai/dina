/**
 * UCP messages (common/types/message*.json; checkout/index.md:488-940).
 *
 *  - Codes are open strings, compared case-insensitively (plan A12; the spec's
 *    code table is upper-case while every schema and example is lower-case).
 *  - Warning content MUST be displayed; a `disclosure` must sit beside the item
 *    it names and never be hidden (:842-886).
 *  - `requires_buyer_input` / `requires_buyer_review` errors mean: hand off now.
 */

import { isPlainObject } from '@dina/a2a';

export type Severity =
  | 'recoverable'
  | 'requires_buyer_input'
  | 'requires_buyer_review'
  | 'unrecoverable';
const SEVERITIES: ReadonlySet<string> = new Set([
  'recoverable',
  'requires_buyer_input',
  'requires_buyer_review',
  'unrecoverable',
]);

export interface UcpErrorMessage {
  type: 'error';
  code: string;
  content: string;
  severity: Severity;
  path?: string;
  contentType: 'plain' | 'markdown';
}

export interface UcpWarningMessage {
  type: 'warning';
  code: string;
  content: string;
  presentation: 'notice' | 'disclosure';
  path?: string;
  imageUrl?: string;
  url?: string;
  contentType: 'plain' | 'markdown';
}

export interface UcpInfoMessage {
  type: 'info';
  code?: string;
  content: string;
  path?: string;
  contentType: 'plain' | 'markdown';
}

export type UcpMessage = UcpErrorMessage | UcpWarningMessage | UcpInfoMessage;

export interface MessagesParse {
  messages: UcpMessage[];
  /** Entries Dina could not read. Any one means Dina cannot render the answer faithfully: hand off. */
  unreadable: number;
}

function contentType(value: unknown): 'plain' | 'markdown' | null {
  if (value === undefined || value === 'plain') return 'plain';
  return value === 'markdown' ? 'markdown' : null;
}

export function parseMessages(value: unknown): MessagesParse {
  if (value === undefined) return { messages: [], unreadable: 0 };
  if (!Array.isArray(value)) return { messages: [], unreadable: 1 };
  const out: UcpMessage[] = [];
  let unreadable = 0;
  for (const m of value) {
    const parsed = parseMessage(m);
    if (parsed === null) unreadable++;
    else out.push(parsed);
  }
  return { messages: out, unreadable };
}

function parseMessage(m: unknown): UcpMessage | null {
  if (!isPlainObject(m) || typeof m.content !== 'string') return null;
  const ct = contentType(m.content_type);
  if (ct === null) return null;
  const path = typeof m.path === 'string' ? m.path : undefined;
  switch (m.type) {
    case 'error':
      if (
        typeof m.code !== 'string' ||
        typeof m.severity !== 'string' ||
        !SEVERITIES.has(m.severity)
      )
        return null;
      return {
        type: 'error',
        code: m.code.toLowerCase(),
        content: m.content,
        severity: m.severity as Severity,
        contentType: ct,
        ...(path !== undefined ? { path } : {}),
      };
    case 'warning': {
      if (typeof m.code !== 'string') return null;
      const presentation = m.presentation === undefined ? 'notice' : m.presentation;
      if (presentation !== 'notice' && presentation !== 'disclosure') return null;
      return {
        type: 'warning',
        code: m.code.toLowerCase(),
        content: m.content,
        presentation,
        contentType: ct,
        ...(path !== undefined ? { path } : {}),
        ...(typeof m.image_url === 'string' ? { imageUrl: m.image_url } : {}),
        ...(typeof m.url === 'string' ? { url: m.url } : {}),
      };
    }
    case 'info':
      return {
        type: 'info',
        content: m.content,
        contentType: ct,
        ...(typeof m.code === 'string' ? { code: m.code.toLowerCase() } : {}),
        ...(path !== undefined ? { path } : {}),
      };
    default:
      return null;
  }
}

/** Whether these messages require handing the person to the merchant now (checkout/index.md:499-513, 850-852). */
export function requiresHandoff(parsed: MessagesParse): boolean {
  if (parsed.unreadable > 0) return true;
  return parsed.messages.some(
    (m) =>
      (m.type === 'error' &&
        (m.severity === 'requires_buyer_input' || m.severity === 'requires_buyer_review')) ||
      // A disclosure with an image must be rendered with its image; Dina loads
      // no merchant images through U2 (plan §3.11), so the hand-off is the escalation.
      (m.type === 'warning' && m.presentation === 'disclosure' && m.imageUrl !== undefined),
  );
}

export function hasUnrecoverable(parsed: MessagesParse): boolean {
  return parsed.messages.some((m) => m.type === 'error' && m.severity === 'unrecoverable');
}
