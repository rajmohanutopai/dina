/**
 * Hot-swap the active cloud provider on the agentic /ask path.
 *
 * Background: `tryBuildAgenticAsk` captures the LLM at boot time and
 * threads it through `LLMRouter` + `RoutedLLMProvider` + the
 * AskCoordinator. The user's BYOK choice in Settings, however, can
 * change at any time. Without this seam, a Settings swap only
 * rewires the single-shot `reason()` path (via `wireBrainChatProvider`)
 * and the agentic loop keeps calling the boot-time provider —
 * confusing because Settings shows the new one as ACTIVE.
 *
 * `registerAgenticRouter` is called once at boot with the live
 * router. `swapAgenticActiveProvider` is then called from Settings
 * whenever the active provider changes; it rebuilds the cloud LLM
 * with the new key and atomically replaces the router's single cloud
 * entry. The AskCoordinator + tool registry stay intact.
 *
 * If no router has been registered (e.g. boot is still in flight or
 * the node was never bootstrapped with an LLM), the swap is a no-op
 * — boot will pick the new provider naturally when it runs.
 */

import type { LLMRouter, ProviderName } from '@dina/brain/llm';

import { createLLMProvider } from './provider';

import type { ProviderType } from './provider';

let activeRouter: LLMRouter | null = null;

export function registerAgenticRouter(router: LLMRouter): void {
  activeRouter = router;
}

export function resetAgenticRouter(): void {
  activeRouter = null;
}

/**
 * Replace the agentic /ask path's cloud provider with the given one.
 * Returns true when the swap was applied, false when no router is
 * registered or no key is stored for the chosen provider.
 */
export async function swapAgenticActiveProvider(
  provider: ProviderType,
): Promise<boolean> {
  if (activeRouter === null) return false;
  const llm = await createLLMProvider(provider);
  if (llm === null) return false;
  activeRouter.replaceCloudProvider(provider as ProviderName, llm);
  return true;
}
