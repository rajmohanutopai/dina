/**
 * Reviewer profile runner — wraps `com.dinakernel.peerlens.getProfile` for the
 * reviewer screen. Returns either `{ profile }` to render the loaded
 * card, or `{ error }` to render the friendly error panel. Tests pass
 * `enabled: false` to keep the screen presentational.
 */

import { useEffect, useState } from 'react';
import { getProfile, type PeerlensProfile as WireProfile } from '../appview_runtime';
import { FEATURE_NAMES } from '@dina/core';
import type { PeerlensProfile } from '@dina/core';

export interface ReviewerProfileState {
  profile: PeerlensProfile | null;
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
              `We don't have a ${FEATURE_NAMES.peerlens} profile for this person yet. Once they make or receive attestations, their profile will fill in.`,
            isLoading: false,
          });
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
