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

import { tier0TxRunner } from '../run/tx';

import { CommerceAdmissionEngine } from './admission';
import { CommerceOrderStore } from './commerce_order';
import { CommerceLifecycleEngine } from './lifecycle_engine';
import { SQLiteCommerceOrderRefRepository } from './order_refs';
import { QuoteFamilyStore } from './quote_family';
import { SQLiteCommerceQuoteLedgerRepository } from './quote_ledger';
import { SQLiteCommerceReceiptRepository } from './receipts';
import { StatusChainStore } from './status_chain';
import { SQLiteCommerceStatusHeadRepository } from './status_heads';
import { SQLiteCommerceEpochWatermarkRepository } from './watermarks';

import type { LifecycleEngineDeps } from './lifecycle_engine';
import type { CommerceReceiptRepository } from './receipts';
import type { CommerceEpochWatermarkRepository } from './watermarks';
import type { DatabaseAdapter } from '../storage/db_adapter';
import type { SignedQuote } from '@dina/commerce-protocol';

/**
 * §9.9 step 3: how long a `pre_effect` reservation may sit undecided before
 * the recovery sweeper rejects it with `decision_timeout` and refunds the
 * hold. It bounds how long a buyer waits and how long capacity stays held by
 * a supplier that never answered. Fifteen minutes is long enough for a runner
 * to be restarted and short enough that held capacity is not lost for a day.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 15 * 60 * 1000;

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
  /** §9.9 step 3 decision deadline; defaults to DEFAULT_DECISION_TIMEOUT_MS. */
  decisionTimeoutMs?: number;
  /** §9.8 supplier policy: admit an order against a superseded revision. */
  honorSupersededRevisions?: boolean;
  /** Re-poll hints returned to a buyer, seconds. */
  processingRetryAfterSeconds?: number;
  unresolvedRetryAfterSeconds?: number;
  /**
   * §12.7/§16.2 held-evidence authenticity. Absent means "cannot verify", and
   * re-adoption is refused — the app supplies the Ed25519 verifier.
   */
  verifyHeldEvidence?: LifecycleEngineDeps['verifyHeldEvidence'];
  /**
   * §16.2 post-restore re-offer, owned by the supplier side. Absent means no
   * re-offer exists and admission refuses rather than inventing terms.
   */
  resignVoidedQuote?: (voidedQuoteId: string, buyerDid: string) => SignedQuote | null;
}

/**
 * What production code is allowed to hold. Quote and order and status state
 * appear only as aggregate stores; receipts and watermarks are plain record
 * stores with no local state rules of their own, so they need no aggregate.
 *
 * The two ENGINES are here for the same reason the stores are. They were
 * previously constructed only by tests, so every production path that would
 * have admitted an order or signed a status had nothing to call: the
 * subsystem was wired up to its own doorstep and no further.
 */
export interface CommerceRuntime {
  families: QuoteFamilyStore;
  chains: StatusChainStore;
  orders: CommerceOrderStore;
  receipts: CommerceReceiptRepository;
  watermarks: CommerceEpochWatermarkRepository;
  admission: CommerceAdmissionEngine;
  lifecycle: CommerceLifecycleEngine;
  /** Why commerce cannot act right now, if it cannot. See below. */
  availability: () => CommerceAvailability;
  /**
   * §16.4 — how many commercial obligations are still open. A cross-store
   * question (undecided orders live in one store, unfinished chains in
   * another), so it belongs to the root rather than to either aggregate.
   */
  inFlightCount: () => number;
}

/**
 * States a chain never leaves. `delivered` is deliberately absent: it is
 * terminal only once its dispute window elapses, and a chain sitting inside
 * that window is still an open obligation — a buyer can still dispute it.
 * Counting it as finished would let an uninstall strand exactly the orders a
 * dispute is most likely to concern.
 */
const TERMINAL_CHAIN_STATES = ['rejected', 'cancelled', 'disputed'] as const;

/**
 * Whether this node can act as a commerce supplier at this moment.
 *
 * Commerce is fail-closed twice over: identity resolves after storage, and
 * §16.2 forbids signing until the epoch record is published. Both refusals
 * arrive as THROWN errors from the thunks, which is right for a signing path
 * — an operation that cannot establish who it is must not proceed — but wrong
 * for a caller that only wants to know whether to offer commerce at all. That
 * caller would have to catch an exception and read its message.
 *
 * So the same two conditions are also askable, as a typed answer.
 */
export type CommerceAvailability =
  | { available: true }
  | {
      available: false;
      /**
       * `not_installed` — no commerce storage on this node.
       * `no_identity`   — Business DID not established yet.
       * `no_epoch`      — §16.2: no published epoch, so nothing may be signed.
       */
      reason: 'not_installed' | 'no_identity' | 'no_epoch';
      detail: string;
    };

/** Message from a thrown thunk, without assuming it threw an Error. */
function thrownDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCommerceRuntime(inputs: CommerceRuntimeInputs): CommerceRuntime {
  const now = inputs.now ?? (() => Date.now());
  const ledger = new SQLiteCommerceQuoteLedgerRepository(inputs.adapter);
  const heads = new SQLiteCommerceStatusHeadRepository(inputs.adapter);
  const refs = new SQLiteCommerceOrderRefRepository(inputs.adapter);
  // The ONE Tier-0 runner for this db, shared with the run plane and the
  // owner-command receipts. A commerce write nested inside an owner command
  // must join that transaction, not open a second `BEGIN` (op-sqlite rejects
  // one, and the whole command would roll back).
  const tx = tier0TxRunner(inputs.adapter);

  const families = new QuoteFamilyStore({
    ledger,
    currentEpoch: inputs.currentEpoch,
    supplierDid: inputs.supplierDid,
    now,
  });
  const chains = new StatusChainStore({ heads, currentEpoch: inputs.currentEpoch, now });
  const orders = new CommerceOrderStore({ refs, now });
  const receipts = new SQLiteCommerceReceiptRepository(inputs.adapter);

  const lifecycle = new CommerceLifecycleEngine({
    tx,
    orders,
    chains,
    receipts,
    families,
    supplierDid: inputs.supplierDid,
    now,
    currentEpoch: inputs.currentEpoch,
    processingRetryAfterSeconds: inputs.processingRetryAfterSeconds,
    unresolvedRetryAfterSeconds: inputs.unresolvedRetryAfterSeconds,
    verifyHeldEvidence: inputs.verifyHeldEvidence,
  });

  const admission = new CommerceAdmissionEngine({
    tx,
    orders,
    families,
    receipts,
    supplierDid: inputs.supplierDid,
    now,
    decisionTimeoutMs: inputs.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    honorSupersededRevisions: inputs.honorSupersededRevisions,
    processingRetryAfterSeconds: inputs.processingRetryAfterSeconds,
    resignVoidedQuote: inputs.resignVoidedQuote,
    // §12.8 — acceptance and its status genesis commit together. This closure
    // is the ONLY thing that makes them one transaction, and it can only be
    // tied here: admission must not learn about status chains, and the
    // lifecycle engine must not learn about admission. A production wiring
    // that omitted it would reopen the race where a cancellation's answer
    // depended on which of two transactions had landed.
    createAcceptedGenesisInTx: (buyerDid, purchaseOrderId) =>
      lifecycle.createAcceptedGenesisInTx(buyerDid, purchaseOrderId),
  });

  return {
    families,
    chains,
    orders,
    receipts,
    watermarks: new SQLiteCommerceEpochWatermarkRepository(inputs.adapter),
    admission,
    lifecycle,
    inFlightCount: () => {
      // Undecided orders: the supplier owes an answer it has not given.
      // Unfinished chains: the supplier owes an outcome it has not reached.
      return (
        orders.countReserved() + heads.countNonTerminal(TERMINAL_CHAIN_STATES)
      );
    },
    availability: () => {
      try {
        inputs.supplierDid();
      } catch (err) {
        return { available: false, reason: 'no_identity', detail: thrownDetail(err) };
      }
      try {
        inputs.currentEpoch();
      } catch (err) {
        return { available: false, reason: 'no_epoch', detail: thrownDetail(err) };
      }
      return { available: true };
    },
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

/**
 * Can this node act as a commerce supplier right now? A caller that wants to
 * offer, or decline to offer, commerce asks this instead of provoking the
 * fail-closed throw and reading its message.
 */
export function commerceAvailability(): CommerceAvailability {
  const current = runtime;
  if (current === null) {
    return {
      available: false,
      reason: 'not_installed',
      detail: 'commerce storage is not initialised on this node',
    };
  }
  return current.availability();
}
