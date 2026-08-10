import { checkCatalogFeedUrl } from './catalog_feed_policy';
import { MAX_QUOTE_FANOUT } from './quote_fanout';

import type { RegionRef } from '@dina/commerce-protocol';

/**
 * Buyer and supplier settings (§18.2, §18.3 — WS-7.2 / WS-7.3).
 *
 * SETTINGS ARE POLICY, AND POLICY IS AN INPUT TO REFUSALS. That is why these
 * live in Core beside the engines that read them rather than in a client: a
 * fan-out ceiling stored on a phone is a ceiling that stops applying when the
 * server acts, and a blocked-supplier list that only the UI knows is a list
 * nothing enforces.
 *
 * EVERY FIELD IS VALIDATED ON THE WAY IN, and the validation is deliberately
 * unhelpful where the spec is strict: a fan-out ceiling above the protocol
 * maximum is REFUSED rather than clamped, because an owner who typed 50 and
 * silently got 8 believes something about their node that is not true. The
 * one exception is documented at its site.
 *
 * WHAT IS NOT HERE. No credentials, no connector secrets, no PDS tokens.
 * §18.3 lists "connector health and credential status", which is a STATUS —
 * whether a credential works and when it was last checked — and never the
 * credential. A settings record is the most-read, most-exported, most-synced
 * object a node has; it is the last place a secret should be able to reach.
 */

export interface BuyerSettings {
  /** Business or personal acting identity (§18.2). */
  actingIdentityDid: string;
  /** Delivery locations the pack may use. Empty means "ask every time". */
  locations: RegionRef[];
  preferredSuppliers: string[];
  blockedSuppliers: string[];
  /** Category ids the pack may buy in. Empty means unrestricted. */
  allowedCategoryIds: string[];
  /** §12.3/§20.17 — how many suppliers one request may reach. */
  quoteFanoutCeiling: number;
  /** §15 — a summary an owner reads, not the policy engine's own rules. */
  approvalPolicySummary: string;
  currency: string;
  /** Preferred unit codes, in the §9.2 vocabulary. */
  preferredUnitCodes: string[];
  /** Whether outcome reviews are published or kept private (§10.7, Law 2). */
  publishReviews: boolean;
}

export type ListingState = 'live' | 'paused' | 'withdrawn';

export interface SupplierSettings {
  actingBusinessDid: string;
  /** Where the catalog comes from, and when it was last confirmed healthy. */
  catalogSource: { kind: 'inline' | 'feed'; url?: string; lastHealthyAtIso: string | null };
  publicRegions: RegionRef[];
  /** §10.4 — whether an indicative price may be published at all. */
  publishIndicativePrice: boolean;
  /** §14.3 — who may ask for a quote. */
  quoteAccess: 'anyone' | 'known_only' | 'nobody';
  /** Per capability: does an answer need a human, or may policy answer? */
  responsePolicy: Record<string, 'auto' | 'review'>;
  customerPricingSource: string | null;
  /** §15.2b — does accepting an order need a human? */
  orderAcceptance: 'auto' | 'review';
  listingState: ListingState;
  /**
   * Connector health and credential STATUS (§18.3). Never the credential.
   *
   * `credentialValid` is a verdict somebody else reached; storing the secret
   * that produced it would put it in the most-read object on the node.
   */
  connectors: {
    /** Also the broker RESOURCE name, which is how status is matched to it. */
    name: string;
    healthy: boolean;
    credentialValid: boolean;
    lastCheckedAtIso: string | null;
    /**
     * Where this connector's operations go, when it is networked (§6.5, WS-9.1).
     *
     * A URL, not a credential — the URL is what the release DECLARED and what
     * §6.5 makes an owner re-consent to when it widens. The material it
     * authenticates with lives only in the credential broker.
     */
    endpoint?: ConnectorEndpointSetting;
  }[];
}

/** §6.5 — a declared destination for one connector operation. */
export interface ConnectorEndpointSetting {
  /** The brokered operation this destination serves, e.g. `read_catalog`. */
  operation: string;
  /** HTTPS only, enforced below and again by the fetch policy. */
  url: string;
  auth: 'bearer' | 'header' | 'none';
  /** Required when `auth` is `header`. */
  headerName?: string;
  /** True for JSON, false for CSV. Decides the parser AND the accepted types. */
  json: boolean;
  /**
   * §24 — an RPC body, for an ERP that does not answer a GET.
   *
   * Owner CONFIGURATION, fixed when the connector is set up. A brokered call
   * chooses whether to ask, never what to ask; a caller-supplied body would
   * make this an arbitrary RPC channel into a supplier's system of record with
   * the owner's credential attached.
   */
  requestBody?: string;
  /** Required with `requestBody`, e.g. `application/json`. */
  requestContentType?: string;
  /**
   * §24 — the response field the catalog rows live under, when the answer is
   * wrapped (Odoo's JSON-RPC answers `{jsonrpc, id, result: [...]}`).
   *
   * A single field NAME. Not a path: a dotted expression is a small query
   * language, and a query language over a supplier's response is a second way
   * to decide what a catalog is. Absent means the endpoint answers the rows
   * directly, which is every REST collection.
   */
  rowsAt?: string;
  /**
   * §24 — target catalog column → this backend's field name.
   *
   * A rename only. The importer is strict about column names, so an ERP's own
   * vocabulary has to be translated before it gets there.
   */
  fieldMap?: Record<string, string>;
  /**
   * §24 — the price field, its currency, and the currency's decimal places.
   *
   * ERPs answer a major-unit decimal; the catalog carries integer minor units
   * (§9.1). The currency is configuration because a bare number has not said
   * which currency it means.
   */
  price?: { field: string; currency: string; decimals: number };
}

export type SettingsRefusal =
  | 'fanout_above_protocol_maximum'
  | 'fanout_below_one'
  | 'supplier_both_preferred_and_blocked'
  | 'unknown_response_policy'
  | 'unknown_listing_state'
  | 'unknown_quote_access'
  | 'unknown_order_acceptance'
  | 'credential_material_present'
  | 'endpoint_url_refused'
  | 'endpoint_auth_incomplete'
  /** A request body with no content type, or a content type with no body. */
  | 'endpoint_request_incomplete'
  | 'empty_identity';

export interface SettingsFinding {
  refusal: SettingsRefusal;
  field: string;
  detail: string;
}

export type SettingsVerdict = { ok: true } | { ok: false; findings: SettingsFinding[] };

/** Keys that would mean a secret reached a settings record. */
const CREDENTIAL_SHAPED = /^(api[_-]?key|secret|token|password|passphrase|private[_-]?key)$/i;

export function validateBuyerSettings(settings: BuyerSettings): SettingsVerdict {
  const findings: SettingsFinding[] = [];

  if (settings.actingIdentityDid === '') {
    findings.push({
      refusal: 'empty_identity',
      field: 'actingIdentityDid',
      detail: 'a buyer acts as somebody; an empty identity names nobody',
    });
  }
  if (settings.quoteFanoutCeiling > MAX_QUOTE_FANOUT) {
    // REFUSED here, CLAMPED in `planQuoteFanout`, and the two are not in
    // conflict — they answer different questions. The planner is handed a
    // policy by whatever calls it and clamps defensively, because refusing at
    // dispatch time would turn a bad config into a failed purchase. This runs
    // where the OWNER TYPES the number, and an owner who typed 50 and silently
    // got 8 believes something about their node that is not true — they would
    // only find out when a supplier they expected to hear from never answered.
    findings.push({
      refusal: 'fanout_above_protocol_maximum',
      field: 'quoteFanoutCeiling',
      detail: `the protocol maximum is ${String(MAX_QUOTE_FANOUT)}`,
    });
  }
  if (settings.quoteFanoutCeiling < 1) {
    findings.push({
      refusal: 'fanout_below_one',
      field: 'quoteFanoutCeiling',
      detail: 'a ceiling below one asks nobody, which is a pause rather than a setting',
    });
  }

  const blocked = new Set(settings.blockedSuppliers);
  for (const did of settings.preferredSuppliers) {
    if (blocked.has(did)) {
      // Not resolved by precedence. Either answer would be a guess about what
      // the owner meant, and the guess that prefers a blocked supplier is the
      // one that sends them business they said they did not want.
      findings.push({
        refusal: 'supplier_both_preferred_and_blocked',
        field: 'preferredSuppliers',
        detail: `${did} is also blocked`,
      });
    }
  }

  return findings.length === 0 ? { ok: true } : { ok: false, findings };
}

export function validateSupplierSettings(settings: SupplierSettings): SettingsVerdict {
  const findings: SettingsFinding[] = [];

  if (settings.actingBusinessDid === '') {
    findings.push({
      refusal: 'empty_identity',
      field: 'actingBusinessDid',
      detail: 'a supplier signs as somebody; an empty identity names nobody',
    });
  }
  for (const [capability, policy] of Object.entries(settings.responsePolicy)) {
    if (policy !== 'auto' && policy !== 'review') {
      // Fail closed on an unknown policy rather than defaulting to `auto`: an
      // unrecognised value means this build does not know what the owner
      // asked for, and answering automatically is the expensive reading.
      findings.push({
        refusal: 'unknown_response_policy',
        field: `responsePolicy.${capability}`,
        detail: `expected auto | review, found ${String(policy)}`,
      });
    }
  }

  // THE SAME RULE, APPLIED TO THE THREE FIELDS THAT ACTUALLY GATE SELLING.
  // It was written above for `responsePolicy` and for nothing else, and the
  // three fields left out are the ones that decide whether this business
  // answers at all. Every reader compares against the exact permissive
  // spelling and falls through to permissive on anything else, so the failure
  // was OPEN: `quoteAdmissibility` returns `{admits:true}` for a
  // `listingState` of "Paused", and the order path auto-accepts for an
  // `orderAcceptance` of "Review". An owner who closed their shop would have
  // kept selling, and nothing anywhere would have said so.
  //
  // Refused on WRITE, so the bad value never reaches storage, and the reader's
  // own validation turns a row that predates this check into
  // `{ok:false, absent:false}` — which the order path already treats as
  // "cannot read your policy, do not accept automatically".
  if (settings.listingState !== 'live' && settings.listingState !== 'paused' && settings.listingState !== 'withdrawn') {
    findings.push({
      refusal: 'unknown_listing_state',
      field: 'listingState',
      detail: `expected live | paused | withdrawn, found ${String(settings.listingState)}`,
    });
  }
  if (
    settings.quoteAccess !== 'anyone' &&
    settings.quoteAccess !== 'known_only' &&
    settings.quoteAccess !== 'nobody'
  ) {
    findings.push({
      refusal: 'unknown_quote_access',
      field: 'quoteAccess',
      detail: `expected anyone | known_only | nobody, found ${String(settings.quoteAccess)}`,
    });
  }
  if (settings.orderAcceptance !== 'auto' && settings.orderAcceptance !== 'review') {
    findings.push({
      refusal: 'unknown_order_acceptance',
      field: 'orderAcceptance',
      detail: `expected auto | review, found ${String(settings.orderAcceptance)}`,
    });
  }
  for (const connector of settings.connectors) {
    for (const key of Object.keys(connector)) {
      if (CREDENTIAL_SHAPED.test(key)) {
        findings.push({
          refusal: 'credential_material_present',
          field: `connectors.${connector.name}.${key}`,
          detail: 'settings record health and validity, never the credential itself',
        });
      }
    }
    const endpoint = connector.endpoint;
    if (endpoint === undefined) continue;
    // The SAME url check the fetch policy runs, applied where the owner types
    // it. The policy would refuse an `http://` endpoint at request time, which
    // is a connector that looks configured and never works; refusing it here
    // is the difference between a settings error and a silent outage.
    const urlRefusal = checkCatalogFeedUrl(endpoint.url);
    if (urlRefusal !== null) {
      findings.push({
        refusal: 'endpoint_url_refused',
        field: `connectors.${connector.name}.endpoint.url`,
        detail: urlRefusal,
      });
    }
    if (endpoint.auth === 'header' && (endpoint.headerName ?? '') === '') {
      // Not defaulted to `Authorization`. A guess here decides where a
      // credential is sent, and the endpoint that ignores an unexpected header
      // fails by refusing the caller rather than by saying so.
      findings.push({
        refusal: 'endpoint_auth_incomplete',
        field: `connectors.${connector.name}.endpoint.headerName`,
        detail: 'header authentication needs the header name',
      });
    }
    // BOTH OR NEITHER. A body with no content type is a request most servers
    // reject or, worse, misparse; a content type with no body is a
    // half-configured RPC endpoint that will silently GET. Refusing the pair
    // is the only reading that cannot send a request the owner did not mean.
    const hasBody = (endpoint.requestBody ?? '') !== '';
    const hasType = (endpoint.requestContentType ?? '') !== '';
    if (hasBody !== hasType) {
      findings.push({
        refusal: 'endpoint_request_incomplete',
        field: `connectors.${connector.name}.endpoint.requestBody`,
        detail: 'an RPC endpoint needs BOTH a request body and its content type (§24)',
      });
    }
    // A FIELD NAME, checked as one. A dotted or bracketed value is someone
    // reaching for a path expression; accepting it would quietly grow a query
    // language, and rejecting it here is cheaper than deciding later which
    // subset of one to support.
    const rowsAt = endpoint.rowsAt ?? '';
    if (rowsAt !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rowsAt)) {
      findings.push({
        refusal: 'endpoint_request_incomplete',
        field: `connectors.${connector.name}.endpoint.rowsAt`,
        detail: 'rowsAt names ONE response field, not a path (§24)',
      });
    }
    // A price declaration is ALL THREE or none. A field with no currency
    // publishes a number nobody can price against; decimals outside a real
    // currency's range turns a rounding rule into a multiplier.
    if (endpoint.price !== undefined) {
      const p = endpoint.price;
      if (
        p.field === '' ||
        p.currency === '' ||
        !Number.isInteger(p.decimals) ||
        p.decimals < 0 ||
        p.decimals > 6
      ) {
        findings.push({
          refusal: 'endpoint_request_incomplete',
          field: `connectors.${connector.name}.endpoint.price`,
          detail: 'a price declaration needs a field, a currency and 0-6 decimals (§24)',
        });
      }
    }
    if (endpoint.operation === '') {
      findings.push({
        refusal: 'endpoint_auth_incomplete',
        field: `connectors.${connector.name}.endpoint.operation`,
        detail: 'an endpoint serves a named operation',
      });
    }
  }

  return findings.length === 0 ? { ok: true } : { ok: false, findings };
}

/**
 * Is this supplier answering quotes right now, and if not, why?
 *
 * ONE function rather than three call sites reading `listingState` and
 * `quoteAccess` separately. §19's "plugin paused/revoked" row requires a
 * paused listing to stop answering while receipts are preserved, and a caller
 * that checked only one of the two fields would keep answering through a
 * pause — which is the difference between a supplier who is closed and one
 * who is ignoring their customers.
 */
export function quoteAdmissibility(
  settings: SupplierSettings,
  asker: 'known' | 'unknown',
): { admits: true } | { admits: false; reason: string } {
  if (settings.listingState === 'withdrawn') {
    return { admits: false, reason: 'this listing has been withdrawn' };
  }
  if (settings.listingState === 'paused') {
    return { admits: false, reason: 'this listing is paused' };
  }
  if (settings.quoteAccess === 'nobody') {
    return { admits: false, reason: 'this supplier is not quoting' };
  }
  if (settings.quoteAccess === 'known_only' && asker === 'unknown') {
    return { admits: false, reason: 'this supplier quotes existing customers only' };
  }
  return { admits: true };
}

/**
 * The effective fan-out ceiling for a request.
 *
 * The lower of the owner's setting and the protocol maximum. Both bounds
 * exist for different reasons — the owner's is a preference, the protocol's is
 * a limit on what one tap may do to other people's nodes — so neither may
 * override the other.
 */
export function effectiveFanoutCeiling(settings: BuyerSettings): number {
  return Math.min(settings.quoteFanoutCeiling, MAX_QUOTE_FANOUT);
}
