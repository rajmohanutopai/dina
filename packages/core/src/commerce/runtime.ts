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
import { CommerceAdmissionService } from './admission_service';
import {
  SQLiteAttributionBoundaryRepository,
  type AttributionBoundaryRepository,
} from './attribution_boundary';
import { SQLiteBuyerOrderRepository, type BuyerOrderRepository } from './buyer_orders';
import { SQLiteBuyerQuoteRepository, type BuyerQuoteRepository } from './buyer_quotes';
import {
  SQLiteBuyerQuoteRequestRepository,
  type BuyerQuoteRequestRepository,
} from './buyer_requests';
import { SQLiteBuyerStatusRepository, type BuyerStatusRepository } from './buyer_status';
import {
  SQLiteCatalogDraftRepository,
  type CatalogDraftRepository,
} from './catalog_draft_store';
import {
  SQLiteCatalogPointerRepository,
  type CatalogPointerRepository,
} from './catalog_pointer_store';
import { CommerceOrderStore } from './commerce_order';
import { CredentialBroker, type BrokeredExecutor } from './credential_broker';
import { SQLiteCredentialStore, type RotatableCredentialStore } from './credential_store';
import {
  SQLiteIdempotencyEvidenceRepository,
  type IdempotencyEvidenceRepository,
} from './idempotency_store';
import {
  SQLiteCommerceImageArtifactRepository,
  type CommerceImageArtifactRepository,
} from './image_artifacts';
import {
  SQLiteImageEgressAuthorizationRepository,
  type ImageEgressAuthorizationRepository,
} from './image_egress';
import { SQLiteInviteRepository, type InviteRepository } from './invite_store';
import { CommerceLifecycleEngine } from './lifecycle_engine';
import {
  SQLiteOrderApprovalRepository,
  type OrderApprovalRepository,
} from './order_approvals';
import {
  SQLiteOrderDraftRepository,
  type OrderDraftRepository,
} from './order_draft_store';
import { SQLiteCommerceOrderRefRepository } from './order_refs';
import { installStaffPresenceVerifier } from './owner_presence';
import {
  SQLitePendingSupplierDecisionRepository,
  type PendingSupplierDecisionRepository,
} from './pending_decisions';
import { installQuoteAttemptLedger, QuoteAttemptLedger } from './probing_ledger';
import { DEFAULT_PROBING_POLICY } from './probing_resistance';
import { QuoteFamilyStore } from './quote_family';
import { SQLiteCommerceQuoteLedgerRepository } from './quote_ledger';
import { SQLiteCommerceReceiptRepository } from './receipts';
import { CommerceReconciliationService } from './reconciliation_service';
import {
  SQLiteRevshareDocumentRepository,
  type RevshareDocumentRepository,
} from './revshare_ledger';
import {
  SQLiteCommerceSettingsRepository,
  type CommerceSettingsRepository,
} from './settings_store';
import { SQLiteSkuLedgerRepository, type SkuLedgerRepository } from './sku_ledger';
import { SQLiteStaffGrantRepository, type StaffGrantRepository } from './staff_grants';
import { SQLiteStaffPinRepository, verifyStaffPinGated, type StaffPinRepository } from './staff_pins';
import { StatusChainStore } from './status_chain';
import { SQLiteCommerceStatusHeadRepository } from './status_heads';
import { SQLiteTenderRepository } from './tender';
import { SQLiteTradeDocumentRepository } from './trade_ledger';
import { CommerceTransaction } from './transaction';
import { SQLiteCommerceEpochWatermarkRepository } from './watermarks';

import type { LifecycleEngineDeps } from './lifecycle_engine';
import type { CommerceReceiptRepository } from './receipts';
import type { TenderRepository } from './tender';
import type { TradeDocumentRepository } from './trade_ledger';
import type { CommerceEpochWatermarkRepository } from './watermarks';
import type { DatabaseAdapter } from '../storage/db_adapter';

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
  /**
   * §8.3 — what the credential broker may actually DO, keyed
   * `${resource}:${operation}`.
   *
   * Supplied by the composition root because performing an operation means
   * making an outbound request, and Core owns no transport. An empty map is
   * the honest default for a node with no connectors: every brokered call then
   * refuses with `no_executor` rather than doing something unauthenticated.
   */
  credentialExecutors?: () => Record<string, BrokeredExecutor>;
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
  /**
   * §10.2 — what this node has PUBLISHED. Its own writes, cached so the
   * ordinary path (publish, look, publish again) needs no repo round trip and
   * no caller carrying the CAS.
   */
  catalogPointers: CatalogPointerRepository;
  /**
   * The photo-catalog lane's drafts (PCL-4). One row per publication attempt,
   * durable because the lane suspends on a person twice and a rebuild after a
   * restart would publish bytes the owner never approved.
   */
  catalogDrafts: CatalogDraftRepository;
  /**
   * §4.2 (photo lanes) — the issuer-scoped SKU reservation ledger. The
   * repair path claims into it in the same transaction as the draft
   * mutation; `runInTransaction` below is that transaction's door.
   */
  skuLedger: SkuLedgerRepository;
  /** §6 — the photographs, stored stripped and erased with their draft. */
  imageArtifacts: CommerceImageArtifactRepository;
  /** §3 — the single-use egress authorizations the Hop-1 gate consumes. */
  egressAuthorizations: ImageEgressAuthorizationRepository;
  /** §5.1 — the BUYER lane's aggregate: one photographed page, whole. */
  orderDrafts: OrderDraftRepository;
  /**
   * TRADE_FIRST_STRATEGY §4.2/§4.3 — the khata ledger: delivery notes,
   * receipts, payment notes/acks and quote declines, both directions,
   * retained with their envelope evidence.
   */
  tradeDocuments: TradeDocumentRepository;
  /** §3.2 — the private-tender aggregate: N requests, one comparison. */
  tenders: TenderRepository;
  /** TRADE_FIRST_STRATEGY §6.2 — value-capped, install-scoped staff grants. */
  staffGrants: StaffGrantRepository;
  /** §6.4 — the per-device staff PIN records the grant ceremony mints. */
  staffPins: StaffPinRepository;
  /**
   * §6.4 — the durable vouch-attribution boundary: crossed by the first
   * staff grant, carrying the immutable grandfather index of every v1
   * receipt/approval digest then in the store.
   */
  attributionBoundary: AttributionBoundaryRepository;
  /** §8 — the invite exchanges, keyed by nonce. */
  invites: InviteRepository;
  /** §5 — the revenue-share chain's document ledger. */
  revshareDocuments: RevshareDocumentRepository;
  /** One transaction across ledger claims and draft writes (§4.2). */
  runInTransaction: (body: () => void) => void;
  /** The runtime's clock — injected at composition, shared by every store. */
  now: () => number;
  watermarks: CommerceEpochWatermarkRepository;
  /**
   * §12.7 — the BUYER's durable view of orders it has sent. Separate from
   * `orders`, which is the supplier's side: the two describe one trade from
   * opposite ends and are allowed to disagree.
   */
  buyerOrders: BuyerOrderRepository;
  /**
   * §9.11 — the buyer's VERIFIED copy of each supplier's signed status chain.
   *
   * Separate from `chains`, which is the supplier's signing head: one is what
   * this node committed to, the other is what a counterparty has proved to it,
   * and a single store would have to decide which of the two a fork belongs to.
   */
  buyerStatus: BuyerStatusRepository;
  /**
   * §9.8/§25.3 — the buyer's VERIFIED copy of each supplier's quote chain.
   *
   * Separate from `families`, which is the supplier ledger and carries the
   * use holds for capacity this node SELLS. These are offers it received.
   */
  buyerQuotes: BuyerQuoteRepository;
  /**
   * §9.8 — the quote requests THIS node sent, retained so an arriving quote
   * can be checked against the question it claims to answer. Without it the
   * buyer-side `request_digest` and projection bindings have no yardstick.
   */
  buyerQuoteRequests: BuyerQuoteRequestRepository;
  /**
   * §15.2 — the approval material Core minted when it showed a card, held
   * until the owner sends or the card expires. The binding check is only
   * meaningful against material the submitting caller does not supply.
   */
  orderApprovals: OrderApprovalRepository;
  /**
   * THIS NODE's DID.
   *
   * One identity, two roles. The inputs call it `supplierDid` because the
   * supplier engines needed it first; the buyer side needs the same value to
   * check §9.8 audience binding on an arriving quote, and a second thunk
   * returning the same fact is a second thing that can drift. Named for what
   * it IS rather than for whichever role is asking.
   */
  nodeDid: () => string;
  /**
   * §16.2 — the live commerce epoch this node signs at.
   *
   * THROWS until an epoch record has been published, and that is the contract
   * rather than a defect: a node that stamped a guessed epoch would produce
   * records no restore fence could place. Callers that sign must handle the
   * throw as a refusal.
   *
   * Exposed because quote issuance stamps it and the runtime already held the
   * thunk — reaching through `admission` to the engine's ledger for it would
   * be a second path to one fact.
   */
  currentEpoch: () => string;
  /** §18.2/§18.3 owner policy, validated on every read. */
  settings: CommerceSettingsRepository;
  /**
   * §8.3 — connector material, and the only door out of it.
   *
   * `credentials` is the WRITE side (the owner's rotation screen); `broker` is
   * the read side, and it does not have one: it performs operations. Both are
   * exposed because they have different callers, and neither hands a secret to
   * anybody.
   */
  credentials: RotatableCredentialStore;
  broker: CredentialBroker;
  /**
   * §15.5 — what each connector has PROVEN about the external system's
   * deduplication. Read before any ambiguous effect may be retried; absent
   * means automatic resubmission stays off, which is §15.5's default.
   */
  idempotencyEvidence: IdempotencyEvidenceRepository;
  /**
   * §9.9 admission, through the service that owns its transaction boundary.
   *
   * The ENGINE is not exposed: its methods are all `…InTx` and calling one
   * outside a transaction would write without atomicity. Handing out the
   * service is what makes that impossible rather than merely discouraged.
   */
  admission: CommerceAdmissionService;
  /**
   * §9.11/§12.7 lifecycle, through the service that owns its transaction
   * boundaries. The engine is reachable as `lifecycle.engine` for the ONE
   * caller that needs it: §12.8's genesis seam, which must run inside
   * admission's transaction rather than open its own.
   */
  lifecycle: CommerceReconciliationService;
  /**
   * §15.2b — decisions the pack has made and a human has not yet agreed to.
   *
   * A STORE, not the workflow engine: losing this row strands a reserved order
   * with a buyer waiting, which is a different cost from losing a prompt, and
   * handing commerce a task handle would put the execution plane inside the
   * domain this module exists to keep out of it.
   */
  pendingDecisions: PendingSupplierDecisionRepository;
  /** Why commerce cannot act right now, if it cannot. See below. */
  availability: () => CommerceAvailability;
  /**
   * §16.4 — how many commercial obligations are still open.
   *
   * A cross-store question (undecided orders live in one store, unfinished
   * chains in another), so it belongs to the root rather than to either
   * aggregate. Pass an install id to ask only about the orders THAT install
   * served: without it the count is node-wide, which is safe but refuses an
   * uninstall on a multi-plugin node because a DIFFERENT pack has work open.
   */
  inFlightCount: (installId?: string) => number;
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

  const lifecycleEngine = new CommerceLifecycleEngine({
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

  // ONE coordinator for this database, shared by every service below. Two
  // would each believe no transaction was open while the other held one, which
  // is the nesting bug wearing a second object.
  const transaction = new CommerceTransaction(tx);

  const admissionEngine = new CommerceAdmissionEngine({
    orders,
    families,
    receipts,
    supplierDid: inputs.supplierDid,
    now,
    decisionTimeoutMs: inputs.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    honorSupersededRevisions: inputs.honorSupersededRevisions,
    processingRetryAfterSeconds: inputs.processingRetryAfterSeconds,
    // §12.8 — acceptance and its status genesis commit together. This closure
    // is the ONLY thing that makes them one transaction, and it can only be
    // tied here: admission must not learn about status chains, and the
    // lifecycle engine must not learn about admission. A production wiring
    // that omitted it would reopen the race where a cancellation's answer
    // depended on which of two transactions had landed.
    createAcceptedGenesisInTx: (buyerDid, purchaseOrderId, openAt) =>
      lifecycleEngine.createAcceptedGenesisInTx(buyerDid, purchaseOrderId, openAt),
  });
  const admission = new CommerceAdmissionService({ transaction, engine: admissionEngine });
  const lifecycle = new CommerceReconciliationService({ transaction, engine: lifecycleEngine });

  const pendingDecisions = new SQLitePendingSupplierDecisionRepository(inputs.adapter);

  const credentials = new SQLiteCredentialStore(inputs.adapter);

  return {
    families,
    chains,
    orders,
    receipts,
    catalogPointers: new SQLiteCatalogPointerRepository(inputs.adapter),
    catalogDrafts: new SQLiteCatalogDraftRepository(inputs.adapter),
    skuLedger: new SQLiteSkuLedgerRepository(inputs.adapter),
    imageArtifacts: new SQLiteCommerceImageArtifactRepository(inputs.adapter),
    egressAuthorizations: new SQLiteImageEgressAuthorizationRepository(inputs.adapter),
    orderDrafts: new SQLiteOrderDraftRepository(inputs.adapter),
    tradeDocuments: new SQLiteTradeDocumentRepository(inputs.adapter),
    tenders: new SQLiteTenderRepository(inputs.adapter),
    staffGrants: new SQLiteStaffGrantRepository(inputs.adapter),
    staffPins: new SQLiteStaffPinRepository(inputs.adapter),
    attributionBoundary: new SQLiteAttributionBoundaryRepository(inputs.adapter),
    invites: new SQLiteInviteRepository(inputs.adapter),
    revshareDocuments: new SQLiteRevshareDocumentRepository(inputs.adapter),
    runInTransaction: (body) => { inputs.adapter.transaction(body); },
    now,
    watermarks: new SQLiteCommerceEpochWatermarkRepository(inputs.adapter),
    buyerOrders: new SQLiteBuyerOrderRepository(inputs.adapter),
    buyerStatus: new SQLiteBuyerStatusRepository(inputs.adapter),
    buyerQuotes: new SQLiteBuyerQuoteRepository(inputs.adapter),
    nodeDid: inputs.supplierDid,
    currentEpoch: inputs.currentEpoch,
    buyerQuoteRequests: new SQLiteBuyerQuoteRequestRepository(inputs.adapter),
    orderApprovals: new SQLiteOrderApprovalRepository(inputs.adapter),
    settings: new SQLiteCommerceSettingsRepository(inputs.adapter),
    credentials,
    idempotencyEvidence: new SQLiteIdempotencyEvidenceRepository(inputs.adapter),
    broker: new CredentialBroker({
      store: credentials,
      executors: inputs.credentialExecutors ?? ((): Record<string, BrokeredExecutor> => ({})),
      now,
    }),
    admission,
    lifecycle,
    pendingDecisions,
    inFlightCount: (installId?: string) => {
      // Undecided orders: the supplier owes an answer it has not given.
      // Unfinished chains: the supplier owes an outcome it has not reached.
      //
      // `delivered` is deliberately absent from TERMINAL_CHAIN_STATES, because
      // a buyer inside the dispute window can still dispute. But "still open"
      // is a question about the CLOCK, and this used to be asked without one:
      // `countNonTerminal` filters by state alone, so every delivered order
      // stayed open forever and a supplier who completed every sale normally
      // could never uninstall the pack that served them (§12.8, §16.4).
      //
      // The clock-aware rule already existed, in
      // `countUnfinishedByServingManifest`; uninstall simply called a
      // different method. Applying it here keeps ONE join — the in-memory
      // order-ref store cannot reach the head table, so a repository-level
      // version would only exist for one backend.
      // `listNonTerminal` yields keys, so the head is loaded to read its state
      // and deadline. Bounded by the number of OPEN chains, which is the set an
      // uninstall is asking about anyway.
      const stillOpen = (c: { buyerDid: string; purchaseOrderId: string }): boolean => {
        const head = heads.get(c.buyerDid, c.purchaseOrderId);
        // A key with no head is an obligation we cannot describe. Same rule as
        // the missing order reference below: unknown counts as open.
        if (head === undefined || head === null) return true;
        if (head.state !== 'delivered') return true;
        // ABSENT IS NOT EXPIRED. A delivered head with no recorded deadline
        // stays open: guessing one would close an obligation nobody ended.
        if (head.disputeWindowEndsAt === null) return true;
        return head.disputeWindowEndsAt > now();
      };

      if (installId === undefined) {
        return (
          orders.countReserved() +
          heads.listNonTerminal(TERMINAL_CHAIN_STATES).filter(stillOpen).length
        );
      }
      // Scoped. The chain store does not know which install served an order,
      // so the join happens HERE rather than inside either aggregate — the
      // same reason this method lives on the root at all. A chain whose order
      // reference is gone counts as OPEN: an obligation whose provenance we
      // cannot establish is not one to dismiss on an uninstall.
      const chains = heads.listNonTerminal(TERMINAL_CHAIN_STATES).filter((c) => {
        if (!stillOpen(c)) return false;
        const ref = orders.load(c.buyerDid, c.purchaseOrderId)?.ref;
        return ref === undefined || ref === null || ref.servingInstallId === installId;
      }).length;
      return orders.countReservedByServingInstall(installId) + chains;
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
  // §20.10 — the probing window lives and dies with the runtime. Composed
  // HERE rather than at each boot because there are two boots and the defence
  // is worthless on the one that forgets: an unwired ledger fails closed, so
  // forgetting it would take commerce offline rather than silently permit —
  // loud, but still an outage nobody chose.
  installQuoteAttemptLedger(
    value === null ? null : new QuoteAttemptLedger(DEFAULT_PROBING_POLICY.windowMs),
  );
  // §6.4 — attributed presence rides the runtime for the same reason the
  // probing ledger does: a verifier each boot must remember to install is
  // one a boot eventually forgets, and an unwired verifier fails closed —
  // loud, but an outage nobody chose. The PIN records live in the
  // runtime's own store; verification is core's platform-aware Argon2id.
  installStaffPresenceVerifier(
    value === null
      ? null
      : // The runtime clock, not a direct read: the lockout only ever
        // compares against stamps it wrote itself, and the injected clock
        // keeps every test able to place the world at any instant.
        (deviceDid, pin) => verifyStaffPinGated(value.staffPins, deviceDid, pin, value.now()),
  );
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
