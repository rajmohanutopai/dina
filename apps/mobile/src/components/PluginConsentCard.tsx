/**
 * `PluginConsentCard` — the consent surface for installing a THIRD-PARTY plugin
 * (RESEARCHER_KERNEL_ARCHITECTURE.md §5.C2). `beginPluginInstall` has already
 * authenticated the release through the repo-proof verifier (§5.C1) and staged
 * a PENDING install; this card renders what that plugin is asking for and is the
 * one place the owner says yes.
 *
 * CONSENT IS A TAP, NOT A BOOT STEP. Nothing the plugin declared runs until the
 * owner presses Install: `confirmPluginInstall` flips the install to `active`.
 * Decline tears the pending install down and revokes any runner device paired
 * during the ceremony. Both buttons disable after the first tap so a
 * double-press can't double-fire the ceremony.
 *
 * RUNNER PAIRING BEFORE AUTHORITY (PLUGIN_ARCHITECTURE §15.3). A runner plugin
 * has its own key, so the card first shows a setup code for `dina-plugin serve`
 * tied to this pending install and waits. Core binds the exact device that uses
 * the code to the install the moment pairing completes; the card only polls
 * and RENDERS that state. Install stays disabled until Core reports "Identity
 * bound", and the confirm never names a device — Core activates on the one
 * the install row holds. Interpreted plugins have no runtime identity and skip
 * this.
 *
 * The card is deliberately blunt about the two things that matter for the kernel
 * rule (CLAUDE.md — "plugins are signed contracts, never in-process code"): the
 * EXECUTION MODE (a runner gets its own key + process; an interpreted plugin is
 * data a hardened interpreter runs) and the exact CAPABILITIES granted.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Share, Text, TouchableOpacity, View, StyleSheet } from 'react-native';

import {
  checkRunnerPairing,
  confirmPluginInstall,
  declinePluginInstall,
  issueRunnerSetupCode,
  type PluginConsentSummary,
  type RunnerPairingState,
  type RunnerSetupCode,
} from '../services/plugin_install';
import { colors, fonts, radius, spacing, textStyles } from '../theme';

export type PluginConsentOutcome = 'confirmed' | 'declined' | 'failed';

export interface PluginConsentCardProps {
  consent: PluginConsentSummary;
  /** The install flow advances (or dismisses) on the owner's decision. */
  onDone: (outcome: PluginConsentOutcome, detail?: string) => void;
}

/** How often the card asks Core whether the runner has paired. */
const PAIRING_POLL_MS = 2000;

/** Plain-language gloss of the two execution modes — the kernel's core distinction. */
function executionModeLine(mode: PluginConsentSummary['executionMode']): string {
  return mode === 'runner'
    ? 'Runs in its own sandbox with its own key — never inside Dina.'
    : 'Runs as data a hardened interpreter reads — no code inside Dina.';
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function PluginConsentCard({
  consent,
  onDone,
}: PluginConsentCardProps): React.JSX.Element {
  const isRunner = consent.executionMode === 'runner';
  const [pending, setPending] = useState(false);
  const [resolved, setResolved] = useState<PluginConsentOutcome | null>(null);

  // Runner pairing (§15.3). `setup` is the live code; `pairing` is Core's word.
  const [setup, setSetup] = useState<RunnerSetupCode | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<RunnerPairingState>({ state: 'waiting' });
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [shared, setShared] = useState(false);

  const issueCode = useCallback(() => {
    try {
      setSetup(issueRunnerSetupCode(consent));
      setSetupError(null);
      setPairing({ state: 'waiting' });
    } catch (err) {
      setSetup(null);
      setSetupError(err instanceof Error ? err.message : String(err));
    }
  }, [consent]);

  // Issue the first code as soon as a runner card appears; the owner can only
  // install after the runner pairs, so there is nothing to wait for.
  useEffect(() => {
    if (isRunner && resolved === null) issueCode();
    // `issueCode` is keyed on the consent; a new consent is a new card.
  }, [isRunner, issueCode, resolved]);

  // Poll Core until it reports the exact device this code paired, bound to this
  // pending install. Stops on bound / expired / refused, or once decided.
  useEffect(() => {
    if (!isRunner || setup === null || resolved !== null || pairing.state !== 'waiting') return;
    const installId = consent.installId;
    const code = setup.code;
    const tick = (): void => {
      setNow(Math.floor(Date.now() / 1000));
      const next = checkRunnerPairing(installId, code);
      if (next.state !== 'waiting') setPairing(next);
    };
    tick();
    const timer = setInterval(tick, PAIRING_POLL_MS);
    return () => clearInterval(timer);
  }, [consent.installId, isRunner, pairing.state, resolved, setup]);

  // Second-by-second countdown for the code's expiry.
  useEffect(() => {
    if (!isRunner || setup === null || pairing.state !== 'waiting') return;
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isRunner, pairing.state, setup]);

  const canInstall = !isRunner || pairing.state === 'bound';

  const onConfirm = useCallback(async () => {
    if (pending || resolved !== null || !canInstall) return;
    setPending(true);
    try {
      const result = await confirmPluginInstall(consent.installId, consent.executionMode);
      if (result.ok) {
        setResolved('confirmed');
        onDone('confirmed');
      } else {
        setResolved('failed');
        onDone('failed', result.error);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setResolved('failed');
      onDone('failed', detail);
    } finally {
      setPending(false);
    }
  }, [canInstall, consent.executionMode, consent.installId, onDone, pending, resolved]);

  const onDecline = useCallback(async () => {
    if (pending || resolved !== null) return;
    setPending(true);
    try {
      await declinePluginInstall(consent.installId);
      setResolved('declined');
      onDone('declined');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setResolved('declined');
      onDone('declined', detail);
    } finally {
      setPending(false);
    }
  }, [consent.installId, onDone, pending, resolved]);

  const onShare = useCallback(() => {
    if (setup === null) return;
    Share.share({ message: setup.setupCode }).catch(() => undefined);
    setShared(true);
    setTimeout(() => setShared(false), 2000);
  }, [setup]);

  const disabled = pending || resolved !== null;
  const secondsLeft = setup === null ? 0 : Math.max(0, setup.expiresAt - now);

  return (
    <View testID={`plugin-consent-card-${consent.installId}`} style={styles.card}>
      <Text style={styles.label}>Install plugin?</Text>
      <Text testID={`plugin-consent-name-${consent.installId}`} style={styles.name}>
        {consent.displayName}
      </Text>
      <Text style={styles.subline}>
        <Text style={styles.pluginId}>{consent.pluginId}</Text> · v{consent.version}
      </Text>

      <Text testID={`plugin-consent-mode-${consent.installId}`} style={styles.mode}>
        {executionModeLine(consent.executionMode)}
      </Text>

      <Text style={styles.capsHeading}>This plugin can:</Text>
      {consent.capabilities.length === 0 ? (
        <Text style={styles.capNone}>Nothing — it requests no capabilities.</Text>
      ) : (
        consent.capabilities.map((capability, i) => (
          <Text
            key={`${capability}-${i}`}
            testID={`plugin-consent-cap-${consent.installId}-${i}`}
            style={styles.cap}
          >
            • {capability}
          </Text>
        ))
      )}

      {isRunner && resolved === null && (
        <View testID={`plugin-consent-pairing-${consent.installId}`} style={styles.pairing}>
          <Text style={styles.capsHeading}>Connect the runner</Text>
          {setupError !== null && (
            <>
              <Text style={styles.pairingError}>{setupError}</Text>
              <TouchableOpacity
                testID={`plugin-consent-reissue-${consent.installId}`}
                onPress={issueCode}
                accessibilityRole="button"
              >
                <Text style={styles.link}>Try again</Text>
              </TouchableOpacity>
            </>
          )}
          {setup !== null && pairing.state === 'waiting' && (
            <>
              <Text style={styles.help}>
                On the machine that will run it: <Text style={styles.pluginId}>dina-plugin serve</Text>{' '}
                and paste this setup code. The runner pairs with its own key; Dina binds that exact
                device to this install.
              </Text>
              <Text
                testID={`plugin-consent-setup-code-${consent.installId}`}
                style={styles.setupCode}
                selectable
              >
                {setup.setupCode}
              </Text>
              <View style={styles.pairingRow}>
                <TouchableOpacity
                  testID={`plugin-consent-share-${consent.installId}`}
                  onPress={onShare}
                  accessibilityRole="button"
                  accessibilityLabel="Share setup code"
                >
                  <Text style={styles.link}>{shared ? 'Shared!' : 'Share setup code'}</Text>
                </TouchableOpacity>
                <Text style={[styles.codeMeta, secondsLeft < 60 && styles.codeExpiring]}>
                  Expires in {formatDuration(secondsLeft)}
                </Text>
              </View>
              <Text testID={`plugin-consent-pairing-state-${consent.installId}`} style={styles.progress}>
                Waiting for the runner…
              </Text>
            </>
          )}
          {pairing.state === 'bound' && (
            <Text testID={`plugin-consent-pairing-state-${consent.installId}`} style={styles.progressBound}>
              Identity bound · <Text style={styles.pluginId}>{pairing.deviceDid}</Text>
            </Text>
          )}
          {pairing.state === 'expired' && (
            <>
              <Text testID={`plugin-consent-pairing-state-${consent.installId}`} style={styles.pairingError}>
                The setup code expired before the runner paired.
              </Text>
              <TouchableOpacity
                testID={`plugin-consent-reissue-${consent.installId}`}
                onPress={issueCode}
                accessibilityRole="button"
              >
                <Text style={styles.link}>Issue a new code</Text>
              </TouchableOpacity>
            </>
          )}
          {pairing.state === 'refused' && (
            <Text testID={`plugin-consent-pairing-state-${consent.installId}`} style={styles.pairingError}>
              This install can&apos;t take a runner any more: {pairing.error}. Decline and start again.
            </Text>
          )}
        </View>
      )}

      {resolved === null && (
        <View style={styles.row}>
          <TouchableOpacity
            testID={`plugin-consent-decline-${consent.installId}`}
            style={[styles.btn, styles.decline, disabled && styles.btnDisabled]}
            disabled={disabled}
            onPress={onDecline}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Text style={styles.declineText}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID={`plugin-consent-install-${consent.installId}`}
            style={[styles.btn, styles.install, (disabled || !canInstall) && styles.btnDisabled]}
            disabled={disabled || !canInstall}
            onPress={onConfirm}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityState={{ disabled: disabled || !canInstall }}
          >
            <Text style={styles.installText}>Install</Text>
          </TouchableOpacity>
        </View>
      )}
      {resolved === 'confirmed' && <Text style={styles.statusLine}>Installed.</Text>}
      {resolved === 'declined' && <Text style={styles.statusLine}>Declined.</Text>}
      {resolved === 'failed' && (
        <Text testID={`plugin-consent-failed-${consent.installId}`} style={styles.statusLine}>
          Couldn&apos;t install.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
  },
  label: {
    ...textStyles.eyebrow,
    marginBottom: spacing.xs,
  },
  name: {
    ...textStyles.body,
    fontFamily: fonts.sansSemibold,
  },
  subline: {
    ...textStyles.caption,
    marginBottom: spacing.sm,
  },
  pluginId: {
    ...textStyles.mono,
  },
  mode: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  capsHeading: {
    ...textStyles.caption,
    fontFamily: fonts.sansSemibold,
    marginBottom: spacing.xs,
  },
  cap: {
    ...textStyles.bodySmall,
    marginBottom: 2,
  },
  capNone: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  pairing: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  help: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  setupCode: {
    ...textStyles.mono,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.xs,
  },
  pairingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  link: {
    ...textStyles.bodySmall,
    color: colors.accent,
  },
  codeMeta: {
    ...textStyles.caption,
    color: colors.textMuted,
  },
  codeExpiring: {
    color: colors.error,
  },
  progress: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  progressBound: {
    ...textStyles.bodySmall,
  },
  pairingError: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minWidth: 88,
    alignItems: 'center',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  install: {
    backgroundColor: colors.textPrimary,
  },
  installText: {
    ...textStyles.buttonSmall,
    color: colors.bgPrimary,
  },
  decline: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  declineText: {
    ...textStyles.buttonSmall,
    color: colors.textPrimary,
  },
  statusLine: {
    ...textStyles.caption,
    marginTop: spacing.sm,
  },
});
