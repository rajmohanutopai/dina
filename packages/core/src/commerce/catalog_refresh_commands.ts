/**
 * What ONE granted catalogue refresh remembered (JIFFY_MERCHANT_INTEGRATION
 * _PLAN §3.2 A2), keyed by the connector's `command_id`: the draft it minted,
 * the digest the pulled source had, and the precondition the caller named.
 * A replay answers with the same draft; the same id under a different
 * catalogue or precondition is a conflict (the B3 rule). Written only when
 * the refresh reached `prepared` — a failed pull records nothing, so the same
 * command may try again once the source is fixed.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export interface CatalogRefreshCommand {
  commandId: string;
  catalogId: string;
  /** The `source_digest` the caller required, or null when it named none. */
  expectedSourceDigest: string | null;
  pullDigest: string;
  draftId: string;
  createdAt: number;
}

export interface CatalogRefreshCommandRepository {
  get(commandId: string): CatalogRefreshCommand | null;
  put(command: CatalogRefreshCommand): void;
}

function commandFromRow(row: DBRow): CatalogRefreshCommand {
  return {
    commandId: String(row.command_id),
    catalogId: String(row.catalog_id),
    expectedSourceDigest:
      row.expected_source_digest === null || row.expected_source_digest === undefined
        ? null
        : String(row.expected_source_digest),
    pullDigest: String(row.pull_digest),
    draftId: String(row.draft_id),
    createdAt: Number(row.created_at),
  };
}

export class SQLiteCatalogRefreshCommandRepository implements CatalogRefreshCommandRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(commandId: string): CatalogRefreshCommand | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_catalog_refresh_commands WHERE command_id = ?`,
      [commandId],
    );
    return rows[0] === undefined ? null : commandFromRow(rows[0]);
  }

  put(command: CatalogRefreshCommand): void {
    // First writer wins: a command is recorded once, by the refresh that ran.
    this.db.run(
      `INSERT INTO commerce_catalog_refresh_commands
         (command_id, catalog_id, expected_source_digest, pull_digest, draft_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(command_id) DO NOTHING`,
      [
        command.commandId,
        command.catalogId,
        command.expectedSourceDigest,
        command.pullDigest,
        command.draftId,
        command.createdAt,
      ],
    );
  }
}

export class InMemoryCatalogRefreshCommandRepository implements CatalogRefreshCommandRepository {
  private readonly rows = new Map<string, CatalogRefreshCommand>();

  get(commandId: string): CatalogRefreshCommand | null {
    const row = this.rows.get(commandId);
    return row === undefined ? null : { ...row };
  }

  put(command: CatalogRefreshCommand): void {
    if (!this.rows.has(command.commandId)) this.rows.set(command.commandId, { ...command });
  }
}
