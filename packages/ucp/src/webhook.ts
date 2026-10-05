/**
 * An incoming order webhook, read before anything is looked up or fetched
 * (order/index.md "Events"; UCP plan §3.13).
 *
 * Headers follow Standard Webhooks (`Webhook-Id`, `Webhook-Timestamp`) except
 * for signing, which is RFC 9421 (`Signature`, `Signature-Input`,
 * `Content-Digest`); `UCP-Agent` names the business's profile. A business
 * always names its root `/.well-known/ucp`, so the origin of that URL is
 * whose webhook this claims to be. The body is the full order entity.
 *
 * Nothing here trusts the sender: the reader only checks that the delivery
 * has what Dina needs to look it up. The signature is checked later, against
 * the keys of the profile the header names, and only for a delivery about a
 * session or order Dina holds under that origin.
 */

import { isPlainObject, parseStrictJson } from '@dina/a2a';

import { readHttpsUrl } from './resource';
import { dictGet, parseDictionary, SfParseError } from './sf';

/** The largest webhook body Dina reads (§3.13 step 1). */
export const WEBHOOK_MAX_BYTES = 512 * 1024;
/** The headers a webhook delivery carries into Core; any other is left at the edge. */
export const WEBHOOK_HEADERS = [
  'content-type',
  'content-digest',
  'signature',
  'signature-input',
  'ucp-agent',
  'webhook-id',
  'webhook-timestamp',
] as const;
/** The one path a business's root profile lives at. */
const ROOT_PROFILE_PATH = '/.well-known/ucp';
/** A Standard Webhooks id is opaque; Dina keeps at most this much of it. */
const MAX_WEBHOOK_ID = 256;

/** The profile URL in a `UCP-Agent` header (`profile="<url>"`); null when there is none or it is not https. */
export function readUcpAgentProfile(header: string): string | null {
  try {
    const member = dictGet(parseDictionary(header), 'profile');
    if (member?.kind !== 'item' || member.value.type !== 'string') return null;
    return readHttpsUrl(member.value.value);
  } catch (err) {
    if (err instanceof SfParseError) return null;
    throw err;
  }
}

export interface WebhookDelivery {
  /** The business's origin, from its root profile URL in `UCP-Agent`. */
  origin: string;
  /** That root profile URL, exactly. */
  profileUrl: string;
  webhookId: string;
  /** `Webhook-Timestamp`, in milliseconds. */
  timestampMs: number;
  orderId: string;
  checkoutId: string;
  /** The parsed body (the order entity as sent). */
  body: Record<string, unknown>;
}

export type WebhookRead =
  | { ok: true; delivery: WebhookDelivery }
  | {
      ok: false;
      reason:
        | 'too_large'
        | 'header_missing'
        | 'agent_invalid'
        | 'not_root_profile'
        | 'timestamp_invalid'
        | 'body_invalid';
    };

/**
 * Read a delivery's lookup fields: lower-case header names, the exact body
 * bytes. A refusal names what was missing, for the log; the sender is never
 * told which.
 */
export function readWebhookDelivery(
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
): WebhookRead {
  if (body.byteLength > WEBHOOK_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const agent = headers['ucp-agent'];
  const webhookId = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  if (
    agent === undefined ||
    webhookId === undefined ||
    timestamp === undefined ||
    headers['signature'] === undefined ||
    headers['signature-input'] === undefined ||
    headers['content-digest'] === undefined
  )
    return { ok: false, reason: 'header_missing' };
  if (webhookId === '' || webhookId.length > MAX_WEBHOOK_ID)
    return { ok: false, reason: 'header_missing' };
  const profileUrl = readUcpAgentProfile(agent);
  if (profileUrl === null) return { ok: false, reason: 'agent_invalid' };
  const url = new URL(profileUrl);
  if (url.pathname !== ROOT_PROFILE_PATH || url.search !== '' || url.hash !== '')
    return { ok: false, reason: 'not_root_profile' };
  if (!/^[0-9]{1,12}$/.test(timestamp)) return { ok: false, reason: 'timestamp_invalid' };
  // UTF-8 checked, then strict JSON (duplicate members and `__proto__` refused), as every
  // merchant answer is read.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { ok: false, reason: 'body_invalid' };
  }
  const strict = parseStrictJson(text);
  if (!strict.ok) return { ok: false, reason: 'body_invalid' };
  const parsed: unknown = strict.value;
  if (
    !isPlainObject(parsed) ||
    typeof parsed.id !== 'string' ||
    parsed.id === '' ||
    typeof parsed.checkout_id !== 'string' ||
    parsed.checkout_id === ''
  )
    return { ok: false, reason: 'body_invalid' };
  return {
    ok: true,
    delivery: {
      origin: url.origin,
      profileUrl,
      webhookId,
      timestampMs: Number(timestamp) * 1000,
      orderId: parsed.id,
      checkoutId: parsed.checkout_id,
      body: parsed,
    },
  };
}
