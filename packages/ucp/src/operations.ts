/**
 * The UCP operations Dina performs, one table for both bindings
 * (rest.openapi.json and mcp.openrpc.json at v2026-08-25).
 *
 * `complete_checkout` is absent by construction: Dina never completes a
 * checkout and never touches payment (UCP plan S6). There is no code path that
 * could send it.
 */

import type { RequestOperation } from './schema_variant';

export type OperationName =
  | 'search_catalog'
  | 'lookup_catalog'
  | 'get_product'
  | 'create_cart'
  | 'get_cart'
  | 'update_cart'
  | 'cancel_cart'
  | 'create_checkout'
  | 'get_checkout'
  | 'update_checkout'
  | 'cancel_checkout'
  | 'get_order';

export interface OperationSpec {
  /** REST method and path template (`{id}` is the resource id). */
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  /** REST success status. */
  successStatus: 200 | 201;
  /** MCP argument that carries the payload, if any. */
  payloadArg?: 'catalog' | 'cart' | 'checkout';
  /** Whether the operation names a resource id. */
  takesId: boolean;
  /** Changes state: carries an Idempotency-Key (REST header and MCP meta). */
  mutating: boolean;
  /** The capability whose schema governs it. */
  capability: string;
  /**
   * Where its payload and its answer are typed, in that capability's schema
   * document: a JSON pointer (`''` is the whole document) and, for a request
   * typed by the resource schema itself, the operation whose `ucp_request`
   * annotations apply. No `request`: the operation sends no payload.
   */
  schemas: { request?: SchemaPart; response: SchemaPart };
}

export interface SchemaPart {
  pointer: string;
  variant?: RequestOperation;
}

export const OPERATIONS: Readonly<Record<OperationName, OperationSpec>> = {
  search_catalog: {
    method: 'POST',
    path: '/catalog/search',
    successStatus: 200,
    payloadArg: 'catalog',
    takesId: false,
    mutating: false,
    capability: 'dev.ucp.shopping.catalog.search',
    schemas: {
      request: { pointer: '/$defs/search_request' },
      response: { pointer: '/$defs/search_response' },
    },
  },
  lookup_catalog: {
    method: 'POST',
    path: '/catalog/lookup',
    successStatus: 200,
    payloadArg: 'catalog',
    takesId: false,
    mutating: false,
    capability: 'dev.ucp.shopping.catalog.lookup',
    schemas: {
      request: { pointer: '/$defs/lookup_request' },
      response: { pointer: '/$defs/lookup_response' },
    },
  },
  get_product: {
    method: 'POST',
    path: '/catalog/product',
    successStatus: 200,
    payloadArg: 'catalog',
    takesId: false,
    mutating: false,
    capability: 'dev.ucp.shopping.catalog.lookup',
    schemas: {
      request: { pointer: '/$defs/get_product_request' },
      response: { pointer: '/$defs/get_product_response' },
    },
  },
  create_cart: {
    method: 'POST',
    path: '/carts',
    successStatus: 201,
    payloadArg: 'cart',
    takesId: false,
    mutating: true,
    capability: 'dev.ucp.shopping.cart',
    schemas: { request: { pointer: '', variant: 'create' }, response: { pointer: '' } },
  },
  get_cart: {
    method: 'GET',
    path: '/carts/{id}',
    successStatus: 200,
    takesId: true,
    mutating: false,
    capability: 'dev.ucp.shopping.cart',
    schemas: { response: { pointer: '' } },
  },
  update_cart: {
    method: 'PUT',
    path: '/carts/{id}',
    successStatus: 200,
    payloadArg: 'cart',
    takesId: true,
    mutating: true,
    capability: 'dev.ucp.shopping.cart',
    schemas: { request: { pointer: '', variant: 'update' }, response: { pointer: '' } },
  },
  cancel_cart: {
    method: 'POST',
    path: '/carts/{id}/cancel',
    successStatus: 200,
    takesId: true,
    mutating: true,
    capability: 'dev.ucp.shopping.cart',
    schemas: { response: { pointer: '' } },
  },
  create_checkout: {
    method: 'POST',
    path: '/checkout-sessions',
    successStatus: 201,
    payloadArg: 'checkout',
    takesId: false,
    mutating: true,
    capability: 'dev.ucp.shopping.checkout',
    schemas: { request: { pointer: '', variant: 'create' }, response: { pointer: '' } },
  },
  get_checkout: {
    method: 'GET',
    path: '/checkout-sessions/{id}',
    successStatus: 200,
    takesId: true,
    mutating: false,
    capability: 'dev.ucp.shopping.checkout',
    schemas: { response: { pointer: '' } },
  },
  update_checkout: {
    method: 'PUT',
    path: '/checkout-sessions/{id}',
    successStatus: 200,
    payloadArg: 'checkout',
    takesId: true,
    mutating: true,
    capability: 'dev.ucp.shopping.checkout',
    schemas: { request: { pointer: '', variant: 'update' }, response: { pointer: '' } },
  },
  cancel_checkout: {
    method: 'POST',
    path: '/checkout-sessions/{id}/cancel',
    successStatus: 200,
    takesId: true,
    mutating: true,
    capability: 'dev.ucp.shopping.checkout',
    schemas: { response: { pointer: '' } },
  },
  get_order: {
    method: 'GET',
    path: '/orders/{id}',
    successStatus: 200,
    takesId: true,
    mutating: false,
    capability: 'dev.ucp.shopping.order',
    schemas: { response: { pointer: '' } },
  },
};

export function isOperationName(value: string): value is OperationName {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, value);
}
