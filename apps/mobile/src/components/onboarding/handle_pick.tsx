/**
 * HandlePicker — Bluesky-style handle availability flow.
 *
 * Slots between `OwnerName` and `PassphraseSet` in the create path.
 * Pre-fills the prefix from the sanitized owner name; live-checks
 * availability against the PDS via `com.atproto.identity.resolveHandle`;
 * surfaces up to 3 pre-validated alternatives when the preferred handle
 * is taken.
 *
 * Why a separate step (not folded into OwnerName):
 *   - Owner name is a *display* concept (greeting copy, persona owner);
 *     handle is a *public identifier* (DNS subdomain on the community
 *     PDS). They serve different purposes and the user might want
 *     different values — e.g. owner name "Raj Mohan", handle prefix "rm".
 *   - The check is async and needs its own loading + error states. A
 *     dedicated screen keeps the OwnerName step instant.
 *
 * Network behaviour:
 *   - Debounced 350ms after each keystroke before hitting the PDS.
 *   - PDS-unreachable → surfaced as a soft warning, not a hard block.
 *     User can proceed; provision will use whatever they picked, and
 *     PDS createAccount (when we wire it later) will reject true
 *     collisions.
 *   - Suggestions are only shown when the preferred handle came back
 *     `taken`; `unknown` (PDS down) doesn't trigger them — we don't
 *     want to imply the preferred is taken when we couldn't actually
 *     check.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  type AvailabilityResult,
  pickHandle,
  sanitizeHandlePrefix,
  validateHandleFormat,
} from '@dina/core/src/identity/handle_picker';
import { OnboardingShell } from './shell';
import { locateStep, type Step } from '../../onboarding/state';
import { resolveMsgBoxURL } from '../../services/msgbox_wiring';
import { colors, fonts, radius, spacing } from '../../theme';

export interface HandlePickProps {
  /** Sanitised seed from `create_name`. May be empty if the user typed
   *  something unusable — the screen falls back to letting them type a
   *  prefix from scratch. */
  seedPrefix: string;
  /** Pre-existing draft handle (e.g. when user comes back from a later
   *  step). Takes precedence over `seedPrefix` when present. */
  initialHandle?: string;
  onContinue: (handle: string) => void;
  onBack: () => void;
}

// 350ms is short enough to feel responsive but long enough to cut
// down the per-keystroke fetch volume to ~3/sec on average typing.
const DEBOUNCE_MS = 350;

export function HandlePicker(props: HandlePickProps): React.ReactElement {
  const pdsHost = useMemo(resolvePDSHost, []);
  const pdsURL = `https://${pdsHost}`;

  const initialPrefix = useMemo(() => {
    if (props.initialHandle !== undefined) {
      const suffix = `.${pdsHost.toLowerCase()}`;
      const lowered = props.initialHandle.toLowerCase();
      if (lowered.endsWith(suffix)) {
        return lowered.slice(0, lowered.length - suffix.length);
      }
    }
    return sanitizeHandlePrefix(props.seedPrefix);
  }, [props.initialHandle, props.seedPrefix, pdsHost]);

  const [prefix, setPrefix] = useState<string>(initialPrefix);
  const [status, setStatus] = useState<CheckStatus>({ kind: 'idle' });

  // Track the latest in-flight check so a stale response doesn't
  // overwrite a newer one. The ref holds the most recent token; only
  // the matching response writes to state.
  const tokenRef = useRef(0);

  const runCheck = useCallback(
    async (rawPrefix: string) => {
      const trimmed = rawPrefix.trim();
      if (trimmed.length === 0) {
        setStatus({ kind: 'idle' });
        return;
      }

      // Sync format check first — saves a network round-trip when the
      // user has typed something obviously invalid.
      const candidate = `${trimmed}.${pdsHost}`;
      const formatCheck = validateHandleFormat(candidate, pdsHost);
      if (!formatCheck.ok) {
        setStatus({ kind: 'invalid', reason: formatCheck.reason });
        return;
      }

      const myToken = ++tokenRef.current;
      setStatus({ kind: 'checking' });
      try {
        const result = await pickHandle(candidate, { pdsURL, pdsHost }, 3);
        if (myToken !== tokenRef.current) return; // stale
        setStatus({ kind: 'checked', result });
      } catch (err) {
        if (myToken !== tokenRef.current) return;
        const reason = err instanceof Error ? err.message : String(err);
        setStatus({ kind: 'error', reason });
      }
    },
    [pdsHost, pdsURL],
  );

  // Debounce: schedule one check 350ms after the latest keystroke.
  // Cleared on unmount so a pending fetch doesn't fire after we've
  // navigated away.
  useEffect(() => {
    const handle = setTimeout(() => {
      void runCheck(prefix);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [prefix, runCheck]);

  const fullHandle = prefix.trim().length > 0 ? `${prefix.trim()}.${pdsHost}` : '';
  const canContinue = canPick(status, fullHandle);

  const step: Step = { kind: 'create_handle', draft: {} };

  return (
    <OnboardingShell
      location={locateStep(step)}
      title="Pick your handle"
      subtitle={`This is how others will find you on the Dina network. We'll add ".${pdsHost}" automatically.`}
      primaryLabel="Continue"
      onPrimary={() => canContinue && props.onContinue(fullHandle)}
      primaryDisabled={!canContinue}
      onBack={props.onBack}
    >
      <Text style={styles.label}>Handle</Text>
      <View style={styles.inputRow}>
        <TextInput
          value={prefix}
          onChangeText={setPrefix}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          placeholder="raju"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          maxLength={30}
          returnKeyType="done"
          accessibilityLabel="Handle prefix"
          testID="handle-prefix-input"
        />
        <Text style={styles.suffix}>.{pdsHost}</Text>
      </View>

      <StatusLine status={status} />

      <SuggestionList
        status={status}
        pdsHost={pdsHost}
        onPick={(handle) => {
          // Strip the host suffix so the input mirrors the chosen
          // alternative — keeps the live-check loop honest.
          const newPrefix = handle.endsWith(`.${pdsHost}`)
            ? handle.slice(0, handle.length - `.${pdsHost}`.length)
            : handle;
          setPrefix(newPrefix);
        }}
      />
    </OnboardingShell>
  );
}

// ─── Status reducer-ish ───────────────────────────────────────────────────

type CheckStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'checked'; result: { preferred: AvailabilityResult; alternatives: AvailabilityResult[] } }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; reason: string };

function canPick(status: CheckStatus, fullHandle: string): boolean {
  if (fullHandle.length === 0) return false;
  if (status.kind !== 'checked') return false;
  return (
    status.result.preferred.kind === 'available' ||
    status.result.preferred.kind === 'unknown' // soft-allow PDS-down
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function StatusLine({ status }: { status: CheckStatus }): React.ReactElement | null {
  if (status.kind === 'idle') return null;
  if (status.kind === 'checking') {
    return (
      <View style={styles.statusRow} testID="handle-status-checking">
        <ActivityIndicator size="small" color={colors.accent} />
        <Text style={styles.statusMuted}>Checking…</Text>
      </View>
    );
  }
  if (status.kind === 'invalid') {
    return (
      <View style={styles.statusRow} testID="handle-status-invalid">
        <Text style={styles.statusBad}>{status.reason}</Text>
      </View>
    );
  }
  if (status.kind === 'error') {
    return (
      <View style={styles.statusRow} testID="handle-status-error">
        <Text style={styles.statusWarn}>
          Couldn&rsquo;t reach the directory ({status.reason}). You can keep going — we&rsquo;ll
          retry on commit.
        </Text>
      </View>
    );
  }
  // status.kind === 'checked'
  const p = status.result.preferred;
  if (p.kind === 'available') {
    return (
      <View style={styles.statusRow} testID="handle-status-available">
        <Text style={styles.statusGood}>{'✓'} Available</Text>
      </View>
    );
  }
  if (p.kind === 'taken') {
    return (
      <View style={styles.statusRow} testID="handle-status-taken">
        <Text style={styles.statusBad}>{'✗'} Taken — try one of these:</Text>
      </View>
    );
  }
  if (p.kind === 'unknown') {
    return (
      <View style={styles.statusRow} testID="handle-status-unknown">
        <Text style={styles.statusWarn}>
          Directory unreachable — you can keep going at your own risk.
        </Text>
      </View>
    );
  }
  // p.kind === 'invalid' — covered by sync check, but defensive.
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusBad}>{p.reason ?? 'Invalid handle'}</Text>
    </View>
  );
}

function SuggestionList({
  status,
  pdsHost,
  onPick,
}: {
  status: CheckStatus;
  pdsHost: string;
  onPick: (handle: string) => void;
}): React.ReactElement | null {
  if (status.kind !== 'checked') return null;
  if (status.result.preferred.kind !== 'taken') return null;
  if (status.result.alternatives.length === 0) return null;
  void pdsHost; // accepted for API symmetry; suggestions already include the suffix

  return (
    <View style={styles.suggestions} testID="handle-suggestions">
      {status.result.alternatives.map((alt) => (
        <Pressable
          key={alt.handle}
          onPress={() => onPick(alt.handle)}
          style={({ pressed }) => [styles.suggestionRow, pressed && styles.pressed]}
          testID={`handle-suggestion-${alt.handle}`}
          accessibilityRole="button"
        >
          <Text style={styles.suggestionText}>{alt.handle}</Text>
          <Text style={styles.suggestionHint}>tap to use</Text>
        </Pressable>
      ))}
    </View>
  );
}

function resolvePDSHost(): string {
  // Mirrors `deriveHandle` host selection: test infra → test PDS,
  // production → prod PDS. Keeps both code paths converged on the
  // same DNS suffix.
  return resolveMsgBoxURL().includes('test-mailbox')
    ? 'test-pds.dinakernel.com'
    : 'pds.dinakernel.com';
}

const styles = StyleSheet.create({
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
  },
  input: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 17,
  },
  suffix: {
    fontSize: 13,
    color: colors.textMuted,
    fontFamily: fonts.mono,
    marginLeft: spacing.xs,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    minHeight: 22,
  },
  statusMuted: {
    fontSize: 13,
    color: colors.textMuted,
  },
  statusGood: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.success,
  },
  statusBad: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.error,
  },
  statusWarn: {
    fontSize: 13,
    color: colors.textMuted,
    flexShrink: 1,
  },
  suggestions: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  suggestionRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  suggestionText: {
    fontSize: 14,
    fontFamily: fonts.mono,
    color: colors.textPrimary,
  },
  suggestionHint: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  pressed: { opacity: 0.6 },
});
