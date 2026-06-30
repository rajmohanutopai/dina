/**
 * useServiceDecisions — reads the OWNER-PRIVATE contact-service decision log
 * (CONTACT_SERVICES_ARCHITECTURE.md §2/§10) for the Activity tab's quiet
 * "Requests" view.
 *
 * The mobile app runs Core in-process, so for this owner-private LOCAL log we
 * read the repository directly (no transport hop) — it never crosses a trust
 * boundary: it is the owner's own device reading the owner's own log, and the
 * data is never sent to a requester. The HTTP route
 * (`GET /v1/contacts/service-decisions`) exists for out-of-process / thin
 * clients; this hook is the in-process reader.
 *
 * It is a LOG, not a push: nothing here badges, alerts, or marks "unread". The
 * row only appears when the owner opens the Requests filter.
 */

import { useCallback, useEffect, useState } from 'react';

import { getContact } from '@dina/core';
import { getServiceDecisionRepository, type ServiceDecision } from '@dina/core/storage';

export interface DecisionRow extends ServiceDecision {
  /** Resolved contact display name, or a shortened DID when unknown. */
  requesterName: string;
}

function shortDid(did: string): string {
  if (did.length <= 20) return did;
  return `${did.slice(0, 14)}…${did.slice(-4)}`;
}

function resolveName(did: string): string {
  try {
    const name = getContact(did)?.displayName ?? '';
    return name !== '' ? name : shortDid(did);
  } catch {
    return shortDid(did);
  }
}

export function useServiceDecisions(): {
  decisions: DecisionRow[];
  reload: () => void;
} {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);

  const reload = useCallback((): void => {
    const repo = getServiceDecisionRepository();
    const rows = repo?.list(100) ?? [];
    setDecisions(rows.map((d) => ({ ...d, requesterName: resolveName(d.requesterDid) })));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { decisions, reload };
}
