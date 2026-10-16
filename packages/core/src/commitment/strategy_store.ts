/**
 * The strategy slot's durable state (COMMITMENT_KERNEL §11): who fills the
 * slot for a deal kind, whether Brain's brief carries values, and the verdict
 * budgets — kept in the identity store so no restart, new negotiation or new
 * counterparty resets them.
 */

import { getIdentityDB } from '../storage/db_provider';

import {
  charge,
  DEFAULT_BUDGET_RULES,
  refill,
  type BudgetRules,
  type BudgetState,
} from './strategy';

import type { DatabaseAdapter } from '../storage/db_adapter';

export type StrategyKind = 'fixed' | 'brain';

export interface StrategySettings {
  strategy: StrategyKind;
  /** Values and costs in Brain's brief (§16 item 3: on by default). */
  valuesOn: boolean;
}

/** Until the owner turns Brain on, the pack's fixed style fills the slot. */
export const DEFAULT_STRATEGY: StrategySettings = { strategy: 'fixed', valuesOn: true };

export class StrategyStore {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly rules: BudgetRules = DEFAULT_BUDGET_RULES,
  ) {}

  settings(kind: string): StrategySettings {
    const row = this.db.query(
      `SELECT strategy, values_on FROM commitment_strategy WHERE kind = ?`,
      [kind],
    )[0];
    if (row === undefined) return DEFAULT_STRATEGY;
    return {
      strategy: row.strategy === 'brain' ? 'brain' : 'fixed',
      valuesOn: Number(row.values_on) === 1,
    };
  }

  setSettings(kind: string, settings: StrategySettings, nowMs: number): void {
    this.db.execute(
      `INSERT OR REPLACE INTO commitment_strategy (kind, strategy, values_on, updated_at) VALUES (?, ?, ?, ?)`,
      [kind, settings.strategy, settings.valuesOn ? 1 : 0, nowMs],
    );
  }

  private state(
    kind: string,
    negotiationId: string,
    nowMs: number,
    thresholdVersion: number,
  ): BudgetState {
    const owner = this.db.query(`SELECT * FROM commitment_owner_budget WHERE kind = ?`, [kind])[0];
    const drawn = this.db.query(
      `SELECT drawn FROM commitment_negotiation_budget WHERE kind = ? AND negotiation_id = ?`,
      [kind, negotiationId],
    )[0];
    const base: BudgetState = {
      negotiation: drawn === undefined ? 0 : Number(drawn.drawn),
      ownerLeft: owner === undefined ? this.rules.perOwnerMonthly : Number(owner.owner_left),
      ownerRefilledAtMs: owner === undefined ? nowMs : Number(owner.refilled_at),
      thresholdVersion: owner === undefined ? thresholdVersion : Number(owner.threshold_version),
    };
    return refill(base, this.rules, nowMs, thresholdVersion);
  }

  /** Is there any budget left, for the owner and this negotiation, without charging? */
  canSpend(args: {
    kind: string;
    negotiationId: string;
    nowMs: number;
    thresholdVersion: number;
  }): { ok: true } | { ok: false; spent: 'negotiation' | 'owner' } {
    const state = this.state(args.kind, args.negotiationId, args.nowMs, args.thresholdVersion);
    if (state.negotiation >= this.rules.perNegotiation) return { ok: false, spent: 'negotiation' };
    if (state.ownerLeft <= 0) return { ok: false, spent: 'owner' };
    return { ok: true };
  }

  /**
   * Charge `count` verdicts to the owner's budget for this kind and to this
   * negotiation's. False when either is spent: the fixed style takes over.
   */
  charge(args: {
    kind: string;
    negotiationId: string;
    count: number;
    nowMs: number;
    /** The model version: a changed threshold refills the owner's budget. */
    thresholdVersion: number;
  }): { ok: true } | { ok: false; spent: 'negotiation' | 'owner' } {
    const state = this.state(args.kind, args.negotiationId, args.nowMs, args.thresholdVersion);
    const charged = charge(state, this.rules, args.count);
    if (!charged.ok) return charged;
    const next = charged.state;
    this.db.execute(
      `INSERT OR REPLACE INTO commitment_owner_budget (kind, owner_left, refilled_at, threshold_version) VALUES (?, ?, ?, ?)`,
      [args.kind, next.ownerLeft, next.ownerRefilledAtMs, next.thresholdVersion],
    );
    this.db.execute(
      `INSERT OR REPLACE INTO commitment_negotiation_budget (kind, negotiation_id, drawn) VALUES (?, ?, ?)`,
      [args.kind, args.negotiationId, next.negotiation],
    );
    return { ok: true };
  }
}

let installed: StrategyStore | null = null;

/** Install a store (tests); null goes back to the identity database. */
export function installStrategyStore(store: StrategyStore | null): void {
  installed = store;
}

/** The node's strategy store, or null before persistence is up. */
export async function getStrategyStore(): Promise<StrategyStore | null> {
  if (installed !== null) return installed;
  const identity = await getIdentityDB();
  return identity === null ? null : new StrategyStore(identity);
}
