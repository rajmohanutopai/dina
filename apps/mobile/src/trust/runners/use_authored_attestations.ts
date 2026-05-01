/**
 * Authored-attestations runner — fetches the list of reviews a given
 * DID has written via `com.dina.trust.search` (with `authorDid`
 * filter). Powers the "Reviews written" section on the reviewer
 * profile screen. Tests pass `enabled: false` to keep the screen
 * presentational.
 *
 * The same shape works for "my reviews" (when the DID is the booted
 * node's own) and for "their reviews" (any other reviewer) — the
 * runner doesn't care, the screen passes the DID it's already
 * resolved.
 */

import { useEffect, useState } from 'react';

import {
  searchAttestationsByAuthor,
  type SearchAttestationHit,
} from '../appview_runtime';
import {
  deriveAuthoredAttestationRows,
  type AuthoredAttestationRow,
} from '../authored_attestations_data';

export interface AuthoredAttestationsState {
  rows: readonly AuthoredAttestationRow[];
  isLoading: boolean;
  error: string | null;
}

export interface UseAuthoredAttestationsOptions {
  authorDid: string;
  enabled: boolean;
  /** Cap. Defaults to 25 — the AppView search xRPC's default page. */
  limit?: number;
  retryNonce?: number;
}

const EMPTY: readonly AuthoredAttestationRow[] = [];

export function useAuthoredAttestations(
  opts: UseAuthoredAttestationsOptions,
): AuthoredAttestationsState {
  const { authorDid, enabled, limit = 25, retryNonce = 0 } = opts;
  const [state, setState] = useState<AuthoredAttestationsState>({
    rows: EMPTY,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled) return;
    if (!authorDid || !authorDid.startsWith('did:')) return;
    let cancelled = false;
    setState({ rows: EMPTY, isLoading: true, error: null });
    searchAttestationsByAuthor(authorDid, limit)
      .then((response) => {
        if (cancelled) return;
        const hits: SearchAttestationHit[] = response.results;
        const rows = deriveAuthoredAttestationRows(hits);
        setState({ rows, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : "Couldn't load reviews. Try again in a moment.";
        setState({ rows: EMPTY, isLoading: false, error: msg });
      });
    return () => {
      cancelled = true;
    };
  }, [authorDid, enabled, limit, retryNonce]);

  return state;
}
