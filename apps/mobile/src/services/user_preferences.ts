/**
 * Viewer profile preferences (TN-V2-CTX-001 / V2 actionability layer).
 *
 * The Trust Network's V1 ranking is "what do my contacts think of X".
 * V2 adds a *viewer lens*: even within trusted reviews, push results
 * that match the viewer's region, languages, budget, accessibility
 * needs, and dietary constraints to the top — and demote ones that
 * obviously don't apply (the canonical "Uganda pen" case in the V2
 * backlog header).
 *
 * **Loyalty Law — critical.** This profile is LOCAL-ONLY. It is
 * never written to AppView, never embedded in any AT Protocol
 * record, never sent to any server. The mobile client applies the
 * viewer lens after fetching un-personalised results from AppView,
 * so AppView (and any operator running an AppView mirror) cannot
 * fingerprint the viewer by their preferences. This is the same
 * sovereignty principle as `display_name_override.ts` — a local
 * customisation that doesn't broadcast.
 *
 * Storage: react-native-keychain under `service: 'dina.user_preferences'`.
 * Encrypted at rest by the OS keychain (Keychain Services on iOS,
 * Keystore on Android). The shape of the stored blob is a JSON
 * serialisation of `UserPreferences` — not a typed cell-per-key
 * scheme — because the whole profile is read+written together by
 * the settings UI and a single round-trip is simpler than 6.
 *
 * Schema evolution — forward-compatible:
 *   - **Adding a new field**: declare it on `UserPreferences`, add a
 *     default to `defaultPreferences()`, add a parse step in
 *     `parsePreferences()`. Old keystore rows missing the field
 *     read back with the default (no migration).
 *   - **Removing a field**: drop it from the type + parser. Old
 *     rows with the field are tolerated — the parser ignores
 *     unknown keys.
 *   - **Changing a field's value type**: the parser's per-field
 *     guards reject malformed values and fall back to default,
 *     so a type-narrowing change is also migration-free (the
 *     wrong-shaped old value is treated as absent).
 *
 * The "discriminated-union shape" the V2 backlog asks for is achieved
 * via the per-field validators below: each field is independently
 * narrow-typed, so adding a new field with its own narrow type
 * doesn't perturb the others. This is the pragmatic equivalent of
 * a tagged-union in a structurally-typed language.
 */

import * as Keychain from 'react-native-keychain';

const SERVICE = 'dina.user_preferences';
const USERNAME = 'dina_user_preferences';

// ─── Public types ─────────────────────────────────────────────────────────

/** Per-category budget tier. `$` = entry-level; `$$$` = premium. */
export type BudgetTier = '$' | '$$' | '$$$';

/** Compatibility profile for product subjects (filters on `compat_tags`). */
export type DeviceCompat =
  | 'ios'
  | 'android'
  | 'macos'
  | 'windows'
  | 'linux'
  | 'ipad'
  | 'web';

/** Dietary constraint. Optional — empty = no filter. */
export type DietaryTag =
  | 'vegan'
  | 'vegetarian'
  | 'halal'
  | 'kosher'
  | 'gluten-free'
  | 'dairy-free'
  | 'nut-free';

/** Accessibility requirement. Optional — empty = no filter. */
export type AccessibilityTag =
  | 'wheelchair'
  | 'captions'
  | 'screen-reader'
  | 'color-blind-safe';

/**
 * Full viewer profile. All fields are present (no optional `?`) so
 * call sites don't need null-narrowing on every read; "absent"
 * preferences are encoded as `null` (region) or `[]` / `{}` (the
 * collection-shaped fields).
 */
export interface UserPreferences {
  /**
   * ISO 3166-1 alpha-2 (e.g., `'US'`, `'IN'`, `'UG'`). Two uppercase
   * ASCII letters. `null` = no region preference (don't filter on
   * region). Defaults to the device locale's region on first read.
   */
  readonly region: string | null;
  /**
   * Per-category budget tiers. Categories use the same slash-delimited
   * path as `subjects.category` (`'office_furniture/chair'`). Categories
   * the user hasn't set impose no filter on results in that category.
   * Empty record = no budget filtering anywhere.
   */
  readonly budget: Readonly<Record<string, BudgetTier>>;
  /** Multi-select compatibility profile. Empty = no filter. */
  readonly devices: readonly DeviceCompat[];
  /**
   * BCP-47 language tags (e.g., `'en-US'`, `'pt-BR'`). Used to filter
   * + boost search results based on `subjects.language`. Empty = no
   * language filter. Defaults to `[device-locale]` on first read.
   */
  readonly languages: readonly string[];
  /** Multi-select dietary preferences. Empty = no filter. */
  readonly dietary: readonly DietaryTag[];
  /** Multi-select accessibility requirements. Empty = no filter. */
  readonly accessibility: readonly AccessibilityTag[];
}

// ─── Allowed-value sets — the runtime guards parse against ─────────────────

const DEVICE_VALUES: ReadonlySet<DeviceCompat> = new Set<DeviceCompat>([
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
  'ipad',
  'web',
]);

const DIETARY_VALUES: ReadonlySet<DietaryTag> = new Set<DietaryTag>([
  'vegan',
  'vegetarian',
  'halal',
  'kosher',
  'gluten-free',
  'dairy-free',
  'nut-free',
]);

const ACCESSIBILITY_VALUES: ReadonlySet<AccessibilityTag> = new Set<AccessibilityTag>([
  'wheelchair',
  'captions',
  'screen-reader',
  'color-blind-safe',
]);

const BUDGET_VALUES: ReadonlySet<BudgetTier> = new Set<BudgetTier>(['$', '$$', '$$$']);

// ─── In-memory snapshot + subscriber list (TN-V2-CTX-008) ─────────────────
//
// CTX-008 asks for a `useViewerPreferences()` hook exposing
// `{ profile, isHydrated }` to every screen. The hook is a
// `useSyncExternalStore` wrapper around this snapshot — same pattern
// as `display_name_override.ts`. Module-level state (not a Provider /
// Context) because viewer preferences are a singleton: there's exactly
// one viewer per app instance, and a Context would force every consumer
// to live under a wrapping component.
//
// The snapshot is `null` until `hydrateUserPreferences()` resolves the
// keystore read; the hook reports `isHydrated: false` until then so
// downstream screens can hide loading-suspect UI for the first
// keystore-read moment.

let snapshot: UserPreferences | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

// ─── Write serialisation (TN-V2-CTX-005/006 race fix) ──────────────────────
//
// Multi-select settings screens (devices, dietary, etc.) toggle one
// option at a time. A user tapping "iOS" then "Android" rapidly fires
// two updates within milliseconds. Without serialisation:
//
//   t=0   tap iOS    → handler reads snapshot S, writes S+iOS (in flight)
//   t=5ms tap Android → handler reads snapshot S (still!), writes S+Android (in flight)
//   t=10ms iOS write completes  → snapshot = S+iOS, notify
//   t=15ms Android write completes → snapshot = S+Android, notify
//   final state: ONLY Android. iOS lost.
//
// Fix: a single Promise-chain queue. Each mutation enters the queue
// behind the previous one; when its turn comes, it reads the LATEST
// snapshot, applies its updater, writes the keystore, updates the
// snapshot, notifies. By the time the second mutation runs, snapshot
// already includes the first mutation's effect.
//
// This is the same pattern as React's `setState((current) => next)`
// functional update form — and for the same reason (the captured
// `current` would be stale).

let writeQueue: Promise<unknown> = Promise.resolve();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — a buggy subscriber must not break the emit loop */
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Load the viewer profile from the keychain. On a fresh install (no
 * keychain row), returns `defaultPreferences()` — meaning device-locale
 * regions + languages, everything else empty. On a corrupted /
 * malformed row, also falls back to defaults: never throws on read,
 * because preferences aren't worth crashing the app over.
 *
 * Pure read — does not touch the in-memory snapshot. For the hot-path
 * read used by hooks, use `getUserPreferencesSnapshot()`.
 */
export async function loadUserPreferences(): Promise<UserPreferences> {
  const result = await loadUserPreferencesWithStatus();
  return result.profile;
}

/**
 * Same as `loadUserPreferences()` but reports whether the keychain
 * row existed before the read. Used by `hydrateUserPreferences()` to
 * detect first-launch and trigger inference. The two are split so
 * the public single-return surface stays simple — every caller other
 * than hydrate uses `loadUserPreferences()`.
 */
export async function loadUserPreferencesWithStatus(): Promise<{
  /** Resolved preferences (defaults if no row / corrupted). */
  readonly profile: UserPreferences;
  /**
   * `true` when no keychain row existed (first launch on this device,
   * or after a `clearUserPreferences()`). False when a row was
   * present, regardless of whether it parsed cleanly.
   */
  readonly isFirstLaunch: boolean;
}> {
  let row: false | { username: string; password: string };
  try {
    row = await Keychain.getGenericPassword({ service: SERVICE });
  } catch {
    // Keychain unavailable (rare — e.g., in a degraded simulator).
    // Behaviour is the same as "row not found": defaults. Treat as
    // first-launch so inference runs and seeds the snapshot in
    // memory; the next save attempt will fail (keychain still
    // unavailable) but the user gets a sensible profile in the
    // meantime.
    return { profile: defaultPreferences(), isFirstLaunch: true };
  }
  if (!row) return { profile: defaultPreferences(), isFirstLaunch: true };
  try {
    const parsed: unknown = JSON.parse(row.password);
    return { profile: parsePreferences(parsed), isFirstLaunch: false };
  } catch {
    // Stored blob isn't valid JSON. Treat as corrupted → defaults.
    // Don't try to repair: a write of new prefs from the settings
    // screen will overwrite the corrupted row. Not first-launch —
    // we don't want to overwrite a corrupted row with inferred
    // values (the user might have legitimate state in there that a
    // later parser version recovers).
    return { profile: defaultPreferences(), isFirstLaunch: false };
  }
}

/**
 * Save the viewer profile to the keychain. Validates each field
 * before writing — invalid values are coerced to defaults, so a
 * caller passing junk doesn't poison the stored row.
 *
 * Updates the in-memory snapshot + notifies subscribers so any mounted
 * `useViewerPreferences()` consumer re-renders with the new values.
 *
 * Serialised through the same queue as `mutateUserPreferences()` so
 * a `save(...)` followed by `mutate(...)` (or vice versa) writes in
 * call order — no last-writer-wins races.
 */
export async function saveUserPreferences(prefs: UserPreferences): Promise<void> {
  await mutateUserPreferences(() => prefs);
}

/**
 * Apply a functional update to the viewer profile. The `updater`
 * receives the LATEST snapshot at the moment of execution (not at
 * call time) so concurrent mutations compose correctly:
 *
 *   await Promise.all([
 *     mutate(p => ({ ...p, devices: [...p.devices, 'ios'] })),
 *     mutate(p => ({ ...p, devices: [...p.devices, 'android'] })),
 *   ]);
 *   // → final devices contains BOTH 'ios' and 'android'.
 *
 * The serialisation guarantee is per-process: two devices on the
 * same identity could still race if they both wrote to the keystore
 * concurrently, but that's outside this module's scope (and the
 * keystore is per-device anyway).
 */
export async function mutateUserPreferences(
  updater: (current: UserPreferences) => UserPreferences,
): Promise<void> {
  // Capture-by-reference: chain the new task onto whatever's queued.
  // The `.then(...)` returns a fresh Promise that we install as the
  // new tail; subsequent calls chain onto THIS one in order.
  const task = writeQueue.then(async () => {
    // Read the LATEST snapshot inside the task — this is the "functional
    // update" property. If a previous task in the queue mutated the
    // snapshot, this updater sees that change.
    const current = snapshot ?? defaultPreferences();
    const next = parsePreferences(updater(current));
    await Keychain.setGenericPassword(USERNAME, JSON.stringify(next), {
      service: SERVICE,
    });
    snapshot = next;
    hydrated = true;
    notify();
  });
  // Install the new tail. We swallow the rejection on the queue chain
  // so a single failed write doesn't poison every subsequent task —
  // each caller still gets the rejection on their own returned promise
  // via the `task` reference below.
  writeQueue = task.catch(() => {
    /* keep queue alive after a failed task */
  });
  return task;
}

/**
 * Wipe the stored preferences entirely. Used by the "wipe local
 * data" path + by tests. After this, `loadUserPreferences()` returns
 * `defaultPreferences()` again. Snapshot resets to null + un-hydrated
 * so the next subscriber re-runs hydration through the locale path.
 */
export async function clearUserPreferences(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
  snapshot = null;
  hydrated = false;
  notify();
}

/**
 * Hydrate the in-memory snapshot from the keystore. Idempotent — safe
 * to call from boot AND from any UI that mounts before boot finishes
 * (the second call short-circuits). Notifies subscribers exactly once
 * on the transition to hydrated.
 *
 * The hydrate path catches errors and falls back to defaults rather
 * than leaving the app un-hydrated forever — preferences are not
 * load-bearing.
 */
export async function hydrateUserPreferences(opts?: {
  /**
   * Inference hook — invoked on first launch (no stored row in the
   * keychain) to seed the profile from vault + device context.
   * Returns the values it inferred; the hydrate path merges those
   * over `defaultPreferences()` and persists.
   *
   * Optional: callers that don't want inference (tests, headless
   * tooling, the install path before the vault is open) can omit
   * it. When omitted, behaviour is the legacy "device-locale
   * defaults only" path.
   *
   * Async because real callers will read the vault on a worker
   * thread; the hydrate path awaits the result before notifying
   * subscribers so the first render sees inferred values.
   *
   * Errors from the inferer are swallowed: a vault read that fails
   * is not worth blocking app boot. We fall back to plain defaults
   * in that case.
   */
  readonly infer?: () => Promise<Partial<UserPreferences>> | Partial<UserPreferences>;
}): Promise<void> {
  if (hydrated) return;
  let loaded: { profile: UserPreferences; isFirstLaunch: boolean };
  try {
    loaded = await loadUserPreferencesWithStatus();
  } catch {
    loaded = { profile: defaultPreferences(), isFirstLaunch: true };
  }
  let next = loaded.profile;
  // First launch + caller supplied an inferer → merge inferred fields
  // over the device-locale defaults and persist. The inferer returns
  // `Partial<UserPreferences>` and we only overwrite fields it
  // declared, so a caller that can't determine (say) `dietary` leaves
  // the default empty array intact.
  if (loaded.isFirstLaunch && opts?.infer !== undefined) {
    let inferred: Partial<UserPreferences> = {};
    try {
      inferred = await opts.infer();
    } catch {
      inferred = {};
    }
    next = { ...next, ...inferred };
    // Persist immediately so the next launch reads the same values
    // and inference doesn't re-run. Failures here are non-fatal —
    // the in-memory snapshot is correct for this session, and the
    // next user-driven save will retry the keychain write.
    try {
      await mutateUserPreferences(() => next);
      // mutateUserPreferences sets hydrated=true and updates snapshot,
      // so we can return now.
      return;
    } catch {
      // Fall through to the manual snapshot set below.
    }
  }
  // Re-check the hydrated flag — a concurrent `saveUserPreferences()`
  // during the keystore read would have already set it. In that case
  // the snapshot from save() is more recent than the one we just read,
  // so we keep the save() value.
  if (hydrated) return;
  snapshot = next;
  hydrated = true;
  notify();
}

/**
 * Synchronous read of the current snapshot. Returns `null` when the
 * snapshot hasn't been hydrated yet — the hook layer maps this to
 * `{ profile: defaultPreferences(), isHydrated: false }` so consumers
 * always see a usable shape.
 *
 * Stable identity contract: this function returns the exact same
 * object reference across calls until a write occurs. `useSyncExternalStore`
 * relies on referential stability to detect "no change" — returning a
 * fresh object every call would force every subscriber to re-render
 * on every render of any other component (since React calls the
 * snapshot function on every render).
 */
export function getUserPreferencesSnapshot(): UserPreferences | null {
  return snapshot;
}

/** True once `hydrateUserPreferences()` has resolved the first read. */
export function isUserPreferencesHydrated(): boolean {
  return hydrated;
}

/**
 * Subscribe to snapshot changes. Returns an unsubscribe function
 * suitable for the `useSyncExternalStore` contract.
 */
export function subscribeUserPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Compute defaults from the device locale. Exported so the settings
 * screen can offer a "reset to defaults" action that mirrors the
 * first-read behaviour.
 *
 * - `region`: ISO 3166-1 alpha-2 from the locale's region subtag,
 *   or `null` if the device locale has no region (e.g., bare `'en'`).
 * - `languages`: `[bcp47]` where bcp47 is the device locale itself
 *   (e.g., `'en-US'`). Single-element array — the user can add more
 *   from the settings screen.
 * - All other fields default to empty / null.
 */
export function defaultPreferences(): UserPreferences {
  const locale = detectDeviceLocale();
  return {
    region: locale.region,
    budget: {},
    devices: [],
    languages: locale.bcp47 === null ? [] : [locale.bcp47],
    dietary: [],
    accessibility: [],
  };
}

// ─── Internal: parsing + validation ───────────────────────────────────────

/**
 * Parse a possibly-untrusted shape into a strict `UserPreferences`.
 * Per-field validation: invalid / missing fields fall back to the
 * device-locale default for that field. Unknown fields in the input
 * are ignored on this pass (and therefore lost on the next write —
 * by design; we're not running a generic schema migration tool).
 *
 * Note on the "missing → default" semantic: when the user explicitly
 * chose `languages: []`, the saved row has `languages: []` (empty
 * array, present), and on read we round-trip that to `[]`. Only a
 * field that's *absent from the row entirely* (e.g., a future-version
 * field this build doesn't know about, or a field added in this build
 * but written by an older build) gets the default treatment.
 */
function parsePreferences(raw: unknown): UserPreferences {
  // Arrays are typeof 'object' in JS, so guard separately. A stored
  // top-level array is malformed (the row should always be a record);
  // fall back to defaults rather than treating array indices as
  // record keys.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return defaultPreferences();
  }
  const r = raw as Record<string, unknown>;
  const def = defaultPreferences();

  return {
    region: 'region' in r ? parseRegion(r.region) : def.region,
    budget: 'budget' in r ? parseBudget(r.budget) : def.budget,
    devices:
      'devices' in r
        ? parseStringArray<DeviceCompat>(r.devices, DEVICE_VALUES)
        : def.devices,
    languages: 'languages' in r ? parseLanguages(r.languages) : def.languages,
    dietary:
      'dietary' in r
        ? parseStringArray<DietaryTag>(r.dietary, DIETARY_VALUES)
        : def.dietary,
    accessibility:
      'accessibility' in r
        ? parseStringArray<AccessibilityTag>(r.accessibility, ACCESSIBILITY_VALUES)
        : def.accessibility,
  };
}

/**
 * ISO 3166-1 alpha-2: exactly two uppercase ASCII letters. Anything
 * else (lowercase, three letters, numeric) coerces to `null`. We
 * don't try to validate against the full ISO list — codes evolve
 * (e.g., `'XK'` for Kosovo is unofficial-but-widely-used) and any
 * hard-coded list would drift.
 */
function parseRegion(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') return null;
  return /^[A-Z]{2}$/.test(raw) ? raw : null;
}

function parseBudget(raw: unknown): Readonly<Record<string, BudgetTier>> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, BudgetTier> = {};
  for (const [category, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof category !== 'string' || category.length === 0) continue;
    if (typeof tier !== 'string') continue;
    if (BUDGET_VALUES.has(tier as BudgetTier)) {
      out[category] = tier as BudgetTier;
    }
  }
  return out;
}

/**
 * Generic enum-array parser: keep only entries that are strings AND
 * appear in the allowed-value set. De-duplicates because the settings
 * UI shouldn't be able to write `['ios', 'ios']`.
 */
function parseStringArray<T extends string>(
  raw: unknown,
  allowed: ReadonlySet<T>,
): readonly T[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    if (!allowed.has(v as T)) continue;
    if (seen.has(v as T)) continue;
    seen.add(v as T);
    out.push(v as T);
  }
  return out;
}

/**
 * BCP-47 tags don't have a finite enum, so we validate shape:
 * `lang(-region)?(-script)?(-variant)?(-extensions)?`. Lowercase the
 * language subtag, uppercase the region subtag (BCP-47 convention).
 * De-duplicates.
 */
function parseLanguages(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const normalised = canonicaliseLanguageTag(v);
    if (normalised === null) continue;
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  return out;
}

/**
 * Validate + canonicalise a BCP-47 tag. Loose check — accept anything
 * that looks like `lang(-subtag)*` with subtags in [A-Za-z0-9]+. Lower
 * the language subtag, upper the 2-letter region subtag, leave others
 * as-given. Returns `null` if the input doesn't match the shape.
 */
function canonicaliseLanguageTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(trimmed)) return null;
  const parts = trimmed.split('-');
  // Language subtag: 2-3 lowercase letters (ISO-639-1/2/3) or 4-8
  // for reserved/private use. Just lowercase whatever's there.
  parts[0] = parts[0].toLowerCase();
  // Region subtag (if present): 2-letter ISO-3166 → upper, or 3-digit
  // UN M.49 → leave numeric as-is. Region is conventionally the
  // SECOND subtag when present and is exactly 2 letters or 3 digits.
  if (parts.length >= 2 && /^[A-Za-z]{2}$/.test(parts[1])) {
    parts[1] = parts[1].toUpperCase();
  }
  return parts.join('-');
}

/**
 * Detect device locale via `Intl.DateTimeFormat().resolvedOptions().locale`.
 * Available on Hermes (RN's JS engine) for iOS 14+ / Android 7+.
 * Returns both the canonical BCP-47 tag and the parsed region (ISO
 * alpha-2 if present, else null). Wrapped in try/catch for the
 * truly-degraded environments that don't expose Intl.
 */
function detectDeviceLocale(): { bcp47: string | null; region: string | null } {
  try {
    const localeStr = new Intl.DateTimeFormat().resolvedOptions().locale;
    const canonical = canonicaliseLanguageTag(localeStr);
    if (canonical === null) return { bcp47: null, region: null };
    const parts = canonical.split('-');
    const region = parts.length >= 2 && /^[A-Z]{2}$/.test(parts[1]) ? parts[1] : null;
    return { bcp47: canonical, region };
  } catch {
    return { bcp47: null, region: null };
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────

/**
 * Reset state for tests — wipes the keystore row AND clears the
 * in-memory snapshot + un-hydrates + drops all subscribers. Tests that
 * mount the hook in different orderings need a clean slate; without
 * the listener clear, a mock subscription from a previous test fires
 * during the next test and re-renders into a torn-down component
 * tree.
 */
export async function resetUserPreferencesForTest(): Promise<void> {
  // Drain any in-flight queued writes BEFORE wiping. Otherwise a
  // pending task from the previous test could resolve mid-reset and
  // re-populate the snapshot.
  try {
    await writeQueue;
  } catch {
    /* a previously-failed task is fine — we're tearing down */
  }
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch {
    // Keychain may be uninstalled in unit tests — best-effort wipe.
  }
  snapshot = null;
  hydrated = false;
  writeQueue = Promise.resolve();
  listeners.clear();
}
