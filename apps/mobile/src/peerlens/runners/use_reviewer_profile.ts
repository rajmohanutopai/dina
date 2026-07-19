/**
 * Reviewer profile runner — wraps `com.dinakernel.peerlens.getProfile` for the
 * reviewer screen. Returns either `{ profile }` to render the loaded
 * card, or `{ error }` to render the friendly error panel. Tests pass
 * `enabled: false` to keep the screen presentational.
 */

import { useEffect, useState } from 'react';

import { getProfile, type PeerlensProfile as WireProfile } from '../appview_runtime';

import type { PeerlensProfile } from '@dina/core';

export interface ReviewerProfileState {
  profile: PeerlensProfile | null;
  error: string | null;
  /**
   * True when the fetch SUCCEEDED but there is simply no profile yet (AppView
   * returned `null` — the DID has no `did_profiles` row because the person
   * hasn't made/received any attestations). This is an EMPTY state, NOT an
   * error: the screen renders a friendly "no reviews yet" panel (with a "Write
   * a review" CTA on the viewer's own profile), never a red error + Retry.
   */
  notFound: boolean;
  isLoading: boolean;
}

export interface UseReviewerProfileOptions {
  did: string;
  enabled: boolean;
  retryNonce?: number;
}

export function useReviewerProfile(
  opts: UseReviewerProfileOptions,
): ReviewerProfileState {
  const { did, enabled, retryNonce = 0 } = opts;
  const [state, setState] = useState<ReviewerProfileState>({
    profile: null,
    error: null,
    notFound: false,
    isLoading: false,
  });

  useEffect(() => {
    if (!enabled) return;
    if (!did || !did.startsWith('did:')) return;
    let cancelled = false;
    setState({ profile: null, error: null, notFound: false, isLoading: true });
    getProfile(did)
      .then((wire: WireProfile | null) => {
        if (cancelled) return;
        // AppView's `getProfile` returns literal `null` (200 OK with
        // body `null`) for unknown DIDs — they don't have a row in
        // `did_profiles` yet. This is the EMPTY state (no attestations
        // yet), NOT a load error: flag `notFound` so the screen renders a
        // friendly empty panel (+ a "Write a review" CTA on the viewer's
        // own profile) instead of a red "Couldn't load" + dead Retry.
        if (wire === null || wire === undefined) {
          setState({ profile: null, error: null, notFound: true, isLoading: false });
          return;
        }
        // Wire shape matches `PeerlensProfile` from `@dina/core` byte-for-
        // byte except `lastActive` is an ISO string here vs ms timestamp
        // in the upstream client. Normalise to ms so the screen helpers
        // (`relativeTime`) treat the values uniformly.
        const profile: PeerlensProfile = {
          ...wire,
          lastActive:
            typeof wire.lastActive === 'string' && wire.lastActive.length > 0
              ? Date.parse(wire.lastActive)
              : null,
        } as unknown as PeerlensProfile;
        setState({ profile, error: null, notFound: false, isLoading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : "Couldn't load this reviewer. Try again in a moment.";
        setState({ profile: null, error: msg, notFound: false, isLoading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [did, enabled, retryNonce]);

  return state;
}
