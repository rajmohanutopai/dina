/**
 * Boot-time glue between the keychain-backed viewer preferences and
 * the inference engine. Reads vault items + device context, runs
 * `inferPreferences()`, calls `hydrateUserPreferences({infer})` so
 * the inferred values land on the FIRST keychain row Dina ever
 * writes for this user — and never again.
 *
 * Why a separate module: `user_preferences.ts` is platform-agnostic
 * (no React, no vault); `preferences_inferer.ts` is pure (no I/O).
 * The wiring belongs here. The boot path imports just this file;
 * the inferer + storage modules stay independently testable.
 *
 * Idempotent: runs the keychain read inside `hydrateUserPreferences`
 * which short-circuits when already hydrated. Safe to call multiple
 * times during the unlock-then-reboot cycle.
 */

import { Platform } from 'react-native';

import { listVaultItemsUI } from '../hooks/useVaultItems';
import {
  inferPreferences,
  type InferenceContext,
  type VaultEvidence,
} from './preferences_inferer';
import {
  hydrateUserPreferences,
  type UserPreferences,
} from './user_preferences';

/**
 * Run inference + hydrate. Designed for the root layout's unlock
 * effect. Vault reads happen lazily inside the closure passed to
 * `hydrateUserPreferences` — so if the keychain row already exists,
 * we never touch the vault at all (the closure isn't invoked).
 *
 * `personaName` defaults to `'general'` because that's where
 * everyday memories land. A future revision could fan out across
 * multiple open personas, but General is the cheapest read for
 * dietary / language / region signals.
 *
 * `vaultItemLimit` caps the read at 200 by default — that's enough
 * to catch any explicit dietary assertion the user has made (these
 * tend to be old-and-stable, not buried under thousands of newer
 * memories) without scanning the entire vault on every cold start.
 */
export async function bootstrapInferredPreferences(opts?: {
  readonly personaName?: string;
  readonly vaultItemLimit?: number;
  /** Override the locale resolver (tests). */
  readonly resolveLocale?: () => { bcp47: string | null; region: string | null };
  /** Override the vault read (tests). */
  readonly readVault?: () => ReadonlyArray<VaultEvidence>;
}): Promise<void> {
  const personaName = opts?.personaName ?? 'general';
  const limit = opts?.vaultItemLimit ?? 200;
  await hydrateUserPreferences({
    infer: () => runInference(personaName, limit, opts),
  });
}

function runInference(
  personaName: string,
  limit: number,
  opts:
    | {
        readonly resolveLocale?: () => { bcp47: string | null; region: string | null };
        readonly readVault?: () => ReadonlyArray<VaultEvidence>;
      }
    | undefined,
): Partial<UserPreferences> {
  const locale = (opts?.resolveLocale ?? defaultResolveLocale)();
  const vaultItems = opts?.readVault
    ? opts.readVault()
    : safeReadVault(personaName, limit);
  return inferPreferences({
    vaultItems,
    localeRegion: locale.region,
    localeBcp47: locale.bcp47,
    platform: resolvePlatform(),
    isIpad: detectIpad(),
  });
}

function resolvePlatform(): InferenceContext['platform'] {
  // `Platform.OS` is a known small set in React Native: `'ios'`,
  // `'android'`, `'macos'`, `'windows'`, `'web'`. We mirror those
  // exactly. An unknown value (rare; e.g. a custom RN fork) falls
  // through to `undefined` so the inferer omits `devices`.
  switch (Platform.OS) {
    case 'ios':
      return 'ios';
    case 'android':
      return 'android';
    case 'macos':
      return 'macos';
    case 'windows':
      return 'windows';
    case 'web':
      return 'web';
    default:
      return undefined;
  }
}

function safeReadVault(
  personaName: string,
  limit: number,
): ReadonlyArray<VaultEvidence> {
  try {
    const items = listVaultItemsUI(personaName, limit);
    return items.map((it) => ({
      headline: it.headline,
      bodyPreview: it.bodyPreview,
    }));
  } catch {
    // Persona repo not wired (boot ordering issue, locked persona,
    // etc). Inference falls back to locale + platform only —
    // dietary stays empty until the next boot when the vault is
    // open. That's fine: re-running inference on a future boot is
    // cheap, and this path means we never block app boot on a
    // vault read.
    return [];
  }
}

function defaultResolveLocale(): { bcp47: string | null; region: string | null } {
  // Mirrors `detectDeviceLocale()` in user_preferences.ts. We can't
  // import it directly (it's not exported) but the logic is two
  // lines — duplicating is cheaper than adding a new export and
  // changing the user_preferences contract for one consumer. If
  // a third caller needs locale detection, factor it then.
  try {
    const localeStr = new Intl.DateTimeFormat().resolvedOptions().locale;
    const parts = localeStr.split('-');
    const lang = parts[0]?.toLowerCase();
    const region = parts.length >= 2 && /^[A-Z]{2}$/.test(parts[1]) ? parts[1] : null;
    if (!lang) return { bcp47: null, region };
    const bcp47 = region !== null ? `${lang}-${region}` : lang;
    return { bcp47, region };
  } catch {
    return { bcp47: null, region: null };
  }
}

function detectIpad(): boolean {
  // RN's `Platform.isPad` is documented but only present on iOS
  // builds. The cast keeps TS quiet on platforms where the field
  // is undefined; runtime falsy check handles non-iOS correctly.
  if (Platform.OS !== 'ios') return false;
  const platformWithIpad = Platform as { isPad?: boolean };
  return platformWithIpad.isPad === true;
}
