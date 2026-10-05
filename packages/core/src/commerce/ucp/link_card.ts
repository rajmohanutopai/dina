/**
 * The `ucp_link_handoff` card (UCP plan §3.17): "Link your account at
 * <merchant>?", raised when a node whose callback is the Dina app's claimed
 * link (a server behind NAT) starts linking. The merchant's sign-in page must
 * open on the owner's phone, where the app catches the merchant's answer; the
 * card carries that page there, as the checkout hand-off does (§3.9).
 *
 * Core mints it (`CORE_MINTED_PAYLOAD_TYPES`) and a person must be present to
 * say yes (`PRESENCE_GATED_PAYLOAD_TYPES`): a person, not an agent, signs in
 * at a merchant. Its text is Core's: the merchant's host, what the link lets
 * Dina do, where the owner signs in, and until when.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { isPlainObject, parseStrictJson } from '@dina/a2a';

import { isMirrorableDetail, isMirrorableTitle } from '../../approval/mirror_text';

import { MAX_HANDOFF_URL_BYTES } from './handoff_card';

export const UCP_LINK_HANDOFF_TYPE = 'ucp_link_handoff';

export interface LinkCard {
  type: typeof UCP_LINK_HANDOFF_TYPE;
  /** The merchant's origin. */
  merchant: string;
  /** The authorization URL the owner opens (the merchant's sign-in page). */
  url: string;
  scopes: string[];
  /** When the pending link lapses, ms. */
  expires_at: number;
}

/** What a scope lets Dina do, in the owner's words; an unknown one by its name. */
export function linkScopeWords(scope: string): string {
  if (scope.endsWith('.order:read')) return 'read your orders';
  if (scope.endsWith('.checkout:manage')) return 'prepare checkouts';
  if (scope.endsWith('.cart:manage')) return 'manage carts';
  if (scope.endsWith('.catalog.search:read') || scope.endsWith('.catalog.lookup:read'))
    return 'search your account’s catalog';
  return scope;
}

/** The card for a link just started; null when its page cannot travel on a card. */
export function buildLinkCard(
  merchant: string,
  started: { url: string; scopes: readonly string[]; expiresAt: number },
): LinkCard | null {
  if (new TextEncoder().encode(started.url).byteLength > MAX_HANDOFF_URL_BYTES) return null;
  return {
    type: UCP_LINK_HANDOFF_TYPE,
    merchant,
    url: started.url,
    scopes: [...started.scopes],
    expires_at: started.expiresAt,
  };
}

function lines(card: LinkCard): string[] {
  const host = new URL(card.merchant).host;
  const signIn = new URL(card.url).host;
  return [
    `Link your account at ${host}?`,
    `Dina may ${card.scopes.map(linkScopeWords).join(', ')}.`,
    signIn === host ? `You sign in at ${host}.` : `You sign in at ${signIn}, for ${host}.`,
    'Dina never cancels, returns or pays through this link.',
    `Open until ${new Date(card.expires_at).toISOString()}.`,
  ];
}

export function linkCardDescription(card: LinkCard): string {
  return lines(card).join('\n');
}

/** The card on the phone; its yes, made in person, opens the sign-in page there. */
export function linkCardMirror(
  card: LinkCard,
): { title: string; detail: string; linkUrl: string; presenceRequired: true } | null {
  const [title, ...rest] = lines(card);
  const detail = rest.join('\n');
  if (title === undefined || !isMirrorableTitle(title) || !isMirrorableDetail(detail)) return null;
  return { title, detail, linkUrl: card.url, presenceRequired: true };
}

const httpsOrigin = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.origin === v;
  } catch {
    return false;
  }
};

const httpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || new TextEncoder().encode(v).byteLength > MAX_HANDOFF_URL_BYTES)
    return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
};

/** A stored card read back strictly; null when it is not one. */
export function readLinkCard(payload: string): LinkCard | null {
  const parsed = parseStrictJson(payload);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const v = parsed.value;
  if (v.type !== UCP_LINK_HANDOFF_TYPE || !httpsOrigin(v.merchant) || !httpsUrl(v.url)) return null;
  if (!Array.isArray(v.scopes) || !v.scopes.every((s) => typeof s === 'string' && s.length <= 200))
    return null;
  if (!Number.isSafeInteger(v.expires_at)) return null;
  return {
    type: UCP_LINK_HANDOFF_TYPE,
    merchant: v.merchant,
    url: v.url,
    scopes: v.scopes as string[],
    expires_at: v.expires_at as number,
  };
}

/**
 * The correlation every card for one merchant's link shares, so a new offer
 * replaces the last. Hashed: Brain lists tasks, and reads no merchant here.
 */
export function linkCardCorrelation(merchant: string): string {
  return `ucp-link:${bytesToHex(sha256(utf8(merchant))).slice(0, 32)}`;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
