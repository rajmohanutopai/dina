/**
 * NEGOTIATION_PLAN §4.7 — the held order an owner's yes above a clerk's cap
 * was spent on.
 *
 * The owner approves one order for one clerk, not a quote: a quote may be
 * ordered from more than once, and the card names the clerk who asked. When a
 * clerk's hold (or send) passes on an approved escalation card, Core writes
 * one row here naming the order, the clerk and the card, and only then marks
 * the card spent. That clerk may then send the order, and send it again after
 * a failure, without a new card; another clerk, or another order, asks again.
 *
 * THIS ROW IS THE RECORD OF THE SPEND. A card named here is spent whatever
 * state the workflow still shows for it: a crash between the row and the
 * card's own transition leaves a card that looks approved (or stuck running),
 * and the next attempt finishes the spend instead of reusing it.
 */

import type { DatabaseAdapter } from '../storage/db_adapter';

export interface StaffClearance {
  approvalId: string;
  deviceDid: string;
  escalationId: string;
  createdAt: number;
}

export interface StaffClearanceRepository {
  /** False when the card is already spent on something else, or the row exists. */
  put(clearance: StaffClearance): boolean;
  get(approvalId: string, deviceDid: string): StaffClearance | null;
  /** The clearance a card was spent on, if any. */
  byEscalation(escalationId: string): StaffClearance | null;
}

function fromRow(row: Record<string, unknown>): StaffClearance {
  return {
    approvalId: String(row.approval_id),
    deviceDid: String(row.device_did),
    escalationId: String(row.escalation_id),
    createdAt: Number(row.created_at),
  };
}

export class SQLiteStaffClearanceRepository implements StaffClearanceRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(clearance: StaffClearance): boolean {
    return (
      this.db.run(
        `INSERT OR IGNORE INTO commerce_staff_clearances
           (approval_id, device_did, escalation_id, created_at)
         VALUES (?, ?, ?, ?)`,
        [clearance.approvalId, clearance.deviceDid, clearance.escalationId, clearance.createdAt],
      ) > 0
    );
  }

  get(approvalId: string, deviceDid: string): StaffClearance | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_staff_clearances WHERE approval_id = ? AND device_did = ?`,
      [approvalId, deviceDid],
    );
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  byEscalation(escalationId: string): StaffClearance | null {
    const rows = this.db.query(`SELECT * FROM commerce_staff_clearances WHERE escalation_id = ?`, [
      escalationId,
    ]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }
}
