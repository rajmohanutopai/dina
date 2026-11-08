/**
 * GuidedDemoGate — renders the first-run entry / crash-recovery surfaces in
 * place of the app, and overlays the "sample data only" banner while a demo is
 * active. Mounted just inside UnlockGate so it sits between unlock and Chat.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';

import { GuidedDemoActiveContext } from '../../guided_demo/active_context';
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

  // The app stays in one place in the tree from the first paint on. It is on
  // screen while Dina starts, so moving it when boot ends would rebuild it and
  // lose whatever screen was opened or text typed in those seconds.
  const checking = enabled && gate.phase === 'checking';
  if (enabled && gate.phase === 'entry') {
    return (
      <GuidedDemoEntry
        onStartDemo={() => void gate.startDemo()}
        onStartEmpty={() => void gate.skip()}
      />
    );
  }
  if (enabled && gate.phase === 'recovery') {
    return (
      <GuidedDemoRecoveryPrompt
        onContinue={() => void gate.continueDemo()}
        onDelete={() => void gate.deleteDemo()}
      />
    );
  }
  if (enabled && gate.phase === 'tearing_down') {
    // Non-interactive surface: the runtime is still on the demo scope until
    // teardown finishes, so the app must NOT be reachable (a tap here would
    // write to the soon-deleted demo scope). Replaces the app entirely.
    return <GuidedDemoTeardown />;
  }
  // running — the demo control is a BOTTOM dock rendered AFTER (on top of) the
  // app so it covers the composer (Ask/Remember), blocking it mid-demo, and
  // leaves the top of the screen clean.
  //
  // The advance button is styled like the composer chip for the step's mode
  // (Remember / Ask) so the user learns the real affordance — "to remember
  // something, tap Remember". Steps with no composer analog (approval / publish)
  // pass undefined → a generic "Next step" button.
  const action = gate.currentAction;
  const nextMode =
    action === null
      ? undefined
      : action.kind === 'chat'
        ? action.step.mode
        : action.kind === 'recommend' || action.kind === 'service'
          ? 'ask'
          : undefined;
  // navigate steps carry an explicit button label ("Show me" / "Back to chat");
  // the salon publish step's button reads "Publish" (it opens the publish popup).
  const nextLabel =
    action === null
      ? undefined
      : action.kind === 'navigate'
        ? action.step.nextLabel
        : action.kind === 'salon_publish'
          ? 'Publish'
          : undefined;
  return (
    <GuidedDemoActiveContext.Provider value={enabled && gate.demoActive}>
      <View style={styles.fill}>
        <View style={styles.fill}>{children}</View>
        {/* Covered, not hidden: a browser doesn't run animations under
            display:none, so a menu closing then would never finish fading and
            its backdrop would keep blocking taps. */}
        {checking ? <View style={styles.cover} testID="guided-demo-checking" /> : null}
        {enabled && gate.demoActive ? (
          <GuidedDemoBanner
            onExit={() => void gate.exitDemo()}
            onAdvance={() => void gate.advanceDemo()}
            caption={gate.caption}
            step={gate.step}
            stepCount={gate.stepCount}
            demoComplete={gate.demoComplete}
            actionInFlight={gate.actionInFlight}
            nextMode={nextMode}
            nextLabel={nextLabel}
          />
        ) : null}
      </View>
    </GuidedDemoActiveContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bgPrimary },
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.bgPrimary },
});
