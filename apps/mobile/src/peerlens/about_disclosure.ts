/**
 * Settings → "About PeerLens" disclosure content (TN-MOB-028).
 *
 * Plan §8.8:
 *
 *   > Dismissed once → flag in keystore. Settings → "About PeerLens"
 *   > repeats the same text.
 *
 * Plus plan §1 row 11 + §13.10 — the V1-pseudonymity caveat lives in
 * BOTH the first-run modal (one-shot, dismissible) AND the Settings
 * about screen (always available, persistent home for the
 * disclosure).
 *
 * This module owns the **content bundle** for the always-available
 * surface. The body paragraphs are sourced from
 * `FIRST_RUN_MODAL_COPY.body` so the disclosure copy lives in ONE
 * place — a copy review on the first-run modal automatically
 * propagates to the settings screen, and a regression test pins the
 * body identity-equality so a future mutation can't accidentally
 * fork the two surfaces.
 *
 * What's settings-screen-specific (vs. first-run modal):
 *   - `screenTitle` — "About PeerLens" (the screen header)
 *   - `headerLabel` — "How PeerLens works" (the section heading
 *     above the body)
 *   - `versionLabel` — pinned to "PeerLens V1" so users
 *     recognising the screen know which lifecycle stage they're in
 *   - No dismiss CTA (the settings surface is always-available, not
 *     a one-shot modal)
 *
 * Pure data. No state, no I/O. The screen layer renders the bundle
 * directly into a `<ScrollView>`.
 */

import { FEATURE_NAMES } from '@dina/core';

import { FIRST_RUN_MODAL_COPY } from './first_run';

// ─── Public types ─────────────────────────────────────────────────────────

export interface AboutScreenContent {
  /** Screen header — appears in the navigation bar. */
  readonly screenTitle: string;
  /** Section heading rendered above the disclosure body paragraphs. */
  readonly headerLabel: string;
  /**
   * Disclosure body paragraphs. Sourced from
   * `FIRST_RUN_MODAL_COPY.body` — same array reference, identity-
   * preserved for the test gate that prevents the two surfaces from
   * forking.
   */
  readonly body: readonly string[];
  /** Version label — "PeerLens V1" — anchors the disclosure to a release. */
  readonly versionLabel: string;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * The exact content bundle the Settings → "About PeerLens"
 * screen renders. Frozen at every level so any mutation crashes
 * loudly instead of silently editing the source of truth.
 */
export const ABOUT_SCREEN_CONTENT: AboutScreenContent = Object.freeze({
  screenTitle: `About ${FEATURE_NAMES.peerlens}`,
  headerLabel: `How ${FEATURE_NAMES.peerlens} works`,
  body: FIRST_RUN_MODAL_COPY.body,
  versionLabel: `${FEATURE_NAMES.peerlens} V1`,
});
