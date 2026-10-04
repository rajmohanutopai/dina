/**
 * The owner's card for an inbound A2A call under `review` (design §7.2 step
 * 9, §7.3): what the outside agent asked, through which listing, and exactly
 * the params it sent. Core writes the words once, when it writes the card;
 * the server console and the paired phone show them as they are.
 *
 * The params are a stranger's JSON. They are shown as JSON text with every
 * invisible, bidi and control character spelled out as `\uXXXX`, so what
 * the owner reads is what the runner will get, and the text passes the phone
 * mirror's checks.
 */

import { a2aDisplayText, isInvisibleCodePoint, isPlainObject, type JsonObject } from '@dina/a2a';

import { isMirrorableDetail, isMirrorableTitle } from '../approval/mirror_text';


import type { InboundActionClass } from './action_registry';

export const A2A_INBOUND_REVIEW_TYPE = 'a2a_inbound_review';

export interface InboundReviewDisplay {
  title: string;
  detail: string;
}

export interface InboundReviewCard {
  type: typeof A2A_INBOUND_REVIEW_TYPE;
  operation_id: string;
  client_id: string;
  client_name: string;
  skill: string;
  action_class: InboundActionClass;
  params: JsonObject;
  service_name: string;
  /** sha256 hex of the normalized call: what an approval of this card lets run. */
  post_hash: string;
  display: InboundReviewDisplay;
}

const ACTION_CLASSES: ReadonlySet<string> = new Set(['read', 'quote', 'write', 'booking', 'agentic']);

const hex4 = (unit: number): string => `\\u${unit.toString(16).padStart(4, '0')}`;

/**
 * JSON text with every character a reader cannot see, or that reorders
 * text, spelled out: the invisible set `@dina/a2a` keeps (controls, bidi
 * marks, format characters, tag characters, variation selectors, blank
 * fillers), and any lone surrogate. An astral one is spelled as its
 * surrogate pair, `\uD8xx\uDCxx`, as JSON writes it, so one list decides what
 * the owner is shown and nothing it misses can hide.
 */
export function visibleJson(value: JsonObject): string {
  const text = JSON.stringify(value, null, 2);
  let out = '';
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    const unit = text.slice(i, i + width);
    const lone = cp >= 0xd800 && cp <= 0xdfff;
    // `split('')` walks UTF-16 code units: an astral point is both halves of its pair.
    out += lone || isInvisibleCodePoint(cp) ? unit.split('').map((c) => hex4(c.charCodeAt(0))).join('') : unit;
    i += width;
  }
  return out;
}

function effectWords(actionClass: InboundActionClass): string {
  return actionClass === 'read' || actionClass === 'quote'
    ? 'It asks for information. If you allow it, Dina runs the request and sends the answer back.'
    : `It asks Dina to act for it (a ${actionClass} action). If you allow it, your runner acts once.`;
}

/**
 * The owner's words for one review card. `proof` says how the caller showed
 * who it is: the bearer token the owner issued, or (a client that bound a
 * DID, which then has no token) a signature by that DID's key.
 */
export function inboundReviewDisplay(args: {
  client_name: string;
  skill: string;
  action_class: InboundActionClass;
  params: JsonObject;
  service_name: string;
  proof: { kind: 'bearer' } | { kind: 'did'; did: string };
}): InboundReviewDisplay {
  const client = a2aDisplayText(args.client_name, 60) || 'An outside agent';
  const title = `${client} asks to use ${a2aDisplayText(args.skill, 80)}`;
  const detail = [
    `Through your listing “${a2aDisplayText(args.service_name, 80)}”.`,
    effectWords(args.action_class),
    args.proof.kind === 'did'
      ? `The agent proved only that it holds the key of ${a2aDisplayText(args.proof.did, 200)}, the DID it bound.`
      : 'The agent proved only that it holds the token you gave it.',
    'Exactly what it sent:',
    visibleJson(args.params),
  ].join('\n');
  return { title, detail };
}

/** A review card's payload, or null when it is not one or is malformed. */
export function parseInboundReviewCard(raw: string): InboundReviewCard | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.type !== A2A_INBOUND_REVIEW_TYPE) return null;
  const strings = ['operation_id', 'client_id', 'client_name', 'skill', 'service_name'] as const;
  if (strings.some((k) => typeof parsed[k] !== 'string')) return null;
  if (typeof parsed.action_class !== 'string' || !ACTION_CLASSES.has(parsed.action_class)) return null;
  if (!isPlainObject(parsed.params)) return null;
  if (typeof parsed.post_hash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.post_hash)) return null;
  const display = parsed.display;
  if (!isPlainObject(display) || typeof display.title !== 'string' || typeof display.detail !== 'string') return null;
  return parsed as unknown as InboundReviewCard;
}

/** The card as the phone mirror shows it, or null when it cannot pass the mirror's checks. */
export function inboundReviewMirror(card: InboundReviewCard): InboundReviewDisplay | null {
  const { title, detail } = card.display;
  return isMirrorableTitle(title) && isMirrorableDetail(detail) ? { title, detail } : null;
}
