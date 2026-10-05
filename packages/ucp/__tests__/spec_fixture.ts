/**
 * The harvested spec fixture (scripts/harvest_spec_examples.mjs), typed, with
 * one classification shared by every test that reads it.
 */
import fixture from './fixtures/spec_examples.json';

export interface SpecExample {
  source: string;
  /** Set when the example was unwrapped from an MCP JSON-RPC answer. */
  binding?: 'mcp';
  /** The spec's `<!-- ucp:example … -->` marker for the block, when it has one. */
  annotation?: Record<string, string>;
  value: Record<string, unknown> & { ucp: Record<string, unknown> };
}

export const SPEC = fixture.spec;
export const SPEC_EXAMPLES = fixture.examples as SpecExample[];

export type ExampleKind =
  | 'fragment'
  | 'illustrative'
  | 'error_response'
  | 'product_list'
  | 'product_detail'
  | 'order'
  | 'checkout'
  | 'cart'
  | 'profile'
  | 'other';

/** What a fixture is, by the spec's own marker first and its shape second. */
export function classify({ annotation, value: v }: SpecExample): ExampleKind {
  // `extract=$.ucp.<part>` marks a profile fragment: only that part is meant.
  if (annotation?.extract?.startsWith('$.ucp.')) return 'fragment';
  if (annotation?.reason !== undefined) return 'illustrative';
  if (v.ucp.status === 'error') return 'error_response';
  if ('products' in v) return 'product_list';
  if ('product' in v) return 'product_detail';
  if ('checkout_id' in v && 'line_items' in v) return 'order';
  if ('line_items' in v && 'status' in v) return 'checkout';
  if ('line_items' in v) return 'cart';
  if ('services' in v.ucp) return 'profile';
  return 'other';
}
