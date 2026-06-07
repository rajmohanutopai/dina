/**
 * GuidedDemoGate — renders the first-run entry / crash-recovery surfaces in
 * place of the app, and overlays the "sample data only" banner while a demo is
 * active. Mounted just inside UnlockGate so it sits between unlock and Chat.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useGuidedDemoGate } from '../../guided_demo/useGuidedDemoGate';
import { colors } from '../../theme';

import {
  GuidedDemoEntry,
  GuidedDemoBanner,
  GuidedDemoRecoveryPrompt,
  GuidedDemoTeardown,
} from './GuidedDemoScreens';

export function GuidedDemoGate({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  /**
   * When false (boot still loading or failed), the gate defers entirely to
   * children — the boot banner must never be masked by the demo entry, and the
   * KV repo the gate reads isn't wired until a successful boot.
   */
  enabled?: boolean;
}): React.ReactElement {
  const gate = useGuidedDemoGate(enabled);

  if (!enabled) {
    return <>{children}</>;
  }
  if (gate.phase === 'checking') {
    return <View style={styles.fill} />;
  }
  if (gate.phase === 'entry') {
    return (
      <GuidedDemoEntry
        onStartDemo={() => void gate.startDemo()}
        onStartEmpty={() => void gate.skip()}
      />
    );
  }
  if (gate.phase === 'recovery') {
    return (
      <GuidedDemoRecoveryPrompt
        onContinue={() => void gate.continueDemo()}
        onDelete={() => void gate.deleteDemo()}
      />
    );
  }
  if (gate.phase === 'tearing_down') {
    // Non-interactive surface: the runtime is still on the demo scope until
    // teardown finishes, so the app must NOT be reachable (a tap here would
    // write to the soon-deleted demo scope). Replaces the app entirely.
    return <GuidedDemoTeardown />;
  }
  // running
  return (
    <View style={styles.fill}>
      {gate.demoActive ? (
        <GuidedDemoBanner
          onExit={() => void gate.exitDemo()}
          onAdvance={() => void gate.advanceDemo()}
          caption={gate.currentAction?.caption ?? null}
          step={gate.step}
          stepCount={gate.stepCount}
          demoComplete={gate.demoComplete}
          actionInFlight={gate.actionInFlight}
        />
      ) : null}
      <View style={styles.fill}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bgPrimary },
});
