import {
  validateBuyerSettings,
  validateSupplierSettings,
  type BuyerSettings,
  type SettingsFinding,
  type SupplierSettings,
} from './commerce_settings';

import type { DatabaseAdapter } from '../storage/db_adapter';

/**
 * Durable commerce settings (§18.2, §18.3).
 *
 * ONE ROW PER KIND. A node acts as one buyer and one supplier, so a table
 * keyed by `kind` is the honest shape; a settings table with an id column
 * would invite a second buyer profile that nothing knows how to choose
 * between.
 *
 * VALIDATED ON READ AS WELL AS WRITE. The row is editable by anything with the
 * database open, and these settings gate refusals — a tampered
 * `quoteAccess: "anyone"` on a paused listing is a supplier answering
 * customers they closed the door on. A row that no longer validates is
 * REFUSED rather than partially believed, and the caller fails closed.
 */

export type SettingsKind = 'buyer' | 'supplier';

export type ReadSettings<T> =
  | { ok: true; settings: T }
  /** Absent is not an error: a node that has not configured commerce has none. */
  | { ok: false; absent: true }
  | { ok: false; absent: false; findings: SettingsFinding[] };

export interface CommerceSettingsRepository {
  readBuyer(): ReadSettings<BuyerSettings>;
  readSupplier(): ReadSettings<SupplierSettings>;
  /** Refuses invalid settings; returns the findings so an owner can fix them. */
  writeBuyer(settings: BuyerSettings): { ok: true } | { ok: false; findings: SettingsFinding[] };
  writeSupplier(
    settings: SupplierSettings,
  ): { ok: true } | { ok: false; findings: SettingsFinding[] };
}

export class SQLiteCommerceSettingsRepository implements CommerceSettingsRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  private read<T>(
    kind: SettingsKind,
    validate: (value: T) => ReturnType<typeof validateBuyerSettings>,
  ): ReadSettings<T> {
    const rows = this.db.query(`SELECT settings_json FROM commerce_settings WHERE kind = ?`, [
      kind,
    ]) as unknown as { settings_json: string }[];
    const row = rows[0];
    if (row === undefined) return { ok: false, absent: true };
    let parsed: T;
    try {
      parsed = JSON.parse(row.settings_json) as T;
    } catch (error) {
      return {
        ok: false,
        absent: false,
        findings: [
          {
            refusal: 'empty_identity',
            field: kind,
            detail: `stored settings are unreadable: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    const verdict = validate(parsed);
    return verdict.ok
      ? { ok: true, settings: parsed }
      : { ok: false, absent: false, findings: verdict.findings };
  }

  private write(kind: SettingsKind, settings: unknown): void {
    this.db.run(
      `INSERT INTO commerce_settings (kind, settings_json) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET settings_json = excluded.settings_json`,
      [kind, JSON.stringify(settings)],
    );
  }

  readBuyer(): ReadSettings<BuyerSettings> {
    return this.read<BuyerSettings>('buyer', validateBuyerSettings);
  }

  readSupplier(): ReadSettings<SupplierSettings> {
    return this.read<SupplierSettings>('supplier', validateSupplierSettings as never);
  }

  writeBuyer(settings: BuyerSettings): { ok: true } | { ok: false; findings: SettingsFinding[] } {
    const verdict = validateBuyerSettings(settings);
    if (!verdict.ok) return verdict;
    this.write('buyer', settings);
    return { ok: true };
  }

  writeSupplier(
    settings: SupplierSettings,
  ): { ok: true } | { ok: false; findings: SettingsFinding[] } {
    const verdict = validateSupplierSettings(settings);
    if (!verdict.ok) return verdict;
    this.write('supplier', settings);
    return { ok: true };
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryCommerceSettingsRepository implements CommerceSettingsRepository {
  private buyer: BuyerSettings | null = null;
  private supplier: SupplierSettings | null = null;

  readBuyer(): ReadSettings<BuyerSettings> {
    if (this.buyer === null) return { ok: false, absent: true };
    const verdict = validateBuyerSettings(this.buyer);
    return verdict.ok
      ? { ok: true, settings: this.buyer }
      : { ok: false, absent: false, findings: verdict.findings };
  }

  readSupplier(): ReadSettings<SupplierSettings> {
    if (this.supplier === null) return { ok: false, absent: true };
    const verdict = validateSupplierSettings(this.supplier);
    return verdict.ok
      ? { ok: true, settings: this.supplier }
      : { ok: false, absent: false, findings: verdict.findings };
  }

  writeBuyer(settings: BuyerSettings): { ok: true } | { ok: false; findings: SettingsFinding[] } {
    const verdict = validateBuyerSettings(settings);
    if (!verdict.ok) return verdict;
    this.buyer = settings;
    return { ok: true };
  }

  writeSupplier(
    settings: SupplierSettings,
  ): { ok: true } | { ok: false; findings: SettingsFinding[] } {
    const verdict = validateSupplierSettings(settings);
    if (!verdict.ok) return verdict;
    this.supplier = settings;
    return { ok: true };
  }
}
