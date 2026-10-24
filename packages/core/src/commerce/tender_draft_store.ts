/**
 * The tender-draft store (OPENAI_DOTS_INTEGRATION §6.4), apart from the
 * service so it is the one place a stored draft is parsed.
 *
 * Same discipline as the catalog and order draft stores: every stored field
 * is re-checked on the way out — each line's text and quantity, each
 * supplier's Dina ID and listing key, the region, the state. One miss reads
 * the whole draft as ABSENT, never as a draft half-believed: an absent draft
 * opens nothing and shows the agent nothing.
 */

import { validateQuantity, validateRegionRef, type RegionRef } from '@dina/commerce-protocol';
import { isValidServiceListingRkey } from '@dina/protocol';


import {
  MAX_DRAFT_LINES,
  MAX_REQUIREMENT_TEXT,
  type TenderDraft,
  type TenderDraftLine,
  type TenderDraftState,
  type TenderDraftSupplier,
} from './tender_drafts';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface TenderDraftRepository {
  put(draft: TenderDraft): void;
  get(draftId: string): TenderDraft | null;
  countPending(agentDid: string, nowMs: number): number;
  listPending(nowMs: number): TenderDraft[];
  /** CAS from `pending`; false when another writer moved it first. */
  move(draftId: string, to: Exclude<TenderDraftState, 'pending'>, tenderId: string): boolean;
}

const STATES: ReadonlySet<string> = new Set<TenderDraftState>(['pending', 'opened', 'dismissed']);

function parsed(text: unknown): unknown {
  try {
    return JSON.parse(String(text)) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function linesOf(raw: unknown): TenderDraftLine[] | null {
  const value = parsed(raw);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DRAFT_LINES) return null;
  const out: TenderDraftLine[] = [];
  for (const line of value) {
    if (!isRecord(line) || typeof line.line_id !== 'string' || !isRecord(line.requirement)) {
      return null;
    }
    const text = line.requirement.text;
    if (typeof text !== 'string' || text === '' || text.length > MAX_REQUIREMENT_TEXT) return null;
    if (validateQuantity(line.quantity, { require_positive: true }) !== null) return null;
    out.push(line as unknown as TenderDraftLine);
  }
  return out;
}

function suppliersOf(raw: unknown): TenderDraftSupplier[] | null {
  const value = parsed(raw);
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: TenderDraftSupplier[] = [];
  for (const s of value) {
    if (
      !isRecord(s) ||
      typeof s.supplier_did !== 'string' ||
      !s.supplier_did.startsWith('did:') ||
      typeof s.service_rkey !== 'string' ||
      !isValidServiceListingRkey(s.service_rkey)
    ) {
      return null;
    }
    const entry: TenderDraftSupplier = {
      supplier_did: s.supplier_did,
      service_rkey: s.service_rkey,
    };
    if (s.source === 'known' || s.source === 'network') entry.source = s.source;
    if (typeof s.selected === 'boolean') entry.selected = s.selected;
    if (typeof s.name === 'string' && s.name !== '') entry.name = s.name.slice(0, 120);
    if (
      isRecord(s.trust) &&
      (s.trust.score === null || typeof s.trust.score === 'number') &&
      typeof s.trust.reviews === 'number'
    ) {
      entry.trust = { score: s.trust.score as number | null, reviews: s.trust.reviews };
    }
    out.push(entry);
  }
  return out;
}

/** A stored row, re-checked field by field; null when any field fails. */
function draftFromRow(row: DBRow): TenderDraft | null {
  const lines = linesOf(row.lines_json);
  const suppliers = suppliersOf(row.suppliers_json);
  const state = String(row.state);
  if (lines === null || suppliers === null || !STATES.has(state)) return null;
  let region: RegionRef | null = null;
  if (row.region_json !== null && row.region_json !== undefined && row.region_json !== '') {
    const value = parsed(row.region_json);
    if (validateRegionRef(value) !== null) return null;
    region = value as RegionRef;
  }
  return {
    draftId: String(row.draft_id),
    agentDid: String(row.agent_did),
    lines,
    requiredBy: String(row.required_by),
    suppliers,
    region,
    currency: String(row.currency),
    state: state as TenderDraftState,
    tenderId: String(row.tender_id),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

export class SQLiteTenderDraftRepository implements TenderDraftRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(draft: TenderDraft): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_tender_drafts
         (draft_id, agent_did, lines_json, required_by, suppliers_json, region_json,
          currency, state, tender_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        draft.draftId,
        draft.agentDid,
        JSON.stringify(draft.lines),
        draft.requiredBy,
        JSON.stringify(draft.suppliers),
        draft.region === null ? '' : JSON.stringify(draft.region),
        draft.currency,
        draft.state,
        draft.tenderId,
        draft.createdAt,
        draft.expiresAt,
      ],
    );
  }

  get(draftId: string): TenderDraft | null {
    const rows = this.db.query(`SELECT * FROM commerce_tender_drafts WHERE draft_id = ?`, [
      draftId,
    ]);
    return rows[0] === undefined ? null : draftFromRow(rows[0]);
  }

  countPending(agentDid: string, nowMs: number): number {
    const rows = this.db.query(
      `SELECT COUNT(*) AS n FROM commerce_tender_drafts
        WHERE agent_did = ? AND state = 'pending' AND expires_at > ?`,
      [agentDid, nowMs],
    );
    return Number(rows[0]?.n ?? 0);
  }

  listPending(nowMs: number): TenderDraft[] {
    return this.db
      .query(
        `SELECT * FROM commerce_tender_drafts
          WHERE state = 'pending' AND expires_at > ? ORDER BY created_at`,
        [nowMs],
      )
      .map(draftFromRow)
      .filter((d): d is TenderDraft => d !== null);
  }

  move(draftId: string, to: Exclude<TenderDraftState, 'pending'>, tenderId: string): boolean {
    return (
      this.db.run(
        `UPDATE commerce_tender_drafts SET state = ?, tender_id = ?
          WHERE draft_id = ? AND state = 'pending'`,
        [to, tenderId, draftId],
      ) > 0
    );
  }
}
