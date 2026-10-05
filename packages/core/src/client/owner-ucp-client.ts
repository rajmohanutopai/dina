/**
 * The owner's UCP calls (UCP plan §4.2 U1): which merchants Dina may use and
 * which `context` fields leave with a search, and a search as the owner sees
 * it (the comparison card) with each shop's PeerLens trust. One transport-neutral client over the owner
 * dispatcher, so the phone (in-process) and the web app (the owner's signed
 * calls) read Core the same way.
 */

import {
  UCP_OWNER_LINK_CALLBACK,
  UCP_OWNER_LINK_DISMISS,
  UCP_OWNER_LINK_START,
  UCP_OWNER_LINK_UNLINK,
  UCP_OWNER_LINKS,
  UCP_OWNER_ORDER_DONE,
  UCP_OWNER_ORDERS,
  UCP_OWNER_PUBLICATION,
  UCP_OWNER_SEARCHES,
  UCP_OWNER_SETTINGS,
} from '../server/routes/ucp';

import type { OwnerDispatcher } from './owner-dispatch';
import type { MerchantTrust } from '../commerce/ucp/merchant_trust';
import type { UcpOrderView } from '../commerce/ucp/order_view';
import type {
  UcpPublicationAction,
  UcpPublicationView,
} from '../commerce/ucp/publication_control';
import type { OwnerSearchView } from '../commerce/ucp/search';
import type { UcpSettings } from '../commerce/ucp/settings';
import type { CoreResponse } from '../server/router';

export class OwnerUcpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Core's refusal code (`invalid_settings`, `not_found`, …), when it sent one. */
    readonly code: string | null,
    /** The settings field Core refused, when it named one. */
    readonly field: string | null,
  ) {
    super(message);
    this.name = 'OwnerUcpHttpError';
  }

  /** Core's refusal code under the name every owner screen reads (`owner_errors.ts`). */
  get errorKey(): string {
    return this.code ?? '';
  }
}

function expectStatus<T>(res: CoreResponse, ok: number, ctx: string): T {
  if (res.status === ok) return res.body as T;
  const b = (res.body ?? {}) as { error?: unknown; field?: unknown };
  throw new OwnerUcpHttpError(
    `${ctx}: HTTP ${res.status}`,
    res.status,
    typeof b.error === 'string' ? b.error : null,
    typeof b.field === 'string' ? b.field : null,
  );
}

/** A linked account at a merchant as the owner sees it (§3.17); never its tokens. */
export interface UcpLinkOwnerView {
  merchant_origin: string;
  merchant_host: string;
  scopes: string[];
  /** `active`; `needs_relink` (the merchant refused the refresh); `revoking` (unlinking). */
  state: 'active' | 'needs_relink' | 'revoking';
  linked_at: number;
  updated_at: number;
}

/** Everything Linked accounts shows. */
export interface UcpLinksOwnerView {
  links: UcpLinkOwnerView[];
  /** Shops that asked for a linked account on some call (`scopes`: what their challenge named). */
  wanted: { merchant_origin: string; merchant_host: string; scopes: string[]; at: number }[];
  /** Access Dina could not take back after unlinking: the owner removes it at the shop. */
  unrevoked: { merchant_origin: string; merchant_host: string; since: number }[];
  /** The last day's attempts that ended without a link (`outcome`: Core's reason). */
  failed: { merchant_origin: string; merchant_host: string; outcome: string; at: number }[];
}

/**
 * Starting a link: the merchant's page to open here, the card that carried
 * it to the paired phone (a server behind NAT), or why Dina will not link there.
 */
export type UcpLinkStart =
  | { started: true; opens: 'here'; url: string; scopes: string[]; expires_at: number }
  | { started: true; opens: 'phone'; card_id: string; scopes: string[]; expires_at: number }
  | { started: false; reason: string };

/** A callback the Dina app caught: linked here, kept for the paired server, or not linked. */
export type UcpLinkCallback =
  | { linked: true; merchant_host: string }
  | { linked: false; held: true }
  | { linked: false; reason: string };

/** The settings as Core holds them, and whether this node runs UCP now (they apply once it does). */
export type UcpSettingsView = UcpSettings & { searching: boolean };

function settingsView(body: UcpSettings & { searching?: unknown }): UcpSettingsView {
  return { merchants: body.merchants, context: body.context, searching: body.searching === true };
}

export class OwnerUcpClient {
  constructor(private readonly dispatcher: OwnerDispatcher) {}

  /** The allowed merchants and context fields. */
  async settings(): Promise<UcpSettingsView> {
    const res = await this.dispatcher.dispatch({ method: 'GET', path: UCP_OWNER_SETTINGS });
    return settingsView(expectStatus<UcpSettings>(res, 200, 'ucp settings'));
  }

  /** Save them; Core answers with the settings as stored (origins normalised and sorted). */
  async saveSettings(settings: UcpSettings): Promise<UcpSettingsView> {
    const res = await this.dispatcher.dispatch({
      method: 'PUT',
      path: UCP_OWNER_SETTINGS,
      body: { merchants: settings.merchants, context: settings.context },
    });
    return settingsView(expectStatus<UcpSettings>(res, 200, 'save ucp settings'));
  }

  /**
   * My Orders for shop (UCP) orders, newest first; null on a node that does
   * not run UCP, which has none.
   */
  async orders(limit?: number): Promise<UcpOrderView[] | null> {
    const res = await this.dispatcher.dispatch({
      method: 'GET',
      path: UCP_OWNER_ORDERS,
      ...(limit !== undefined ? { query: { limit: String(limit) } } : {}),
    });
    if (res.status === 503) return null;
    return expectStatus<{ orders: UcpOrderView[] }>(res, 200, 'ucp orders').orders;
  }

  /** Mark an order fed by webhooks alone as done (§3.13); Core refuses any other. */
  async markOrderDone(merchantOrigin: string, orderId: string): Promise<UcpOrderView | null> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: UCP_OWNER_ORDER_DONE,
      body: { merchant_origin: merchantOrigin, order_id: orderId },
    });
    return expectStatus<{ order: UcpOrderView | null }>(res, 200, 'mark ucp order done').order;
  }

  /** The owner's linked accounts and what goes with them; null on a node that does not run UCP. */
  async links(): Promise<UcpLinksOwnerView | null> {
    const res = await this.dispatcher.dispatch({ method: 'GET', path: UCP_OWNER_LINKS });
    if (res.status === 503) return null;
    const b = expectStatus<Partial<UcpLinksOwnerView>>(res, 200, 'ucp links');
    return {
      links: b.links ?? [],
      wanted: b.wanted ?? [],
      unrevoked: b.unrevoked ?? [],
      failed: b.failed ?? [],
    };
  }

  /** The profile's publication and key ring (§3.5, §4.8); null when this node does not run UCP. */
  async publication(): Promise<UcpPublicationView | null> {
    const res = await this.dispatcher.dispatch({ method: 'GET', path: UCP_OWNER_PUBLICATION });
    if (res.status === 503) return null;
    return expectStatus<UcpPublicationView>(res, 200, 'ucp publication');
  }

  /**
   * One of the owner's actions on it; the view it leaves. Throws
   * `OwnerUcpHttpError` (403 `no_user_presence`) when the action needs the
   * owner to confirm it is them first.
   */
  async publicationAction(action: UcpPublicationAction): Promise<UcpPublicationView> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: UCP_OWNER_PUBLICATION,
      body: { action },
    });
    return expectStatus<UcpPublicationView>(res, 200, 'ucp publication action');
  }

  /** The owner removed Dina's access at the shop by hand. */
  async dismissUnrevoked(merchantOrigin: string): Promise<boolean> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: UCP_OWNER_LINK_DISMISS,
      body: { merchant_origin: merchantOrigin },
    });
    return expectStatus<{ dismissed: boolean }>(res, 200, 'ucp dismiss').dismissed;
  }

  /**
   * Start linking an account at a merchant; `scopes`: the full set a
   * merchant's challenge named (only those missing from a live link are asked).
   */
  async startLink(merchantOrigin: string, scopes: readonly string[] = []): Promise<UcpLinkStart> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: UCP_OWNER_LINK_START,
      body: { merchant_origin: merchantOrigin, ...(scopes.length > 0 ? { scopes } : {}) },
    });
    return expectStatus<UcpLinkStart>(res, 200, 'start ucp link');
  }

  /** Unlink at once (its tokens are revoked after); false when there was no link. */
  async unlink(merchantOrigin: string): Promise<boolean> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: UCP_OWNER_LINK_UNLINK,
      body: { merchant_origin: merchantOrigin },
    });
    return expectStatus<{ unlinked: boolean }>(res, 200, 'ucp unlink').unlinked;
  }

  /** Hand Core a callback the Dina app's claimed link caught. */
  async linkCallback(params: Readonly<Record<string, string>>): Promise<UcpLinkCallback> {
    const res = await this.dispatcher.dispatch({
      method: 'POST',
      path: UCP_OWNER_LINK_CALLBACK,
      body: params,
    });
    return expectStatus<UcpLinkCallback>(res, 200, 'ucp link callback');
  }

  /** A search as the owner sees it; null when it no longer exists (searches are kept a day). */
  async search(searchId: string): Promise<OwnerSearchView | null> {
    const res = await this.dispatcher.dispatch({
      method: 'GET',
      path: `${UCP_OWNER_SEARCHES}/${encodeURIComponent(searchId)}`,
    });
    if (res.status === 404) return null;
    return expectStatus<OwnerSearchView>(res, 200, 'ucp search');
  }

  /**
   * Each of a search's shops' PeerLens trust, as Core looked it up (origin to
   * trust); empty when the search no longer exists. A line that does not read
   * is left out, and the card shows that shop without one.
   */
  async trust(searchId: string): Promise<Map<string, MerchantTrust>> {
    const res = await this.dispatcher.dispatch({
      method: 'GET',
      path: `${UCP_OWNER_SEARCHES}/${encodeURIComponent(searchId)}/trust`,
    });
    if (res.status === 404) return new Map();
    const body = expectStatus<{ merchants?: unknown }>(res, 200, 'ucp trust');
    const out = new Map<string, MerchantTrust>();
    for (const entry of Array.isArray(body.merchants) ? body.merchants : []) {
      const e = entry as { origin?: unknown; trust?: unknown } | null;
      const trust = e === null || typeof e !== 'object' ? null : asTrust(e.trust);
      if (trust !== null && typeof e?.origin === 'string') out.set(e.origin, trust);
    }
    return out;
  }
}

function asTrust(value: unknown): MerchantTrust | null {
  if (value === null || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;
  if (t.state === 'unrated' || t.state === 'unavailable') return { state: t.state };
  if (
    t.state === 'rated' &&
    typeof t.recommendation === 'string' &&
    typeof t.level === 'string' &&
    typeof t.reviews === 'number'
  )
    return { state: 'rated', recommendation: t.recommendation, level: t.level, reviews: t.reviews };
  return null;
}
