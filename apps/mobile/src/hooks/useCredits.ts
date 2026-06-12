/**
 * Starter Credits UI driver — one hook feeding the chat cards and the
 * providers tile (docs/CREDITS_DESIGN.md §UI).
 *
 * Two-phase like useAutoLock/useRelayWake: a pure `computeCreditsView`
 * (Node-testable) + the thin React hook that loads state lazily.
 *
 * "Credits is the active source" is approximated as: a grant key exists
 * AND no BYOK OpenRouter key is stored. (The provider layer enforces
 * the same precedence — resolveProviderKey — so the approximation
 * cannot diverge from what the loop actually uses for openrouter; a
 * user pointed at gemini/claude BYOK simply never sees the wall card
 * because their sends don't consume credits.)
 */

import { useCallback, useEffect, useState } from 'react';

import { loadActiveProvider } from '../ai/active_provider';
import {
  LOW_BALANCE_THRESHOLD,
  dismissLowBalanceCard,
  getGrantKey,
  loadCreditsState,
  refreshBalance,
} from '../ai/credits';
import { getApiKey } from '../ai/provider';

export interface CreditsView {
  /** Render the wall card (terminal, no dismiss). */
  showWall: boolean;
  /** Render the low-balance card (once, dismissible forever). */
  showLowBalance: boolean;
  /** "≈ N conversations" for the tile + low-balance card. */
  estConversationsLeft: number | null;
  /** A grant exists and is the live OpenRouter source. */
  grantActive: boolean;
}

export interface CreditsViewInputs {
  hasGrantKey: boolean;
  hasByokOpenRouterKey: boolean;
  /** Persisted active provider ('openrouter' | other | null). */
  activeProvider: string | null;
  exhausted: boolean;
  lowBalanceDismissed: boolean;
  estConversationsLeft: number | null;
}

/** Pure view computation — exported for tests. */
export function computeCreditsView(i: CreditsViewInputs): CreditsView {
  // Grant-backed only while openrouter is (or would be, on a fresh
  // install) the live provider. A user who switches to ANY other BYOK
  // provider must not see a stuck wall card (review P2 escape path).
  const grantRoutable = i.activeProvider === null || i.activeProvider === 'openrouter';
  const grantActive = i.hasGrantKey && !i.hasByokOpenRouterKey && grantRoutable;
  const showWall = grantActive && i.exhausted;
  const showLowBalance =
    grantActive &&
    !i.exhausted &&
    !i.lowBalanceDismissed &&
    i.estConversationsLeft !== null &&
    i.estConversationsLeft <= LOW_BALANCE_THRESHOLD;
  return {
    grantActive,
    showWall,
    showLowBalance,
    estConversationsLeft: i.estConversationsLeft,
  };
}

const EMPTY: CreditsView = {
  showWall: false,
  showLowBalance: false,
  estConversationsLeft: null,
  grantActive: false,
};

/**
 * Live credits view. `refreshKey` re-evaluates (e.g. bump it after a
 * send completes so exhaustion shows immediately at the wall moment).
 */
export function useCredits(refreshKey = 0): CreditsView & { dismissLowBalance: () => void } {
  const [view, setView] = useState<CreditsView>(EMPTY);

  const evaluate = useCallback(async (): Promise<void> => {
    const grantKey = await getGrantKey();
    if (grantKey === null) {
      setView(EMPTY);
      return;
    }
    const [byok, state, balance, active] = await Promise.all([
      getApiKey('openrouter'),
      loadCreditsState(),
      refreshBalance(),
      loadActiveProvider(),
    ]);
    setView(
      computeCreditsView({
        hasGrantKey: true,
        hasByokOpenRouterKey: byok !== null,
        activeProvider: active,
        exhausted: state.exhausted || (balance?.exhausted ?? false),
        lowBalanceDismissed: state.lowBalanceDismissed,
        estConversationsLeft: balance?.estConversationsLeft ?? null,
      }),
    );
  }, []);

  useEffect(() => {
    void evaluate();
  }, [evaluate, refreshKey]);

  const dismissLowBalance = useCallback((): void => {
    void dismissLowBalanceCard().then(() => evaluate());
  }, [evaluate]);

  return { ...view, dismissLowBalance };
}
