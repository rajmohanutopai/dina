/**
 * Provisioning — runs `provisionIdentity` or `recoverIdentity` and
 * shows a step-by-step progress list so the user understands what's
 * happening (and why 128 MB Argon2id takes a few hundred ms).
 *
 * This screen owns the side-effect: it kicks off provisioning on mount
 * and surfaces either success (UnlockGate unwraps to tabs via the
 * `unlocked` flag) or a user-readable error. No back arrow — we can't
 * walk back a half-published PLC op.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { OnboardingShell } from './shell';
import { locateStep, type Step } from '../../onboarding/state';
import {
  PROVISION_LABELS,
  type ProvisionOptions,
  type ProvisionProgress,
  type ProvisionStage,
  type ProvisionResult,
  provisionIdentity,
  recoverIdentity,
} from '../../onboarding/provision';
import { colors, fonts, radius, spacing } from '../../theme';

const STAGES: ProvisionStage[] = [
  'deriving_seed',
  'deriving_keys',
  'persisting_keys',
  'wrapping_seed',
  'creating_pds_account',
  'publishing_plc_update',
  'persisting_did',
  'opening_vault',
  'done',
];

export type ProvisioningProps =
  | {
      kind: 'create';
      options: Omit<ProvisionOptions, 'onProgress'>;
      onDone: (result: ProvisionResult) => void;
      onError: (message: string) => void;
      step: Step;
    }
  | {
      kind: 'recover';
      options: Parameters<typeof recoverIdentity>[0];
      onDone: (result: ProvisionResult) => void;
      onError: (message: string) => void;
      step: Step;
    };

export function Provisioning(props: ProvisioningProps): React.ReactElement {
  const [current, setCurrent] = useState<ProvisionStage>('deriving_seed');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handleProgress = (p: ProvisionProgress): void => {
      if (cancelled) return;
      setCurrent(p.stage);
    };
    (async () => {
      try {
        const result =
          props.kind === 'create'
            ? await provisionIdentity({ ...props.options, onProgress: handleProgress })
            : await recoverIdentity({ ...props.options, onProgress: handleProgress });
        if (cancelled) return;
        props.onDone(result);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only run once on mount — provisioning should fire exactly one
    // side-effect per provisioning screen instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const headline = props.kind === 'create' ? 'Creating your Dina' : 'Restoring your Dina';
  const subtitle =
    props.kind === 'create'
      ? 'We\u2019re generating keys, wrapping your master seed, and registering your identity with the Dina network.'
      : 'We\u2019re re-deriving your keys from the recovery phrase and restoring your local vault.';

  return (
    <OnboardingShell
      location={locateStep(props.step)}
      title={headline}
      subtitle={subtitle}
      canGoBack={false}
    >
      <View style={styles.list}>
        {STAGES.map((stage) => (
          <StageRow key={stage} stage={stage} state={stageStateOf(stage, current, error)} />
        ))}
      </View>

      {error !== null ? (
        <View style={styles.errorPanel}>
          <Text style={styles.errorTitle}>We hit a snag</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <Pressable
            onPress={() => props.onError(error)}
            style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.retryText}>Back</Text>
          </Pressable>
        </View>
      ) : null}
    </OnboardingShell>
  );
}

type RowState = 'pending' | 'active' | 'done' | 'error';

function stageStateOf(
  stage: ProvisionStage,
  current: ProvisionStage,
  error: string | null,
): RowState {
  const stageIdx = STAGES.indexOf(stage);
  const currentIdx = STAGES.indexOf(current);
  if (stageIdx < currentIdx) return 'done';
  if (stageIdx > currentIdx) return 'pending';
  // stage === current
  if (error !== null) return 'error';
  if (stage === 'done') return 'done';
  return 'active';
}

function StageRow({
  stage,
  state,
}: {
  stage: ProvisionStage;
  state: RowState;
}): React.ReactElement {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, dotStyleOf(state)]}>
        {state === 'active' ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : state === 'done' ? (
          <Text style={styles.dotCheck}>{'\u2713'}</Text>
        ) : state === 'error' ? (
          <Text style={styles.dotErr}>{'!'}</Text>
        ) : null}
      </View>
      <Text
        style={[
          styles.rowText,
          state === 'pending' && styles.rowPending,
          state === 'error' && styles.rowError,
        ]}
      >
        {PROVISION_LABELS[stage]}
      </Text>
    </View>
  );
}

function dotStyleOf(state: RowState) {
  switch (state) {
    case 'pending':
      return styles.dotPending;
    case 'active':
      return styles.dotActive;
    case 'done':
      return styles.dotDone;
    case 'error':
      return styles.dotErrBg;
  }
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 6,
  },
  dot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotPending: { backgroundColor: colors.border },
  dotActive: { backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.accent },
  dotDone: { backgroundColor: colors.success },
  dotErrBg: { backgroundColor: colors.error },
  dotCheck: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  dotErr: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  rowText: {
    fontSize: 15,
    color: colors.textPrimary,
  },
  rowPending: { color: colors.textMuted },
  rowError: { color: colors.error },
  errorPanel: {
    marginTop: spacing.xl,
    padding: spacing.md,
    backgroundColor: '#FDE8E8',
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.error,
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.error,
    letterSpacing: 0.2,
  },
  errorMessage: {
    marginTop: 4,
    fontSize: 13,
    lineHeight: 19,
    color: '#7A1F1F',
    fontFamily: fonts.mono,
  },
  retryBtn: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    backgroundColor: colors.error,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.sm,
  },
  retryText: { color: '#FFFFFF', fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
