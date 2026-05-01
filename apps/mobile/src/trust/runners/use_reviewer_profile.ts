/**
 * Reviewer profile runner — wraps `com.dina.trust.getProfile` for the
 * reviewer screen. Returns either `{ profile }` to render the loaded
 * card, or `{ error }` to render the friendly error panel. Tests pass
 * `enabled: false` to keep the screen presentational.
 */

import { useEffect, useState } from 'react';
import { getProfile, type TrustProfile as WireProfile } from '../appview_runtime';
import type { TrustProfile } from '@dina/core';

export interface ReviewerProfileState {
  profile: TrustProfile | null;
  error: string | null;
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
    isLoading: false,
  });

  useEffect(() => {
    if (!enabled) return;
    if (!did || !did.startsWith('did:')) return;
    let cancelled = false;
    setState({ profile: null, error: null, isLoading: true });
    getProfile(did)
      .then((wire: WireProfile | null) => {
        if (cancelled) return;
        // AppView's `getProfile` returns literal `null` (200 OK with
        // body `null`) for unknown DIDs — they don't have a row in
        // `did_profiles` yet. The runner must surface this as a
        // friendly "no profile yet" error, not crash the screen with
        // a `Cannot read property 'lastActive' of null` runtime error.
        if (wire === null || wire === undefined) {
          setState({
            profile: null,
            error:
              "We don't have a trust profile for this person yet. Once they make or receive attestations, their profile will fill in.",
            isLoading: false,
          });
          return;
        }
        // Wire shape matches `TrustProfile` from `@dina/core` byte-for-
        // byte except `lastActive` is an ISO string here vs ms timestamp
        // in the upstream client. Normalise to ms so the screen helpers
        // (`relativeTime`) treat the values uniformly.
        const profile: TrustProfile = {
          ...wire,
          lastActive:
            typeof wire.lastActive === 'string' && wire.lastActive.length > 0
              ? Date.parse(wire.lastActive)
              : null,
        } as unknown as TrustProfile;
        setState({ profile, error: null, isLoading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : "Couldn't load this reviewer. Try again in a moment.";
        setState({ profile: null, error: msg, isLoading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [did, enabled, retryNonce]);

  return state;
}
