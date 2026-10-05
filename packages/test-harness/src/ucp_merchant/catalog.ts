/**
 * The mock UCP merchant's catalogue (UCP plan §3.19 step 2): products in the
 * published v2026-08-25 shape, and the answers to the three catalogue
 * operations, as a merchant would give them. Pure: the HTTPS server in
 * `server.ts` carries them over REST and MCP.
 *
 * Search matches every word of the query against a product's title and
 * description, case-folded (a real merchant ranks; this one keeps its own
 * order). Lookup answers each product once with one variant, as the spec
 * says; get_product answers it whole. A product it does not have is an
 * application outcome in the UCP envelope (`ucp.status: "error"`,
 * catalog/lookup.md), never a transport error.
 */

export const UCP_VERSION = '2026-08-25';

export interface MockVariantInput {
  id: string;
  title: string;
  /** Minor units. */
  price: number;
  listPrice?: number;
  available?: boolean;
  /** Sold in this unit (`quantity_unit`); each when absent. */
  unit?: { unit: string; scale: number; display_text: string; increment: number };
}

export interface MockProductInput {
  id: string;
  title: string;
  description: string;
  /** Minor units; the first variant's price when not given. */
  price?: number;
  currency?: string;
  url?: string;
  variants?: MockVariantInput[];
}

export type MockProduct = Record<string, unknown> & { id: string; title: string };

/** A product in the published shape: required members, one variant at least. */
export function mockProduct(input: MockProductInput): MockProduct {
  const currency = input.currency ?? 'EUR';
  const variants = input.variants ?? [
    { id: `${input.id}-v1`, title: 'Default', price: input.price ?? 1000 },
  ];
  const prices = variants.map((v) => v.price);
  const money = (amount: number) => ({ amount, currency });
  return {
    id: input.id,
    title: input.title,
    description: { plain: input.description },
    ...(input.url !== undefined ? { url: input.url } : {}),
    price_range: { min: money(Math.min(...prices)), max: money(Math.max(...prices)) },
    variants: variants.map((v) => ({
      id: v.id,
      title: v.title,
      description: { plain: v.title },
      price: money(v.price),
      ...(v.listPrice !== undefined ? { list_price: money(v.listPrice) } : {}),
      ...(v.available !== undefined ? { availability: { available: v.available } } : {}),
      ...(v.unit !== undefined ? { quantity_unit: v.unit } : {}),
    })),
  };
}

const envelope = () => ({
  version: UCP_VERSION,
  capabilities: {
    'dev.ucp.shopping.catalog.search': [{ version: UCP_VERSION }],
    'dev.ucp.shopping.catalog.lookup': [{ version: UCP_VERSION }],
  },
});

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');

/** `search_catalog`: every query word in the title or description. */
export function searchAnswer(products: readonly MockProduct[], payload: Record<string, unknown>) {
  const query = typeof payload.query === 'string' ? words(payload.query) : [];
  const matched = products.filter((p) => {
    const text = `${p.title} ${(p.description as { plain?: string } | undefined)?.plain ?? ''}`;
    const have = new Set(words(text));
    return query.every((w) => have.has(w));
  });
  return { ucp: envelope(), products: matched };
}

/** The product an id names: its own id, or one of its variants' (then that variant). */
function resolve(
  products: readonly MockProduct[],
  id: string,
): { product: MockProduct; variant: Record<string, unknown> | null } | null {
  for (const product of products) {
    if (product.id === id) return { product, variant: null };
    const variant = (product.variants as Record<string, unknown>[]).find((v) => v.id === id);
    if (variant !== undefined) return { product, variant };
  }
  return null;
}

/**
 * `lookup_catalog` (catalog/lookup.md): ids deduplicated; each resolved by
 * product or variant id; each product returned once, with one variant (the
 * one a variant id named, else the featured first one) and the inputs that
 * resolved to it (`exact` for a variant id, `featured` for a product id).
 */
export function lookupAnswer(products: readonly MockProduct[], payload: Record<string, unknown>) {
  const ids = [
    ...new Set(Array.isArray(payload.ids) ? payload.ids.filter((i) => typeof i === 'string') : []),
  ];
  const found = new Map<
    string,
    { product: MockProduct; variant: Record<string, unknown>; inputs: unknown[] }
  >();
  for (const id of ids) {
    const r = resolve(products, id);
    if (r === null) continue;
    const variant = r.variant ?? (r.product.variants as Record<string, unknown>[])[0] ?? {};
    const input = { id, match: r.variant === null ? 'featured' : 'exact' };
    const had = found.get(r.product.id);
    if (had === undefined)
      found.set(r.product.id, { product: r.product, variant, inputs: [input] });
    else had.inputs.push(input);
  }
  return {
    ucp: envelope(),
    products: [...found.values()].map(({ product, variant, inputs }) => ({
      ...product,
      variants: [{ ...variant, inputs }],
    })),
  };
}

/** `get_product`: the whole product (a variant id puts that variant first), or the spec's not-found outcome. */
export function getProductAnswer(
  products: readonly MockProduct[],
  payload: Record<string, unknown>,
) {
  const r = typeof payload.id === 'string' ? resolve(products, payload.id) : null;
  if (r === null) {
    return {
      ucp: { ...envelope(), status: 'error' },
      messages: [
        {
          type: 'error',
          code: 'not_found',
          content: 'No such product.',
          severity: 'unrecoverable',
        },
      ],
    };
  }
  const variants = r.product.variants as Record<string, unknown>[];
  const ordered =
    r.variant === null ? variants : [r.variant, ...variants.filter((v) => v !== r.variant)];
  return { ucp: envelope(), product: { ...r.product, variants: ordered } };
}

export type CatalogOperation = 'search_catalog' | 'lookup_catalog' | 'get_product';

export function catalogAnswer(
  operation: CatalogOperation,
  products: readonly MockProduct[],
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (operation === 'search_catalog') return searchAnswer(products, payload);
  if (operation === 'lookup_catalog') return lookupAnswer(products, payload);
  return getProductAnswer(products, payload);
}
