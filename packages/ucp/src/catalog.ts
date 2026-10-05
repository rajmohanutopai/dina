/**
 * Catalog search, lookup and product detail (catalog_search.json,
 * catalog_lookup.json, types/product.json, types/variant.json).
 *
 * Requests carry the query and the owner-allowed context only; `signals` are
 * never sent (§3.16). A merchant decides how many products it returns
 * (catalog_search.json sets no maximum), so one unreadable product is dropped
 * and counted rather than failing the answer.
 */

import { isPlainObject, type JsonObject } from '@dina/a2a';

import { contextRequestJson, type IntentContext } from './intent';
import { parsePrice, type Price } from './money';
import {
  fail,
  ok,
  optString,
  readDescription,
  readHttpsUrl,
  type Description,
  type Read,
} from './resource';
import { EACH, parseQuantityUnit, type QuantityUnit } from './units';

/** Dina's page size for one merchant (§3.11 guards at most 20 products per answer). */
export const SEARCH_PAGE_LIMIT = 20;

export interface SearchRequestInput {
  query: string;
  context: IntentContext;
  cursor?: string;
}

export function buildSearchRequest(input: SearchRequestInput): JsonObject {
  if (input.query.trim() === '') throw new Error('catalog: empty query');
  const body: JsonObject = {
    query: input.query,
    pagination: {
      limit: SEARCH_PAGE_LIMIT,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    },
  };
  const context = contextRequestJson(input.context);
  if (context !== undefined) body.context = context;
  return body;
}

export function buildLookupRequest(ids: readonly string[], context: IntentContext): JsonObject {
  if (ids.length === 0 || ids.some((id) => id === '')) throw new Error('catalog: bad ids');
  const body: JsonObject = { ids: [...ids] };
  const ctx = contextRequestJson(context);
  if (ctx !== undefined) body.context = ctx;
  return body;
}

export function buildGetProductRequest(id: string, context: IntentContext): JsonObject {
  if (id === '') throw new Error('catalog: empty id');
  const body: JsonObject = { id };
  const ctx = contextRequestJson(context);
  if (ctx !== undefined) body.context = ctx;
  return body;
}

export interface Variant {
  id: string;
  title: string;
  description?: Description;
  price: Price;
  listPrice?: Price;
  unit: QuantityUnit;
  /** `availability.available`; absent when the merchant does not say. */
  available?: boolean;
  url?: string;
  sku?: string;
}

export interface Product {
  id: string;
  title: string;
  description?: Description;
  priceRange: { min: Price; max: Price };
  url?: string;
  variants: Variant[];
}

function readVariant(value: unknown): Read<Variant> {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string')
    return fail('variant');
  const price = parsePrice(value.price);
  if (price === null) return fail('variant_price');
  let unit = EACH;
  if (value.quantity_unit !== undefined) {
    const u = parseQuantityUnit(value.quantity_unit);
    if (u === null) return fail('variant_unit');
    unit = u;
  }
  const listPrice = value.list_price !== undefined ? parsePrice(value.list_price) : undefined;
  if (listPrice === null) return fail('variant_list_price');
  const description = readDescription(value.description);
  const url = readHttpsUrl(value.url);
  const sku = optString(value.sku);
  const available =
    isPlainObject(value.availability) && typeof value.availability.available === 'boolean'
      ? value.availability.available
      : undefined;
  return ok({
    id: value.id,
    title: value.title,
    price,
    unit,
    ...(description !== undefined ? { description } : {}),
    ...(listPrice !== undefined ? { listPrice } : {}),
    ...(available !== undefined ? { available } : {}),
    ...(url !== null ? { url } : {}),
    ...(sku !== undefined ? { sku } : {}),
  });
}

export function readProduct(value: unknown): Read<Product> {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string')
    return fail('product');
  const range = value.price_range;
  const min = isPlainObject(range) ? parsePrice(range.min) : null;
  const max = isPlainObject(range) ? parsePrice(range.max) : null;
  if (min === null || max === null || min.currency !== max.currency || min.amount > max.amount)
    return fail('price_range');
  if (!Array.isArray(value.variants) || value.variants.length === 0) return fail('variants');
  const variants: Variant[] = [];
  for (const raw of value.variants) {
    const r = readVariant(raw);
    if (!r.ok) return r;
    variants.push(r.value);
  }
  const description = readDescription(value.description);
  const url = readHttpsUrl(value.url);
  return ok({
    id: value.id,
    title: value.title,
    priceRange: { min, max },
    variants,
    ...(description !== undefined ? { description } : {}),
    ...(url !== null ? { url } : {}),
  });
}

export interface ProductList {
  products: Product[];
  /** Products dropped as unreadable. */
  unreadable: number;
  nextCursor?: string;
}

/** A search or lookup answer's `products` (and search `pagination`). */
export function readProductList(value: unknown): Read<ProductList> {
  if (!isPlainObject(value) || !Array.isArray(value.products)) return fail('products');
  const products: Product[] = [];
  let unreadable = 0;
  for (const raw of value.products) {
    const r = readProduct(raw);
    if (r.ok) products.push(r.value);
    else unreadable++;
  }
  const p = value.pagination;
  const nextCursor =
    isPlainObject(p) && p.has_next_page === true && typeof p.cursor === 'string'
      ? p.cursor
      : undefined;
  return ok({ products, unreadable, ...(nextCursor !== undefined ? { nextCursor } : {}) });
}

/** A get_product answer's `product`. */
export function readProductDetail(value: unknown): Read<Product> {
  if (!isPlainObject(value)) return fail('not_object');
  return readProduct(value.product);
}
