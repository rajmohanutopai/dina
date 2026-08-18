/**
 * The invite exchange store (TRADE_FIRST_STRATEGY §8) — one row per
 * exchange per role, keyed by the single-use nonce. The retained
 * message JSON is what idempotent re-send replays; the state machine
 * lives in `invite_service.ts` and this module holds only rows.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';
import type { InviteDirection } from '@dina/commerce-protocol';


// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type InviteRole = 'inviter' | 'redeemer';
export type InviteState = 'offered' | 'held' | 'redeemed' | 'active' | 'revoked';

export interface InviteRow {
  nonce: string;
  role: InviteRole;
  state: InviteState;
  direction: InviteDirection;
  counterpartyDid: string;
  offerJson: string;
  redemptionJson: string;
  confirmationJson: string;
  ackJson: string;
  activationProvenAt: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface InviteRepository {
  put(row: InviteRow): void;
  get(nonce: string): InviteRow | null;
  list(): InviteRow[];
  listByState(state: InviteState): InviteRow[];
}

export class SQLiteInviteRepository implements InviteRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(row: InviteRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO commerce_invites
         (nonce, role, state, direction, counterparty_did, offer_json,
          redemption_json, confirmation_json, ack_json, activation_proven_at,
          expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.nonce,
        row.role,
        row.state,
        row.direction,
        row.counterpartyDid,
        row.offerJson,
        row.redemptionJson,
        row.confirmationJson,
        row.ackJson,
        row.activationProvenAt,
        row.expiresAt,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  get(nonce: string): InviteRow | null {
    const rows = this.db.query(`SELECT * FROM commerce_invites WHERE nonce = ?`, [nonce]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  list(): InviteRow[] {
    return this.db.query(`SELECT * FROM commerce_invites ORDER BY created_at DESC`).map(fromRow);
  }

  listByState(state: InviteState): InviteRow[] {
    return this.db
      .query(`SELECT * FROM commerce_invites WHERE state = ? ORDER BY created_at DESC`, [state])
      .map(fromRow);
  }
}

function fromRow(row: Record<string, unknown>): InviteRow {
  return {
    nonce: String(row.nonce),
    role: String(row.role) as InviteRole,
    state: String(row.state) as InviteState,
    direction: String(row.direction) as InviteDirection,
    counterpartyDid: String(row.counterparty_did ?? ''),
    offerJson: String(row.offer_json),
    redemptionJson: String(row.redemption_json ?? ''),
    confirmationJson: String(row.confirmation_json ?? ''),
    ackJson: String(row.ack_json ?? ''),
    activationProvenAt: row.activation_proven_at === null ? null : Number(row.activation_proven_at),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Test double. A production caller would be the bug. */
export class InMemoryInviteRepository implements InviteRepository {
  private readonly rows = new Map<string, InviteRow>();

  put(row: InviteRow): void {
    this.rows.set(row.nonce, { ...row });
  }

  get(nonce: string): InviteRow | null {
    const row = this.rows.get(nonce);
    return row === undefined ? null : { ...row };
  }

  list(): InviteRow[] {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r }));
  }

  listByState(state: InviteState): InviteRow[] {
    return this.list().filter((r) => r.state === state);
  }
}

