/**
 * Agent intake for the daily plan (docs/DAILY_PLAN.md §6): one batch of
 * tasks from a paired agent, checked, folded into the store, and held until
 * the owner allows that agent to add tasks to that persona.
 */

import type { AgentItem, PlanStore } from './store';

export const PLAN_MAX_BATCH_ITEMS = 200;
export const PLAN_MAX_TITLE_CHARS = 200;
export const PLAN_MAX_SUMMARY_CHARS = 500;
export const PLAN_MAX_FIELD_CHARS = 200;
export const PLAN_MAX_LINK_CHARS = 2000;
export const PLAN_MAX_BATCH_ID_CHARS = 128;
/** How long a batch id is kept to refuse a second copy (§4). */
export const PLAN_BATCH_ID_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

const PERSONA_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export class PlanIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanIntakeError';
  }
}

export interface IntakeResult {
  accepted: number;
  held: number;
  duplicate_batch: boolean;
}

function str(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new PlanIntakeError(`${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw new PlanIntakeError(`${field} must be a string`);
  const t = v.trim();
  if (required && t === '') throw new PlanIntakeError(`${field} is required`);
  if (t.length > max) throw new PlanIntakeError(`${field} is longer than ${max} characters`);
  return t;
}

function time(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new PlanIntakeError(`${field} is not a time`);
  return ms;
}

function link(v: unknown): string {
  const s = str(v, 'link', PLAN_MAX_LINK_CHARS);
  if (s === '') return '';
  // Only web links: the Today screen opens them on a tap.
  if (!/^https:\/\//i.test(s)) throw new PlanIntakeError('link must start with https://');
  return s;
}

function item(raw: unknown, now: number, index: number): AgentItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanIntakeError(`items[${index}] must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const state = o.state === undefined ? 'open' : o.state;
  if (state !== 'open' && state !== 'closed') {
    throw new PlanIntakeError(`items[${index}].state must be open or closed`);
  }
  const effort = o.effort_min;
  let effortMin: number | null = null;
  if (effort !== undefined && effort !== null) {
    if (typeof effort !== 'number' || !Number.isInteger(effort) || effort < 0 || effort > 24 * 60) {
      throw new PlanIntakeError(`items[${index}].effort_min must be whole minutes, at most a day`);
    }
    effortMin = effort;
  }
  return {
    source: str(o.source, 'source', 64),
    sourceRef: str(o.source_ref, 'source_ref', PLAN_MAX_FIELD_CHARS),
    title: str(o.title, 'title', PLAN_MAX_TITLE_CHARS, true),
    summary: str(o.summary, 'summary', PLAN_MAX_SUMMARY_CHARS),
    link: link(o.link),
    dueAt: time(o.due_at, 'due_at'),
    effortMin,
    project: str(o.project, 'project', PLAN_MAX_FIELD_CHARS),
    closed: state === 'closed',
    // An item without its own time counts as seen now; one from the future
    // is capped at now, so it cannot shut out later updates.
    observedAt: Math.min(time(o.observed_at, 'observed_at') ?? now, now),
  };
}

export interface ParsedBatch {
  batchId: string;
  persona: string;
  items: AgentItem[];
}

export function parseBatch(body: unknown, now: number): ParsedBatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PlanIntakeError('body must be an object');
  }
  const o = body as Record<string, unknown>;
  const batchId = str(o.batch_id, 'batch_id', PLAN_MAX_BATCH_ID_CHARS, true);
  const persona = str(o.persona, 'persona', 64) || 'general';
  if (!PERSONA_RE.test(persona)) throw new PlanIntakeError('persona is not a persona name');
  if (!Array.isArray(o.items)) throw new PlanIntakeError('items must be a list');
  if (o.items.length > PLAN_MAX_BATCH_ITEMS) {
    throw new PlanIntakeError(`at most ${PLAN_MAX_BATCH_ITEMS} items per batch`);
  }
  return { batchId, persona, items: o.items.map((raw, i) => item(raw, now, i)) };
}

/**
 * Take one batch from `agentDid`. A blocked feed's batch is dropped and the
 * reply looks like a batch that added nothing new, so an agent cannot tell
 * blocked from allowed by probing.
 */
export function receiveBatch(
  store: PlanStore,
  agentDid: string,
  agentName: string,
  batch: ParsedBatch,
  now: number,
): IntakeResult {
  store.pruneBatches(now - PLAN_BATCH_ID_KEEP_MS);
  if (!store.claimBatch(agentDid, batch.batchId, now)) {
    return { accepted: 0, held: 0, duplicate_batch: true };
  }
  const feed =
    store.getFeed(agentDid, batch.persona) ??
    (batch.items.length > 0
      ? store.notePendingFeed(agentDid, batch.persona, agentName, now)
      : null);
  if (feed === null) return { accepted: 0, held: 0, duplicate_batch: false };
  if (feed.state === 'blocked') return { accepted: 0, held: 0, duplicate_batch: false };
  const status = feed.state === 'allowed' ? 'open' : 'held';
  let changed = 0;
  for (const it of batch.items) {
    if (store.upsertAgentItem(agentDid, batch.persona, it, status, now) !== 'stale') changed += 1;
  }
  return status === 'open'
    ? { accepted: changed, held: 0, duplicate_batch: false }
    : { accepted: 0, held: changed, duplicate_batch: false };
}

/** The owner's answer to a feed waiting on them. */
export function decideFeed(
  store: PlanStore,
  agentDid: string,
  persona: string,
  allow: boolean,
  now: number,
): { released: number; removed: number } | null {
  if (!store.setFeedState(agentDid, persona, allow ? 'allowed' : 'blocked', now)) return null;
  if (allow) return { released: store.releaseHeld(agentDid, persona, now), removed: 0 };
  return { released: 0, removed: store.deleteHeld(agentDid, persona) };
}
