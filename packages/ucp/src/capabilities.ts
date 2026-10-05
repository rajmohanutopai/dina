/**
 * The capabilities and services Dina declares as a buyer (UCP plan §3.5): the
 * names, `spec` and `schema` URLs exactly as the v2026-08-25 spec writes them
 * in its own profiles (overview/index.md:1452-1530; each schema's `name`).
 *
 * Dina declares no payment handler and no payment extension (S6), no AP2,
 * no `buyer_consent` (S12), and leaves fulfillment's `supports_multi_group`
 * false by not setting it. Identity linking is declared from U4.
 */

import { UCP_BASE, UCP_VERSION } from './version';

export const CAP = {
  catalogSearch: 'dev.ucp.shopping.catalog.search',
  catalogLookup: 'dev.ucp.shopping.catalog.lookup',
  cart: 'dev.ucp.shopping.cart',
  checkout: 'dev.ucp.shopping.checkout',
  fulfillment: 'dev.ucp.shopping.fulfillment',
  discount: 'dev.ucp.shopping.discount',
  order: 'dev.ucp.shopping.order',
  permalink: 'dev.ucp.shopping.permalink',
  identityLinking: 'dev.ucp.common.identity_linking',
} as const;

export type CapabilityName = (typeof CAP)[keyof typeof CAP];

export const SHOPPING_SERVICE = 'dev.ucp.shopping';

export interface CapabilityDeclaration {
  name: CapabilityName;
  spec: string;
  schema: string;
  extends?: CapabilityName;
}

export const DINA_CAPABILITIES: readonly CapabilityDeclaration[] = [
  {
    name: CAP.catalogSearch,
    spec: `${UCP_BASE}/specification/shopping/catalog/search`,
    schema: `${UCP_BASE}/schemas/shopping/catalog_search.json`,
  },
  {
    name: CAP.catalogLookup,
    spec: `${UCP_BASE}/specification/shopping/catalog/lookup`,
    schema: `${UCP_BASE}/schemas/shopping/catalog_lookup.json`,
  },
  {
    name: CAP.cart,
    spec: `${UCP_BASE}/specification/shopping/cart`,
    schema: `${UCP_BASE}/schemas/shopping/cart.json`,
  },
  {
    name: CAP.checkout,
    spec: `${UCP_BASE}/specification/shopping/checkout`,
    schema: `${UCP_BASE}/schemas/shopping/checkout.json`,
  },
  {
    name: CAP.fulfillment,
    spec: `${UCP_BASE}/specification/shopping/extensions/fulfillment`,
    schema: `${UCP_BASE}/schemas/shopping/fulfillment.json`,
    extends: CAP.checkout,
  },
  {
    name: CAP.discount,
    spec: `${UCP_BASE}/specification/shopping/extensions/discount`,
    schema: `${UCP_BASE}/schemas/shopping/discount.json`,
    extends: CAP.checkout,
  },
  {
    name: CAP.order,
    spec: `${UCP_BASE}/specification/shopping/order`,
    schema: `${UCP_BASE}/schemas/shopping/order.json`,
  },
  {
    name: CAP.permalink,
    spec: `${UCP_BASE}/specification/permalink`,
    schema: `${UCP_BASE}/schemas/shopping/permalink.json`,
  },
];

export const IDENTITY_LINKING_DECLARATION: CapabilityDeclaration = {
  name: CAP.identityLinking,
  spec: `${UCP_BASE}/specification/common/identity-linking/`,
  schema: `${UCP_BASE}/schemas/common/identity_linking.json`,
};

export const DINA_SERVICES = [
  { transport: 'mcp', schema: `${UCP_BASE}/services/shopping/mcp.openrpc.json` },
  { transport: 'rest', schema: `${UCP_BASE}/services/shopping/rest.openapi.json` },
] as const;

export const SPEC_OVERVIEW = `${UCP_BASE}/specification/overview/`;

export { UCP_VERSION };
