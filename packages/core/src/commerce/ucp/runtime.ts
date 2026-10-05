/**
 * What the UCP search routes run on (UCP plan §3.11, §3.16): installed by
 * each boot once its identity database and release log exist; null until
 * then, and after close.
 *
 * The workflow service is looked up on every call, not captured: a server
 * boot replaces its first service when it wires the workflow plane, and a
 * card raised on the replaced one would never reach the owner.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { profileUrlForLabel, UCP_APP_CALLBACK_PATH, UCP_PROFILE_HOST } from '@dina/ucp';

import { getA2AReleaseLog } from '../../a2a/release_log';
import { readConversationTaint } from '../../chat/taint';
import {
  getWorkflowService,
  type WorkflowHooks,
  type WorkflowService,
} from '../../workflow/service';

import { UcpCartService } from './carts';
import { UcpCheckoutStore } from './checkout_store';
import { makeUcpCheckoutDecisionHandler, UcpCheckoutService } from './checkouts';
import { UcpDispatcher } from './dispatch';
import { ucpFetch } from './fetch';
import { getUcpIdentity } from './identity';
import { newUcpId } from './ids';
import { UcpLinkStore } from './link_store';
import { serverNodePaired, UcpLinkService } from './links';
import {
  installUcpLinkAuth,
  UcpMerchantClient,
  type UcpMerchantClientOptions,
} from './merchant_client';
import { merchantTrust } from './merchant_trust';
import { UcpOrderNotices } from './order_notices';
import { UcpOrderStore } from './order_store';
import { UcpOrderService } from './orders';
import { recordPurchase } from './purchase_record';
import { UcpSearchStore } from './search_store';
import { UcpSettingsStore } from './settings';
import { UcpHandoffWatcher } from './watcher';
import {
  UCP_OAUTH_CALLBACK_PATH,
  ucpOrderWebhookUrl,
  ucpPublicOrigin,
  UcpWebhookService,
  UcpWebhookStore,
} from './webhooks';

import type { SearchDeps } from './search';
import type { DatabaseAdapter } from '../../storage/db_adapter';

export type UcpSearchRuntime = Omit<SearchDeps, 'workflow'> & {
  workflow: () => WorkflowService | null;
};

let installed: UcpSearchRuntime | null = null;

export function installUcpSearchRuntime(runtime: UcpSearchRuntime | null): void {
  installed = runtime;
}

/** The search dependencies for one call; null when UCP search is not installed or no workflow service runs. */
export function getUcpSearchRuntime(): SearchDeps | null {
  if (installed === null) return null;
  const workflow = installed.workflow();
  return workflow === null ? null : { ...installed, workflow };
}

/**
 * A node's search runtime on its identity database, with the installed
 * release log, the installed UCP identity and policy socket (the merchant
 * client's defaults), and the live workflow service. Null when no release
 * log is installed: a search's projection check cannot run without one.
 */
export function createUcpSearchRuntime(
  db: DatabaseAdapter,
  options: { client?: UcpMerchantClientOptions } = {},
): UcpSearchRuntime | null {
  const log = getA2AReleaseLog();
  if (log === null) return null;
  return {
    store: new UcpSearchStore(db),
    client: new UcpMerchantClient(options.client),
    check: {
      log,
      taint: (sessionId) => readConversationTaint(db, log, sessionId),
      nowMs: Date.now,
    },
    workflow: getWorkflowService,
    settings: () => new UcpSettingsStore(db).get(),
    nowMs: Date.now,
    newId: newUcpId,
  };
}

// ------------------------------------------------------------ checkout and carts

/** How often the checkout sweep runs: an approval the handler missed, a lost answer to resend. */
export const UCP_SWEEP_INTERVAL_MS = 60_000;

/**
 * What checkouts and carts run on (UCP plan §3.7, §3.10, U2.3–U2.4): one
 * journal and dispatcher on the identity database (where the workflow's
 * cards live too, so a card and its session are written in one transaction),
 * and the sweep that repairs and resends.
 */
export interface UcpCheckoutRuntime {
  checkouts: UcpCheckoutService;
  carts: UcpCartService;
  /** Reads handed-off sessions back (§3.12); `recover` once when the app reopens. */
  watcher: UcpHandoffWatcher;
  /** Follows the orders completed sessions named (§3.14). */
  orders: UcpOrderService;
  /** The orders themselves, for My Orders. */
  orderStore: UcpOrderStore;
  /** Takes order webhooks from the gateway (§3.13). */
  webhooks: UcpWebhookService;
  /** Linked accounts at merchants (§3.17). */
  links: UcpLinkService;
  /** Raises an order's interruptions as cards, and takes the owner's "Seen" (§3.14). */
  notices: UcpOrderNotices;
  /** Verify and apply stored deliveries now (after one is accepted); one pass at a time. */
  processWebhooks(): void;
  /** Start the periodic sweep; stopped by `stop`. */
  start(): void;
  stop(): void;
}

let checkoutRuntime: UcpCheckoutRuntime | null = null;

export function installUcpCheckoutRuntime(runtime: UcpCheckoutRuntime | null): void {
  if (checkoutRuntime !== null && checkoutRuntime !== runtime) checkoutRuntime.stop();
  checkoutRuntime = runtime;
  // Every merchant client (search and checkout alike) uses this node's linked accounts.
  installUcpLinkAuth(runtime?.links ?? null);
}

export function getUcpCheckoutRuntime(): UcpCheckoutRuntime | null {
  return checkoutRuntime;
}

/** A node's checkout runtime on its identity database, with the installed UCP identity and trust source. */
export function createUcpCheckoutRuntime(
  db: DatabaseAdapter,
  options: {
    client?: UcpMerchantClientOptions;
    holder?: string;
    /**
     * Whether this node is the Dina app, which catches its own claimed link
     * (§3.17). A server without a public origin is not: its sign-in pages
     * go to the paired phone on a card.
     */
    linksOpenHere?: boolean;
    /**
     * On a server without a public origin: whether a phone is paired as
     * this node's own, to carry the sign-in and catch the answer. None: no.
     */
    phoneReady?: () => boolean;
  } = {},
): UcpCheckoutRuntime {
  const store = new UcpCheckoutStore(db);
  const client = new UcpMerchantClient(options.client);
  // One holder per process: a slot or order lease left by a crashed process is retaken after it ends.
  const holder = options.holder ?? `node-${newUcpId()}`;
  const dispatcher = new UcpDispatcher({
    store,
    nowMs: Date.now,
    // Hermes has no crypto.randomUUID: the portable generator, as every other UCP id.
    newKey: newUcpId,
    holder,
  });
  const search = new UcpSearchStore(db);
  const settings = () => new UcpSettingsStore(db).get();
  // The owner's last turn, read from the installed release log each time (none: no turn).
  const ownerTurn = (conversation: string) =>
    getA2AReleaseLog()?.latestUtterance(conversation)?.recorded_at ?? null;
  const orderStore = new UcpOrderStore(db);
  const orders = new UcpOrderService({
    store: orderStore,
    client,
    nowMs: Date.now,
    holder,
    // A public server with order webhooks on polls daily; every other node polls on the schedule.
    takesWebhooks: () => ucpOrderWebhookUrl() !== null,
    // A challenge pauses polling only where the owner could link (declared below; read per poll).
    canLink: (origin, scopes) => links.canLink(origin, scopes),
    linkView: (origin) => links.view(origin),
  });
  const checkouts = new UcpCheckoutService({
    store,
    onCompleted: (row, now) => orders.track(row, now),
    search,
    client,
    dispatcher,
    workflow: getWorkflowService,
    settings,
    trust: async (origin) =>
      (await merchantTrust([origin])).get(origin) ?? { state: 'unavailable' },
    ownerTurn,
    nowMs: Date.now,
    newId: newUcpId,
  });
  const carts = new UcpCartService({
    store,
    search,
    client,
    dispatcher,
    settings,
    ownerTurn,
    nowMs: Date.now,
    newId: newUcpId,
  });
  const webhooks = new UcpWebhookService({
    store: new UcpWebhookStore(db),
    checkouts: store,
    orders: orderStore,
    orderService: orders,
    client,
    nowMs: Date.now,
    newId: newUcpId,
    webhookUrl: ucpOrderWebhookUrl,
    onCompleted: (row, now) => orders.track(row, now),
  });
  let processing = false;
  const processWebhooks = (): void => {
    if (processing) return;
    processing = true;
    void webhooks
      .sweep()
      .catch(() => undefined)
      .finally(() => {
        processing = false;
      });
  };
  const notices = new UcpOrderNotices({
    store: orderStore,
    checkouts: store,
    workflow: getWorkflowService,
    nowMs: Date.now,
    newId: newUcpId,
  });
  const profileHost = options.client?.profileHost ?? UCP_PROFILE_HOST;
  const links = new UcpLinkService({
    store: new UcpLinkStore(db),
    client,
    fetch: ucpFetch,
    // D6: a public client; its id is Dina's own profile URL (the owner's own per merchant comes later).
    clientId: () => {
      const identity = (options.client?.identity ?? getUcpIdentity)();
      return identity === null ? null : profileUrlForLabel(identity.label, profileHost);
    },
    // §3.17: a public server takes the callback at its gateway; any other node through its
    // claimed link on the profile host, which the Dina app opens.
    redirectUri: () => {
      const origin = ucpPublicOrigin();
      if (origin !== null) return `${origin}${UCP_OAUTH_CALLBACK_PATH}`;
      const identity = (options.client?.identity ?? getUcpIdentity)();
      return identity === null
        ? null
        : `https://${identity.label}.${profileHost}${UCP_APP_CALLBACK_PATH}`;
    },
    nowMs: Date.now,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    sha256: (b) => sha256(b),
    newId: newUcpId,
    holder,
    onLinked: (origin, now) => orderStore.resumeAfterLink(origin, now),
    opensHere: () => options.linksOpenHere === true || ucpPublicOrigin() !== null,
    phoneReady: options.phoneReady ?? (() => false),
    serverPaired: serverNodePaired,
    workflow: getWorkflowService,
  });
  const watcher = new UcpHandoffWatcher({
    store,
    client,
    nowMs: Date.now,
    onCompleted: (row, now) => orders.track(row, now),
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const tick = async () => {
    // One sweep at a time: a slow merchant never stacks them up.
    if (running) return;
    running = true;
    try {
      carts.sweep();
      await checkouts.sweep();
      await watcher.sweep();
      await orders.sweep();
      notices.raise();
      await links.sweep();
      recordPurchases(orderStore);
      processWebhooks();
    } catch {
      /* the next tick tries again */
    } finally {
      running = false;
    }
  };
  return {
    checkouts,
    carts,
    watcher,
    orders,
    orderStore,
    webhooks,
    links,
    notices,
    processWebhooks,
    start() {
      if (timer !== null) return;
      // A start is a reopen: one more read of what was handed off lately and is still open.
      void watcher.recover().catch(() => undefined);
      void tick();
      timer = setInterval(() => void tick(), UCP_SWEEP_INTERVAL_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

/** UCP's part of the workflow service, composed at every host: the start card's decision. */
export function ucpWorkflowHooks(): WorkflowHooks {
  return {
    responseEgressGate: () => ({ kind: 'passthrough' }),
    approvalDecisionHandler: (args) => {
      makeUcpCheckoutDecisionHandler(() => getUcpCheckoutRuntime()?.checkouts ?? null)(args);
      getUcpCheckoutRuntime()?.notices.decide(args.task, args.decision);
      getUcpCheckoutRuntime()?.links.decide(args.task, args.decision);
    },
  };
}

/** Orders read per pass for their `purchase_decision` item. */
const PURCHASES_PER_PASS = 20;

/**
 * Record each order's purchase in the vault once (§3.14, D5); one whose
 * persona is closed now waits for a later pass.
 */
export function recordPurchases(store: UcpOrderStore): void {
  for (const row of store.decisionsDue(PURCHASES_PER_PASS)) {
    try {
      const id = recordPurchase(row);
      if (id !== null) store.setDecisionItem(row, id);
    } catch {
      /* the vault refused it now (locked, not wired): the next pass tries again */
    }
  }
}
