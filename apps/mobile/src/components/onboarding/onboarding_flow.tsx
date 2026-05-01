/**
 * OnboardingFlow — owns the multi-step state and renders the current
 * screen. Mounted by `UnlockGate` when no wrapped seed exists yet.
 *
 * State transitions live here; every screen is a pure presentational
 * component that calls one of the transition callbacks below.
 */

import React, { useState } from 'react';
import {
  INITIAL_STEP,
  previousStep,
  type CreateDraft,
  type RecoverDraft,
  type Step,
} from '../../onboarding/state';
import { generateNewMnemonic } from '../../hooks/useOnboarding';
import { Welcome } from './welcome';
import { ModeChoice } from './mode_choice';
import { OwnerName } from './owner_name';
import { HandlePicker } from './handle_pick';
import { PassphraseSet } from './passphrase_set';
import { MnemonicReveal } from './mnemonic_reveal';
import { MnemonicVerify } from './mnemonic_verify';
import { RecoveryEntry } from './recovery_entry';
import { Provisioning } from './provisioning';

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
          onBack={goBack}
          onContinue={(handle) =>
            setStep({
              kind: 'create_passphrase',
              draft: { ...step.draft, handle },
            })
          }
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
          onVerified={() => {
            const complete: CreateDraft = {
              ownerName: step.draft.ownerName ?? 'Dina',
              handle: step.draft.handle ?? '',
              passphrase: step.draft.passphrase ?? '',
              startupMode: step.draft.startupMode ?? 'auto',
              mnemonic: step.draft.mnemonic ?? [],
            };
            setStep({ kind: 'provisioning_create', draft: complete });
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
          }}
          onDone={() => {
            // `unlock()` inside provisionIdentity flips isUnlocked → true;
            // UnlockGate's subscriber renders `children` on its next
            // render, swapping this whole tree out. No-op here beyond
            // optional telemetry.
          }}
          onError={(message) => setStep({ kind: 'error', message, retry: { kind: 'choose' } })}
        />
      );

    case 'recover_mnemonic':
      return (
        <RecoveryEntry
          initialWords={step.draft.mnemonic}
          onBack={goBack}
          onContinue={(words, did) =>
            setStep({
              kind: 'recover_passphrase',
              draft: { ...step.draft, mnemonic: words, expectedDid: did },
            })
          }
        />
      );

    case 'recover_passphrase':
      return (
        <PassphraseSet
          initialPassphrase={step.draft.passphrase}
          initialMode={step.draft.startupMode ?? 'auto'}
          onBack={goBack}
          onContinue={(passphrase, mode) => {
            const complete: RecoverDraft = {
              mnemonic: step.draft.mnemonic ?? [],
              expectedDid: step.draft.expectedDid ?? '',
              passphrase,
              startupMode: mode,
            };
            setStep({ kind: 'provisioning_recover', draft: complete });
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
