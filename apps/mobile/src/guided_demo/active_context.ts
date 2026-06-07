/**
 * Context broadcasting whether a guided demo is currently active (its bottom
 * dock is on screen). The Chat screen reads this to reserve extra bottom space
 * in its message list so the last message clears the dock — which, as an
 * absolute overlay covering the composer + tab bar, is taller than the composer
 * the list normally sits above. Provided by `GuidedDemoGate`.
 */

import { createContext, useContext } from 'react';

export const GuidedDemoActiveContext = createContext<boolean>(false);

/** True while the guided-demo dock is on screen. */
export function useGuidedDemoActive(): boolean {
  return useContext(GuidedDemoActiveContext);
}

/** Extra bottom padding the Chat list reserves while the dock is up, so the
 *  last message isn't hidden behind it (generous — clears up to a 6-line
 *  caption; the PeerLens / service-network / D2D steps need the room). */
export const GUIDED_DEMO_LIST_CLEARANCE = 250;
