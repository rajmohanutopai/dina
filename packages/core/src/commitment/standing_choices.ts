/**
 * Standing choices Brain sets for later deals (COMMITMENT_KERNEL §15 step 11).
 *
 * Some choices cannot wait for Brain inside a deal: a quote is answered at
 * once. Brain sets them ahead of time instead, and Core uses them until Brain
 * or the owner changes them. Today one: the share of a cheaper day's saving a
 * goods seller passes on, in hundredths of a percent of the saving. A choice
 * Brain set counts only while the owner keeps Brain for that kind.
 */

import { getIdentityDB } from '../storage/db_provider';

import type { DatabaseAdapter } from '../storage/db_adapter';

export const SAVING_SHARE_BPS = 'saving_share_bps';

export interface StandingChoice {
  value: string;
  setBy: 'brain' | 'owner';
  setAt: number;
}

export class StandingChoiceStore {
  constructor(private readonly db: DatabaseAdapter) {}

  get(kind: string, name: string): StandingChoice | null {
    const row = this.db.query(
      `SELECT value, set_by, set_at FROM commitment_standing_choices WHERE kind = ? AND name = ?`,
      [kind, name],
    )[0];
    if (row === undefined) return null;
    return {
      value: String(row.value),
      setBy: row.set_by === 'owner' ? 'owner' : 'brain',
      setAt: Number(row.set_at),
    };
  }

  set(kind: string, name: string, value: string, setBy: 'brain' | 'owner', nowMs: number): void {
    this.db.execute(
      `INSERT OR REPLACE INTO commitment_standing_choices (kind, name, value, set_by, set_at)
       VALUES (?, ?, ?, ?, ?)`,
      [kind, name, value, setBy, nowMs],
    );
  }
}

let installed: StandingChoiceStore | null = null;

export function installStandingChoiceStore(store: StandingChoiceStore | null): void {
  installed = store;
}

export async function getStandingChoiceStore(): Promise<StandingChoiceStore | null> {
  if (installed !== null) return installed;
  const identity = await getIdentityDB();
  return identity === null ? null : new StandingChoiceStore(identity);
}

/** The standing share as a number of hundredths, when it is a valid one. */
export function shareBpsOf(choice: StandingChoice | null): number | undefined {
  if (choice === null || !/^(0|[1-9][0-9]{0,4})$/.test(choice.value)) return undefined;
  const bps = Number(choice.value);
  return bps <= 10_000 ? bps : undefined;
}
