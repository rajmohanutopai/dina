/**
 * Onboarding state machine.
 *
 * One discriminated union drives the whole flow so every screen knows
 * exactly what data is in scope + what transitions are valid from here.
 * The root orchestrator (`OnboardingFlow`) owns a single `useState<Step>`
 * and passes the step + setter to each screen; screens call the
 * transition helpers at the bottom of this file rather than constructing
 * new state objects inline.
 *
 * Passphrase lives in state transiently — we never persist it, and it's
 * cleared from state as soon as `provisionIdentity` returns.
 */

export type StartupMode = 'auto' | 'manual';

/** Final slot carried through create → mnemonic → provisioning. */
export interface CreateDraft {
  ownerName: string;
  passphrase: string;
  startupMode: StartupMode;
  mnemonic: string[];
}

/** Final slot carried through recover → passphrase → provisioning. */
export interface RecoverDraft {
  mnemonic: string[];
  expectedDid: string; // did:plc:... derived from the mnemonic locally
  passphrase: string;
  startupMode: StartupMode;
}

export type Step =
  | { kind: 'welcome' }
  | { kind: 'choose' }
  // Create path ----------------------------------------------------------
  | { kind: 'create_name'; draft: Partial<CreateDraft> }
  | { kind: 'create_passphrase'; draft: Partial<CreateDraft> }
  | { kind: 'create_mnemonic_reveal'; draft: Partial<CreateDraft> }
  | { kind: 'create_mnemonic_verify'; draft: Partial<CreateDraft> }
  | { kind: 'provisioning_create'; draft: CreateDraft }
  // Recover path --------------------------------------------------------
  | { kind: 'recover_mnemonic'; draft: Partial<RecoverDraft> }
  | { kind: 'recover_passphrase'; draft: Partial<RecoverDraft> }
  | { kind: 'provisioning_recover'; draft: RecoverDraft }
  // Terminal ------------------------------------------------------------
  | { kind: 'error'; message: string; retry: Step };

export const INITIAL_STEP: Step = { kind: 'welcome' };

// ---------------------------------------------------------------------------
// Progress helper — the shared shell shows "Step N of 6" on every non-
// terminal screen so the user has a sense of how far they've come.
// ---------------------------------------------------------------------------

export interface StepLocation {
  current: number;
  total: number;
  label: string;
}

export function locateStep(step: Step): StepLocation | null {
  switch (step.kind) {
    case 'welcome':
      return null;
    case 'choose':
      return null;
    case 'create_name':
      return { current: 1, total: 5, label: 'Your name' };
    case 'create_passphrase':
      return { current: 2, total: 5, label: 'Passphrase' };
    case 'create_mnemonic_reveal':
      return { current: 3, total: 5, label: 'Recovery phrase' };
    case 'create_mnemonic_verify':
      return { current: 4, total: 5, label: 'Confirm phrase' };
    case 'provisioning_create':
      return { current: 5, total: 5, label: 'Setting up' };
    case 'recover_mnemonic':
      return { current: 1, total: 3, label: 'Recovery phrase' };
    case 'recover_passphrase':
      return { current: 2, total: 3, label: 'New passphrase' };
    case 'provisioning_recover':
      return { current: 3, total: 3, label: 'Restoring' };
    case 'error':
      return null;
  }
}

/**
 * Ordered list of steps a "Back" button walks through. Returns the
 * previous step OR `null` if there's nowhere to go back to.
 *
 * Back from `provisioning_*` is intentionally null — once the PLC POST
 * has fired we can't walk it back, and going back mid-provision would
 * leave a half-registered did:plc floating.
 */
export function previousStep(step: Step): Step | null {
  switch (step.kind) {
    case 'welcome':
    case 'choose':
      return null;
    case 'create_name':
      return { kind: 'choose' };
    case 'create_passphrase':
      return { kind: 'create_name', draft: step.draft };
    case 'create_mnemonic_reveal':
      return { kind: 'create_passphrase', draft: step.draft };
    case 'create_mnemonic_verify':
      return { kind: 'create_mnemonic_reveal', draft: step.draft };
    case 'provisioning_create':
      return null;
    case 'recover_mnemonic':
      return { kind: 'choose' };
    case 'recover_passphrase':
      return { kind: 'recover_mnemonic', draft: step.draft };
    case 'provisioning_recover':
      return null;
    case 'error':
      return step.retry;
  }
}
