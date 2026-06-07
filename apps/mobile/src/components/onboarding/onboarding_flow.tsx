/**
 * OnboardingFlow — owns the multi-step state and renders the current
 * screen. Mounted by `UnlockGate` when no wrapped seed exists yet.
 *
 * State transitions live here; every screen is a pure presentational
 * component that calls one of the transition callbacks below.
 */

import React, { useState } from 'react';

import { generateNewMnemonic } from '../../hooks/useOnboarding';
import {
  INITIAL_STEP,
  previousStep,
  type CreateDraft,
  type ExternalAtprotoDraft,
  type RecoverDraft,
  type Step,
  type StepLocation,
} from '../../onboarding/state';
import {
  markVerificationPending,
  markVerified,
} from '../../services/verification_status';

import { AiProviderSet } from './ai_provider_set';
import { ExistingAtprotoIdentity } from './existing_atproto_identity';
import { HandlePicker } from './handle_pick';
import { MnemonicReveal } from './mnemonic_reveal';
import { MnemonicVerify } from './mnemonic_verify';
import { ModeChoice } from './mode_choice';
import { OwnerName } from './owner_name';
import { PassphraseSet } from './passphrase_set';
import { Provisioning } from './provisioning';
import { RecoveryEntry } from './recovery_entry';
import { RecoveryHandle } from './recovery_handle';
import { Welcome } from './welcome';

/**
 * Dev-only autopilot: when EXPO_PUBLIC_DINA_DEV_PASSPHRASE is set we
 * auto-complete the create-new path with a fixed name + passphrase so
 * end-to-end smoke runs don't depend on keyboard input reaching the
 * iOS sim. Off in production (bundle-time env variable).
 */
const DEV_PASSPHRASE = process.env.EXPO_PUBLIC_DINA_DEV_PASSPHRASE ?? '';
const DEV_OWNER = process.env.EXPO_PUBLIC_DINA_DEV_OWNER ?? 'Dina Dev';

export function OnboardingFlow(): React.ReactElement {
  const [step, setStep] = useState<Step>(INITIAL_STEP);

  const goBack = (): void => {
    const prev = previousStep(step);
    if (prev !== null) setStep(prev);
  };

  /**
   * Route into the mandatory AI-provider step, which then advances to
   * `next` (the flow's provisioning step) once a working key is connected.
   * `back` returns to the step the user came from; `location` carries the
   * right "N of M" for the flow.
   */
  const goToAiStep = (next: Step, back: Step, location: StepLocation): void => {
    setStep({ kind: 'ai_provider', next, back, location });
  };

  // Dev autopilot: on first render, if we're at `welcome` and the dev
  // env is set, jump to provisioning with canned values. Runs once.
  React.useEffect(() => {
    if (DEV_PASSPHRASE === '' || step.kind !== 'welcome') return;
    const mnemonic = generateNewMnemonic();
    const draft: CreateDraft = {
      ownerName: DEV_OWNER,
      // Empty triggers the silent always-suffix fallback in
      // `provisionIdentity` — fine for the dev path which bypasses the
      // picker wizard.
      handle: '',
      passphrase: DEV_PASSPHRASE,
      startupMode: 'auto',
      mnemonic,
    };
    setStep({ kind: 'provisioning_create', draft });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  switch (step.kind) {
    case 'welcome':
      return <Welcome onGetStarted={() => setStep({ kind: 'choose' })} />;

    case 'choose':
      return (
        <ModeChoice
          onCreate={() => setStep({ kind: 'create_name', draft: {} })}
          onExternalAtproto={() => setStep({ kind: 'external_identity', draft: {} })}
          onRecover={() => setStep({ kind: 'recover_mnemonic', draft: {} })}
          onBack={goBack}
        />
      );

    case 'create_name':
      return (
        <OwnerName
          initialName={step.draft.ownerName}
          onBack={goBack}
          onContinue={(name) =>
            setStep({
              kind: 'create_handle',
              draft: { ...step.draft, ownerName: name },
            })
          }
        />
      );

    case 'create_handle':
      return (
        <HandlePicker
          seedPrefix={step.draft.ownerName ?? ''}
          initialHandle={step.draft.handle}
          serverError={step.error}
          onBack={goBack}
          onContinue={(handle) => {
            const draft = { ...step.draft, handle };
            // If we bounced back here from a failed provisioning attempt,
            // the rest of the draft (passphrase + verified mnemonic) is
            // already complete — go straight back to provisioning rather
            // than re-walking passphrase + mnemonic confirm.
            if (
              draft.passphrase !== undefined &&
              draft.passphrase.length > 0 &&
              draft.mnemonic !== undefined &&
              draft.mnemonic.length > 0
            ) {
              setStep({ kind: 'provisioning_create', draft: draft as CreateDraft });
            } else {
              setStep({ kind: 'create_passphrase', draft });
            }
          }}
        />
      );

    case 'create_passphrase':
      return (
        <PassphraseSet
          initialPassphrase={step.draft.passphrase}
          initialMode={step.draft.startupMode ?? 'auto'}
          onBack={goBack}
          onContinue={(passphrase, mode) => {
            // Generate the mnemonic once, right before the reveal, so
            // the user isn't holding a mnemonic they never saw if they
            // went back and forward through passphrase screens.
            const mnemonic = step.draft.mnemonic ?? generateNewMnemonic();
            setStep({
              kind: 'create_mnemonic_reveal',
              draft: { ...step.draft, passphrase, startupMode: mode, mnemonic },
            });
          }}
        />
      );

    case 'create_mnemonic_reveal':
      if (step.draft.mnemonic === undefined) {
        // Defensive — a draft without a mnemonic shouldn't reach this
        // screen; regenerate and re-render.
        setStep({
          kind: 'create_mnemonic_reveal',
          draft: { ...step.draft, mnemonic: generateNewMnemonic() },
        });
        return <></>;
      }
      return (
        <MnemonicReveal
          mnemonic={step.draft.mnemonic}
          onBack={goBack}
          onContinue={() =>
            setStep({
              kind: 'create_mnemonic_verify',
              draft: step.draft,
            })
          }
        />
      );

    case 'create_mnemonic_verify':
      if (step.draft.mnemonic === undefined) return <></>;
      return (
        <MnemonicVerify
          mnemonic={step.draft.mnemonic}
          onBack={goBack}
          onViewPhrase={() => setStep({ kind: 'create_mnemonic_reveal', draft: step.draft })}
          onVerified={() => {
            // Defensive — clear any leftover `pending` marker before
            // advancing. Normally absent on a fresh flow; covers the
            // edge where a user starts a "do this later" cycle, then
            // backtracks and completes verification inline.
            void markVerified();
            const complete: CreateDraft = {
              ownerName: step.draft.ownerName ?? 'Dina',
              handle: step.draft.handle ?? '',
              passphrase: step.draft.passphrase ?? '',
              startupMode: step.draft.startupMode ?? 'auto',
              mnemonic: step.draft.mnemonic ?? [],
            };
            // Mandatory AI step before provisioning unlocks the app.
            goToAiStep(
              { kind: 'provisioning_create', draft: complete },
              { kind: 'create_mnemonic_verify', draft: complete },
              { current: 6, total: 7, label: 'Connect AI' },
            );
          }}
          onSkip={() => {
            // Mark pending and advance. Chat home renders a "Confirm
            // recovery phrase" banner from this state until the user
            // completes the deferred confirm flow in Settings.
            void markVerificationPending();
            const complete: CreateDraft = {
              ownerName: step.draft.ownerName ?? 'Dina',
              handle: step.draft.handle ?? '',
              passphrase: step.draft.passphrase ?? '',
              startupMode: step.draft.startupMode ?? 'auto',
              mnemonic: step.draft.mnemonic ?? [],
            };
            goToAiStep(
              { kind: 'provisioning_create', draft: complete },
              { kind: 'create_mnemonic_verify', draft: complete },
              { current: 6, total: 7, label: 'Connect AI' },
            );
          }}
        />
      );

    case 'provisioning_create':
      return (
        <Provisioning
          kind="create"
          step={step}
          options={{
            mnemonic: step.draft.mnemonic,
            passphrase: step.draft.passphrase,
            ownerName: step.draft.ownerName,
            // When the user came through the wizard, `handle` is set
            // and we pass it to the PLC genesis op as-is. When the
            // dev autopilot bypasses the wizard, this is empty and
            // `provisionIdentity` falls back to `deriveHandle`.
            handle: step.draft.handle.length > 0 ? step.draft.handle : undefined,
            startupMode: step.draft.startupMode,
          }}
          onDone={() => {
            // `unlock()` inside provisionIdentity flips isUnlocked → true;
            // UnlockGate's subscriber renders `children` on its next
            // render, swapping this whole tree out. No-op here beyond
            // optional telemetry.
          }}
          onError={(message) =>
            // Bounce back to the handle step (not all the way to `choose`)
            // with the draft intact and the PDS error shown, so the user
            // can fix the handle and retry without re-entering everything.
            // Provisioning is atomic — nothing was persisted on failure.
            setStep({
              kind: 'error',
              message,
              retry: { kind: 'create_handle', draft: step.draft, error: message },
            })
          }
        />
      );

    case 'recover_mnemonic':
      return (
        <RecoveryEntry
          initialWords={step.draft.mnemonic}
          onBack={goBack}
          onContinue={(words, didKey) =>
            setStep({
              kind: 'recover_handle',
              draft: { ...step.draft, mnemonic: words, derivedDidKey: didKey },
            })
          }
        />
      );

    case 'recover_handle':
      return (
        <RecoveryHandle
          mnemonic={step.draft.mnemonic ?? []}
          initialHandle={step.draft.handle}
          onBack={goBack}
          onContinue={(handle, didPlc) =>
            setStep({
              kind: 'recover_passphrase',
              draft: { ...step.draft, handle, expectedDid: didPlc },
            })
          }
        />
      );

    case 'recover_passphrase':
      return (
        <PassphraseSet
          flow="recover"
          initialPassphrase={step.draft.passphrase}
          initialMode={step.draft.startupMode ?? 'auto'}
          onBack={goBack}
          onContinue={(passphrase, mode) => {
            const complete: RecoverDraft = {
              mnemonic: step.draft.mnemonic ?? [],
              derivedDidKey: step.draft.derivedDidKey ?? '',
              handle: step.draft.handle ?? '',
              expectedDid: step.draft.expectedDid ?? '',
              passphrase,
              startupMode: mode,
            };
            goToAiStep(
              { kind: 'provisioning_recover', draft: complete },
              { kind: 'recover_passphrase', draft: complete },
              { current: 4, total: 5, label: 'Connect AI' },
            );
          }}
        />
      );

    case 'provisioning_recover':
      return (
        <Provisioning
          kind="recover"
          step={step}
          options={{
            mnemonic: step.draft.mnemonic,
            passphrase: step.draft.passphrase,
            expectedDid: step.draft.expectedDid,
            handle: step.draft.handle,
            startupMode: step.draft.startupMode,
          }}
          onDone={() => {
            /* UnlockGate subscriber handles transition. */
          }}
          onError={(message) =>
            setStep({
              kind: 'error',
              message,
              retry: { kind: 'recover_mnemonic', draft: { mnemonic: step.draft.mnemonic } },
            })
          }
        />
      );

    case 'external_identity':
      return (
        <ExistingAtprotoIdentity
          initialIdentifier={step.draft.identifier}
          onBack={goBack}
          onContinue={(identifier, verifiedLink) =>
            setStep({
              kind: 'external_passphrase',
              draft: { ...step.draft, identifier, ...(verifiedLink ? { verifiedLink } : {}) },
            })
          }
        />
      );

    case 'external_passphrase':
      return (
        <PassphraseSet
          flow="external"
          initialPassphrase={step.draft.passphrase}
          initialMode={step.draft.startupMode ?? 'auto'}
          onBack={goBack}
          onContinue={(passphrase, mode) => {
            const mnemonic = step.draft.mnemonic ?? generateNewMnemonic();
            setStep({
              kind: 'external_mnemonic_reveal',
              draft: { ...step.draft, passphrase, startupMode: mode, mnemonic },
            });
          }}
        />
      );

    case 'external_mnemonic_reveal':
      if (step.draft.mnemonic === undefined) {
        setStep({
          kind: 'external_mnemonic_reveal',
          draft: { ...step.draft, mnemonic: generateNewMnemonic() },
        });
        return <></>;
      }
      return (
        <MnemonicReveal
          step={{ kind: 'external_mnemonic_reveal', draft: {} }}
          mnemonic={step.draft.mnemonic}
          onBack={goBack}
          onContinue={() =>
            setStep({
              kind: 'external_mnemonic_verify',
              draft: step.draft,
            })
          }
        />
      );

    case 'external_mnemonic_verify':
      if (step.draft.mnemonic === undefined) return <></>;
      return (
        <MnemonicVerify
          step={{ kind: 'external_mnemonic_verify', draft: {} }}
          mnemonic={step.draft.mnemonic}
          onBack={goBack}
          onViewPhrase={() =>
            setStep({ kind: 'external_mnemonic_reveal', draft: step.draft })
          }
          onVerified={() => {
            void markVerified();
            const complete: ExternalAtprotoDraft = {
              identifier: step.draft.identifier ?? '',
              ...(step.draft.verifiedLink ? { verifiedLink: step.draft.verifiedLink } : {}),
              passphrase: step.draft.passphrase ?? '',
              startupMode: step.draft.startupMode ?? 'auto',
              mnemonic: step.draft.mnemonic ?? [],
            };
            goToAiStep(
              { kind: 'provisioning_external', draft: complete },
              { kind: 'external_mnemonic_verify', draft: complete },
              { current: 5, total: 6, label: 'Connect AI' },
            );
          }}
          onSkip={() => {
            void markVerificationPending();
            const complete: ExternalAtprotoDraft = {
              identifier: step.draft.identifier ?? '',
              ...(step.draft.verifiedLink ? { verifiedLink: step.draft.verifiedLink } : {}),
              passphrase: step.draft.passphrase ?? '',
              startupMode: step.draft.startupMode ?? 'auto',
              mnemonic: step.draft.mnemonic ?? [],
            };
            goToAiStep(
              { kind: 'provisioning_external', draft: complete },
              { kind: 'external_mnemonic_verify', draft: complete },
              { current: 5, total: 6, label: 'Connect AI' },
            );
          }}
        />
      );

    case 'provisioning_external':
      return (
        <Provisioning
          kind="external"
          step={step}
          options={{
            mnemonic: step.draft.mnemonic,
            passphrase: step.draft.passphrase,
            identifier: step.draft.identifier,
            startupMode: step.draft.startupMode,
            ...(step.draft.verifiedLink ? { verifiedLink: step.draft.verifiedLink } : {}),
          }}
          onDone={() => {
            /* UnlockGate subscriber handles transition. */
          }}
          onError={(message) =>
            setStep({
              kind: 'error',
              message,
              // Retry provisioning DIRECTLY with the full verified draft —
              // do NOT bounce back to `external_identity` (only `identifier`),
              // which would make the user redo the Bluesky OAuth + recovery
              // setup. `step.draft` carries verifiedLink + mnemonic +
              // passphrase + startupMode, so the retry re-attempts the PDS /
              // PLC steps (which now resume an already-created account) with
              // nothing lost.
              retry: {
                kind: 'provisioning_external',
                draft: step.draft,
              },
            })
          }
        />
      );

    case 'ai_provider':
      return (
        <AiProviderSet
          location={step.location}
          onBack={goBack}
          onContinue={() => setStep(step.next)}
        />
      );

    case 'error':
      return <ErrorStep message={step.message} onRetry={() => setStep(step.retry)} />;
  }
}

// Error screen — the Provisioning screen itself surfaces the error
// inline, and "Back" there dispatches an `error` step with a retry
// target. We just render that target immediately — mount-time effect
// in the retry screen takes over.
function ErrorStep(props: { message: string; onRetry: () => void }): React.ReactElement {
  // Fire once on mount to return the user to the retry screen; the
  // transient render of this component is invisible in practice.
  React.useEffect(() => {
    props.onRetry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <></>;
}
