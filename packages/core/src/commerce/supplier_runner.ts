/**
 * The reference supplier runner — the first-party answer to a buyer's quote,
 * order, status and cancellation queries (JIFFY_MERCHANT_INTEGRATION_PLAN
 * review, item 5).
 *
 * The supplier pack runs in runner mode: an inbound query becomes a task on
 * the install's `plugin:<install_id>` lane, and a runner claims it, answers
 * with COMMERCIAL TERMS, and Core does the rest — validates the answer
 * against the pinned schema, composes the arithmetic, signs, holds capacity,
 * applies the owner's acceptance policy and replies. Until now the only
 * runner was a script in the gitignored test bed, so a server node could
 * install the pack and never answer anyone.
 *
 * WHAT IT DECIDES, AND WHAT IT DOES NOT.
 *   - A quote prices each line from the catalogue this business PUBLISHED —
 *     the owner's own approved terms, the same bytes the buyer read. A line
 *     the catalogue does not carry, carries without a price, or sells in a
 *     different unit declines the whole request with a reason; nothing is
 *     guessed. A connector like Jiffy moves prices only through the
 *     catalogue refresh, which the owner approves.
 *   - An order is `accepted` with this node's own order reference. Core has
 *     already bound it to the quote and its capacity, and Core turns the
 *     acceptance into an owner decision when the supplier chose `review`
 *     (§15.2b) — policy is Core's, not the runner's.
 *   - Status reports what Core recorded; Core replaces it with the signed
 *     chain whenever one exists.
 *   - A cancellation is granted; Core itself refuses one after dispatch.
 *
 * HOW IT RUNS. It is a client of the node's own routes, exactly as an
 * external runner is: it claims through `/v1/workflow/tasks/claim` (the
 * plugin claim guard — exact lane, install active, consent, scope and
 * config pins) and completes through `/complete` (the pinned-schema check),
 * over an injected dispatch. The host hands it the in-process router; the
 * same class would run over signed HTTP. It serves only the install whose
 * runner device Core minted for it (`referenceRunnerDevice`), never a device
 * an operator paired for an external runner.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import {
  compareQuantities,
  type CatalogItem,
  type ProductRef,
  type Quantity,
} from '@dina/commerce-protocol';

import { getPublicKey } from '../crypto/ed25519';
import { deriveDIDKey, publicKeyToMultibase } from '../identity/did';
import { kvGet, kvSet } from '../kv/store';
import { completePairing, generatePairingCode } from '../pairing/ceremony';
import { getPluginInstallRepository } from '../plugins/registry';
import { parsePluginEnvelope } from '../workflow/plugin_envelope';

import { findPublishedItem, publishedCatalogItems } from './published_catalog';
import { BUYER_REFERENCE_MANIFEST, SUPPLIER_REFERENCE_MANIFEST } from './reference_manifests';
import { rehydrateAcknowledgement } from './rehydrate';
import { getCommerceRuntime, type CommerceRuntime } from './runtime';

const REFERENCE_RUNNER_KEY = 'commerce.reference_supplier_runner_device';

/** The runner device Core minted for the reference runner, if any. */
export async function referenceRunnerDevice(): Promise<string | null> {
  const value = await kvGet(REFERENCE_RUNNER_KEY);
  return value === null || value === '' ? null : value;
}

export async function rememberReferenceRunnerDevice(deviceDid: string): Promise<void> {
  await kvSet(REFERENCE_RUNNER_KEY, deviceDid);
}

export type BindReferenceRunnerOutcome =
  | { ok: true; deviceDid: string }
  | {
      ok: false;
      refusal:
        | 'install_not_found'
        | 'not_a_first_party_pack'
        | 'install_not_pending'
        | 'pairing_failed';
      detail?: string;
    };

/**
 * Pair the reference runner to a PENDING first-party install — the owner's
 * alternative to pairing an external runner device through the admin
 * ceremony. For the SUPPLIER pack the device is the one this runner serves.
 * The BUYER pack's capabilities are the owner's own tools and never wait on a
 * lane, so its device only completes the install (the phone does the same in
 * `activateBuyerInstall`); nothing claims for it. Core mints the device key and keeps only its DID: the runner
 * reaches the routes in process and never signs, so no private key outlives
 * this call. The pairing intent names the install, so the ceremony's own
 * bind check applies (`runnerInstallRefusal`). Consent stays a separate act.
 */
export async function bindReferenceRunner(installId: string): Promise<BindReferenceRunnerOutcome> {
  const installs = getPluginInstallRepository();
  const install = installs?.getById(installId) ?? null;
  if (install === null) return { ok: false, refusal: 'install_not_found' };
  const supplier = install.pluginId === SUPPLIER_REFERENCE_MANIFEST.plugin_id;
  if (!supplier && install.pluginId !== BUYER_REFERENCE_MANIFEST.plugin_id) {
    return { ok: false, refusal: 'not_a_first_party_pack' };
  }
  if (install.status !== 'pending') return { ok: false, refusal: 'install_not_pending' };
  const seed = randomBytes(32);
  const publicKey = getPublicKey(seed);
  seed.fill(0);
  const deviceName = supplier ? 'commerce-reference-runner' : 'commerce-buyer-runner';
  try {
    const { code } = generatePairingCode({
      deviceName,
      role: 'plugin',
      scope: 'runner',
      pluginInstallId: installId,
    });
    completePairing(code, deviceName, publicKeyToMultibase(publicKey), 'plugin', 'runner');
  } catch (err) {
    return {
      ok: false,
      refusal: 'pairing_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const deviceDid = deriveDIDKey(publicKey);
  if (supplier) await rememberReferenceRunnerDevice(deviceDid);
  return { ok: true, deviceDid };
}

// ---------------------------------------------------------------------------
// Answers (pure)
// ---------------------------------------------------------------------------

export type SupplierAnswer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

interface QuoteLineParam {
  line_id: string;
  product: ProductRef;
  requested_quantity: Quantity;
}

function readQuoteLines(params: unknown): QuoteLineParam[] | null {
  if (params === null || typeof params !== 'object') return null;
  const lines = (params as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const out: QuoteLineParam[] = [];
  for (const raw of lines) {
    if (raw === null || typeof raw !== 'object') return null;
    const line = raw as Record<string, unknown>;
    const product = line.product as ProductRef | undefined;
    const quantity = line.requested_quantity as Quantity | undefined;
    if (typeof line.line_id !== 'string' || product === undefined || quantity === undefined)
      return null;
    if (typeof product.scheme !== 'string' || typeof product.value !== 'string') return null;
    if (typeof quantity.value !== 'string' || typeof quantity.unit_code !== 'string') return null;
    out.push({ line_id: line.line_id, product, requested_quantity: quantity });
  }
  return out;
}

function decline(reason: string): SupplierAnswer {
  return { ok: true, result: { can_supply: false, decline_reason: reason } };
}

/**
 * Price a quote request from the published catalogue. All or nothing: a
 * quote is one offer, and pricing half of it would offer terms the buyer did
 * not ask for.
 */
export function answerQuoteRequest(params: unknown, items: readonly CatalogItem[]): SupplierAnswer {
  const lines = readQuoteLines(params);
  if (lines === null) return { ok: false, error: 'quote request: lines are unreadable' };
  const priced: Record<string, unknown>[] = [];
  for (const line of lines) {
    const item = findPublishedItem(items, line.product);
    if (item === null) return decline(`not_in_catalog: ${line.line_id}`);
    if (item.indicative_price === undefined) return decline(`no_published_price: ${line.line_id}`);
    // The published price is per ONE sell unit; a line in another unit, or a
    // pack priced as a whole, has no exact per-unit price here.
    const sellUnit = item.pack.sell_unit;
    if (sellUnit.value !== '1' || sellUnit.unit_code !== line.requested_quantity.unit_code) {
      return decline(`unit_mismatch: ${line.line_id}`);
    }
    if (item.minimum_order !== undefined) {
      const compared = compareQuantities(line.requested_quantity, item.minimum_order);
      if (typeof compared === 'string') return decline(`unit_mismatch: ${line.line_id}`);
      if (compared < 0) return decline(`below_minimum_order: ${line.line_id}`);
    }
    priced.push({
      line_id: line.line_id,
      unit_price: item.indicative_price,
      quantity: line.requested_quantity,
    });
  }
  return { ok: true, result: { can_supply: true, lines: priced } };
}

/** This business's own reference for an order it takes — stable per purchase order. */
export function supplierOrderReference(purchaseOrderId: string): string {
  const digest = sha256(new TextEncoder().encode(purchaseOrderId));
  const hex = Array.from(digest.slice(0, 5), (b) => b.toString(16).padStart(2, '0')).join('');
  return `SO-${hex.toUpperCase()}`;
}

export function answerSubmitOrder(params: unknown): SupplierAnswer {
  const po =
    params !== null && typeof params === 'object'
      ? (params as { purchase_order_id?: unknown }).purchase_order_id
      : undefined;
  if (typeof po !== 'string' || po === '')
    return { ok: false, error: 'order: purchase_order_id is missing' };
  return { ok: true, result: { kind: 'accepted', supplier_order_id: supplierOrderReference(po) } };
}

/**
 * The status of the ASKING buyer's order. The buyer is the transport-
 * authenticated sender Core stamped on the task (`service_ingress.from_did`),
 * never a payload field, and buyers choose their own purchase order ids, so
 * two buyers may both hold `PO-1001`: the lookup is always by the pair.
 */
export function answerOrderStatus(
  params: unknown,
  runtime: Pick<CommerceRuntime, 'orders'>,
  buyerDid: string,
): SupplierAnswer {
  const po =
    params !== null && typeof params === 'object'
      ? (params as { purchase_order_id?: unknown }).purchase_order_id
      : undefined;
  if (typeof po !== 'string' || po === '')
    return { ok: false, error: 'status: purchase_order_id is missing' };
  const order = buyerDid === '' ? null : runtime.orders.load(buyerDid, po);
  const ref = order === null ? null : order.ref;
  if (ref === null || ref.state !== 'decided') return { ok: false, error: 'no_status_yet' };
  const ack = rehydrateAcknowledgement(ref.acknowledgementJson, sha256);
  if (!ack.ok) return { ok: false, error: 'no_status_yet' };
  // Core overwrites this with the signed chain head whenever a chain exists.
  return ack.value.kind === 'accepted'
    ? { ok: true, result: { state: 'accepted', supplier_order_id: ack.value.supplier_order_id } }
    : { ok: true, result: { state: 'rejected' } };
}

export function answerCancellation(): SupplierAnswer {
  return { ok: true, result: { verdict: 'cancelled' } };
}

export function answerSupplierTask(
  capabilityId: string,
  params: unknown,
  deps: {
    items: () => readonly CatalogItem[];
    runtime: Pick<CommerceRuntime, 'orders'>;
    /** The authenticated requester Core stamped on the task; '' when none. */
    buyerDid: string;
  },
): SupplierAnswer {
  switch (capabilityId) {
    case 'com.dinakernel.commerce.request-quote':
      return answerQuoteRequest(params, deps.items());
    case 'com.dinakernel.commerce.submit-order':
      return answerSubmitOrder(params);
    case 'com.dinakernel.commerce.order-status':
      return answerOrderStatus(params, deps.runtime, deps.buyerDid);
    case 'com.dinakernel.commerce.cancel-order':
      return answerCancellation();
    default:
      return { ok: false, error: `unsupported capability ${capabilityId}` };
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** One call on the node's own routes as the runner device. */
export type SupplierRunnerDispatch = (call: {
  path: string;
  body: Record<string, unknown>;
  deviceDid: string;
}) => Promise<{ status: number; body: unknown }>;

export interface SupplierReferenceRunnerOptions {
  /** Resolved per tick: the router is installed after the sweepers start. */
  dispatch: () => SupplierRunnerDispatch | null;
  intervalMs?: number;
  maxTasksPerTick?: number;
  onError?: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class SupplierReferenceRunner {
  private handle: unknown = null;
  private running = false;

  constructor(private readonly options: SupplierReferenceRunnerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = every(() => {
      void this.runTick().catch((err: unknown) => this.options.onError?.(err));
    }, this.options.intervalMs ?? 2000);
  }

  stop(): void {
    if (this.handle === null) return;
    const clear =
      this.options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }

  /** One pass: claim and answer until the lane is empty or the tick budget is spent. */
  async runTick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.tick();
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<number> {
    const runtime = getCommerceRuntime();
    const dispatch = this.options.dispatch();
    const installs = getPluginInstallRepository();
    if (runtime === null || dispatch === null || installs === null) return 0;
    const deviceDid = await referenceRunnerDevice();
    if (deviceDid === null) return 0;
    const install = installs.getByDeviceDid(deviceDid);
    if (
      install === null ||
      install.status !== 'active' ||
      install.pluginId !== SUPPLIER_REFERENCE_MANIFEST.plugin_id
    ) {
      return 0;
    }
    let handled = 0;
    const budget = this.options.maxTasksPerTick ?? 10;
    while (handled < budget) {
      const claimed = await dispatch({
        path: '/v1/workflow/tasks/claim',
        body: { lease_seconds: 60 },
        deviceDid,
      });
      if (claimed.status !== 200 || claimed.body === null || typeof claimed.body !== 'object')
        break;
      const task = claimed.body as { id?: unknown; claim_id?: unknown; payload?: unknown };
      if (typeof task.id !== 'string' || typeof task.payload !== 'string') break;
      const claimId = typeof task.claim_id === 'string' ? task.claim_id : undefined;
      const envelope = parsePluginEnvelope(task.payload);
      const answer: SupplierAnswer =
        envelope === null
          ? { ok: false, error: 'plugin envelope unreadable' }
          : answerSupplierTask(envelope.capability_id, envelope.params, {
              items: () => publishedCatalogItems(runtime),
              runtime,
              buyerDid: envelope.service_ingress?.from_did ?? '',
            });
      const tail = claimId === undefined ? {} : { claim_id: claimId };
      if (answer.ok) {
        await dispatch({
          path: `/v1/workflow/tasks/${task.id}/complete`,
          body: { result: JSON.stringify(answer.result), ...tail },
          deviceDid,
        });
      } else {
        await dispatch({
          path: `/v1/workflow/tasks/${task.id}/fail`,
          body: { error: answer.error, ...tail },
          deviceDid,
        });
      }
      handled += 1;
    }
    return handled;
  }
}
