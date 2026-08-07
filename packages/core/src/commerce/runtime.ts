/**
 * Commerce composition root (§16.2 boundary, ARCH-0).
 *
 * WHY THIS EXISTS. `QuoteFamily.hold()` is worthless while `holdUse()` stays
 * callable, and `StatusChain.advance()` is worthless while `casAdvance()`
 * does. Until now that was true only by convention: the raw repositories
 * were exported from the package root AND installed into five mutable
 * globals, so any future caller could reach past every aggregate rule with
 * no compiler or test failure. A grep proved nobody did it today; it proved
 * nothing about the design.
 *
 * So construction happens HERE, once, and callers receive aggregate stores.
 * The raw repository classes stay importable from their own modules for the
 * composition root and for repository-level tests — the point is that
 * production code reaches them through nothing but this file.
 *
 * LAZY IDENTITY. `supplierDid` and `currentEpoch` are thunks because storage
 * initialises before identity and before the commerce epoch is established.
 * `CommerceEpochService.currentEpoch()` throws until publication succeeds,
 * which is the §16.2 fail-closed posture — a commerce operation attempted
 * before the epoch exists must fail, not silently sign at a guessed epoch.
 */

import { CommerceOrderStore } from './commerce_order';
import { SQLiteCommerceOrderRefRepository } from './order_refs';
import { QuoteFamilyStore } from './quote_family';
import { SQLiteCommerceQuoteLedgerRepository } from './quote_ledger';
import { SQLiteCommerceReceiptRepository } from './receipts';
import { StatusChainStore } from './status_chain';
import { SQLiteCommerceStatusHeadRepository } from './status_heads';
import { SQLiteCommerceEpochWatermarkRepository } from './watermarks';

import type { CommerceReceiptRepository } from './receipts';
import type { CommerceEpochWatermarkRepository } from './watermarks';
import type { DatabaseAdapter } from '../storage/db_adapter';

export interface CommerceRuntimeInputs {
  adapter: DatabaseAdapter;
  /** Acting Business DID. Resolved lazily: identity boots after storage. */
  supplierDid: () => string;
  /**
   * Live commerce epoch (§16.2). Expected to THROW until the epoch service
   * has published — commerce signing is fail-closed by design.
   */
  currentEpoch: () => string;
  now?: () => number;
}

/**
 * What production code is allowed to hold. Quote and order and status state
 * appear only as aggregate stores; receipts and watermarks are plain record
 * stores with no local state rules of their own, so they need no aggregate.
 */
export interface CommerceRuntime {
  families: QuoteFamilyStore;
  chains: StatusChainStore;
  orders: CommerceOrderStore;
  receipts: CommerceReceiptRepository;
  watermarks: CommerceEpochWatermarkRepository;
}

export function createCommerceRuntime(inputs: CommerceRuntimeInputs): CommerceRuntime {
  const now = inputs.now ?? (() => Date.now());
  const ledger = new SQLiteCommerceQuoteLedgerRepository(inputs.adapter);
  const heads = new SQLiteCommerceStatusHeadRepository(inputs.adapter);
  const refs = new SQLiteCommerceOrderRefRepository(inputs.adapter);
  return {
    families: new QuoteFamilyStore({
      ledger,
      currentEpoch: inputs.currentEpoch,
      supplierDid: inputs.supplierDid,
      now,
    }),
    chains: new StatusChainStore({ heads, currentEpoch: inputs.currentEpoch, now }),
    orders: new CommerceOrderStore({ refs, now }),
    receipts: new SQLiteCommerceReceiptRepository(inputs.adapter),
    watermarks: new SQLiteCommerceEpochWatermarkRepository(inputs.adapter),
  };
}

let runtime: CommerceRuntime | null = null;

/** Install at boot; pass null on shutdown/lock. */
export function installCommerceRuntime(value: CommerceRuntime | null): void {
  runtime = value;
}

/** Null until commerce storage is initialised. Callers must fail closed. */
export function getCommerceRuntime(): CommerceRuntime | null {
  return runtime;
}
