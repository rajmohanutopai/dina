/**
 * Generic multi-tenant hosting for Home Nodes (§17).
 *
 * Verticals CONSTRAIN this package and none define it — the commerce spec says
 * so in its own first line for §17, and the same holds for anything else built
 * on the runtime. Nothing here imports a vertical, and nothing here knows what
 * a quote or an order is.
 */

export * from './tenant';
export * from './control_plane';
export * from './hosted_runner';
export * from './managed_store';
