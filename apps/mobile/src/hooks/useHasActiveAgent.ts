/**
 * `useHasActiveAgent` — true when at least one paired device with
 * role `'agent'` is currently active (not revoked).
 *
 * Two screens gate UI on this:
 *   - `app/_layout.tsx`: the bottom-bar Approvals tab. Without an
 *     active agent the only inbound approvals are inbound D2D service
 *     queries — already covered by the `runningAsProvider` gate. With
 *     an active agent, intent-validation approvals (`dina validate`
 *     from a paired OpenClaw / dina-cli-agent) can land at any time
 *     and need their own surface.
 *   - `app/index.tsx`: the chat `/task` action. `delegate_to_agent`
 *     dispatches a delegation workflow task that some paired agent
 *     must claim via `POST /v1/workflow/tasks/claim`. Without an
 *     active agent the task times out after 60 s — a dead-end UX.
 *     Hide the action so the user discovers the requirement up-front
 *     instead of through a stalled task.
 *
 * Subscribed to the in-process device registry so re-renders fire
 * the moment a pair completes or a revoke lands. No polling.
 */

import { useEffect, useState } from 'react';

import {
  listActiveDevices,
  subscribeToDeviceRegistry,
  type PairedDevice,
} from '@dina/core/devices';

function snapshot(): boolean {
  try {
    return listActiveDevices().some(isDelegationAgent);
  } catch {
    // Registry not hydrated yet (cold boot before storage init).
    // `false` is the safe default — the chat `/task` chip stays
    // hidden until the registry comes online.
    return false;
  }
}

function isDelegationAgent(d: PairedDevice): boolean {
  // Only the `agent` role claims delegation tasks (see
  // `app/paired-devices.tsx` ROLE_OPTIONS hint). `cli` is a control
  // surface, `rich`/`thin` are companion devices — none of those run
  // an OpenClaw-style task claimer.
  return d.role === 'agent';
}

export function useHasActiveAgent(): boolean {
  const [present, setPresent] = useState<boolean>(snapshot);
  useEffect(() => {
    // Re-read after mount in case the registry hydrated between the
    // first render's `useState` initializer firing and the effect
    // attaching its subscription.
    setPresent(snapshot());
    const unsub = subscribeToDeviceRegistry(() => setPresent(snapshot()));
    return unsub;
  }, []);
  return present;
}
