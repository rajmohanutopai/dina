/**
 * Fire-and-forget Starter Credits claim — mounted once at the root
 * layout, gated on unlocked (spec: the grant is an enhancement AFTER
 * onboarding, never a gate).
 *
 * All sequencing lives in the credits state machine (`runClaimFlow`):
 * claimed/terminal states short-circuit before any network; transient
 * failures retry next launch; attestation-unavailable (sim/dev — see
 * src/ai/attestation.ts) parks as 'unavailable'. This hook stays a
 * one-liner on purpose.
 *
 * `onClaimed` closes the "Start free" race (review P1): when the key
 * lands AFTER boot already gave up on finding a provider, we activate
 * openrouter-on-grant in the RUNNING session — same trio the
 * providers screen uses — but only when the user hasn't configured
 * anything else meanwhile (their choice always wins).
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';

import { saveActiveProvider, loadActiveProvider } from '../ai/active_provider';
import { swapAgenticActiveProvider } from '../ai/agentic_swap';
import { getDeviceCheckToken, getPlayIntegrityToken } from '../ai/attestation';
import { wireBrainChatProvider } from '../ai/brain_wiring';
import { runClaimFlow } from '../ai/credits';
import { getApiKey } from '../ai/provider';

async function activateGrantIfUnconfigured(): Promise<void> {
  const active = await loadActiveProvider();
  if (active !== null) return; // user picked something — never override
  const byok = await getApiKey('openrouter');
  if (byok !== null) return; // BYOK wins by precedence anyway
  await saveActiveProvider('openrouter');
  await wireBrainChatProvider('openrouter');
  await swapAgenticActiveProvider('openrouter');
}

export function useCreditsClaim(unlocked: boolean): void {
  useEffect(() => {
    if (!unlocked) return;
    void runClaimFlow(Platform.OS === 'android' ? 'android' : 'ios', {
      getDeviceCheckToken,
      getPlayIntegrityToken,
      onClaimed: activateGrantIfUnconfigured,
    });
  }, [unlocked]);
}
