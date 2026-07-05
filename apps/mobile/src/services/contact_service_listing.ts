/**
 * Contact Services — the service-settings screen's listing-field decisions for
 * the surface/default-offerable axes (Contact Services §5.3), extracted pure so
 * the suite pins them (the screen itself is not render-tested in this repo).
 *
 * Two invariants the screen must uphold so it can only ever PRODUCE a config
 * that passes `validateServiceListing` (which now enforces `talk_must_be_known_only`):
 *   1. A `talk` listing is `known_only` by construction — the screen forces the
 *      discoverability lock when Talk is selected, and this helper hard-pins it
 *      again at build time as a belt-and-braces guard.
 *   2. `defaultOfferable` is only meaningful for a `talk` listing — it is
 *      cleared for a `services` listing so a stale toggle can't ride along.
 */

import type { Discoverability, ServiceSurface } from '@dina/protocol';

export interface ContactServiceListingFields {
  surface: ServiceSurface;
  discoverability: Discoverability;
  defaultOfferable: boolean;
}

/**
 * Resolve the surface/discoverability/default-offerable trio the screen writes
 * onto a saved `ServiceConfig`, given the raw UI state. A Talk service is
 * pinned to `known_only`; `defaultOfferable` is dropped unless Talk.
 */
export function buildContactServiceListingFields(
  surface: ServiceSurface,
  discoverability: Discoverability,
  defaultOfferable: boolean,
): ContactServiceListingFields {
  if (surface === 'talk') {
    return { surface: 'talk', discoverability: 'known_only', defaultOfferable };
  }
  return { surface: 'services', discoverability, defaultOfferable: false };
}
