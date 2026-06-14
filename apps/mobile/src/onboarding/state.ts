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
  /**
   * Full handle picked in the `create_handle` step (e.g.
   * `raju.pds.dinakernel.com`). Carried through to provisioning so the
   * PLC genesis op stamps the chosen handle in `alsoKnownAs` instead of
   * the silent always-suffix derivation that ran before the wizard
   * step existed.
   */
  handle: string;
  passphrase: string;
  startupMode: StartupMode;
  mnemonic: string[];
}

/** Final slot carried through recover → handle → passphrase → provisioning. */
export interface RecoverDraft {
  mnemonic: string[];
  /**
   * `did:key:…` derived locally from the mnemonic — used to populate
   * the `recover_handle` step's "verify rotation key" check before we
   * ever leave the device. Once the handle is supplied and resolved
   * to a `did:plc:…`, that PLC value supersedes this preview in the
   * `expectedDid` field below.
   */
  derivedDidKey: string;
  /**
   * The user's published Dina handle (e.g. `alonso77.test-pds.dinakernel.com`).
   * Captured in the `recover_handle` step so we can call PDS
   * `resolveHandle` and re-bind the device to the existing did:plc.
   */
  handle: string;
  /**
   * The `did:plc:…` resolved from the handle and verified to list our
   * K256 rotation key in `rotationKeys`. Empty until the handle step
   * completes; provisioning_recover requires it non-empty.
   */
  expectedDid: string;
  passphrase: string;
  startupMode: StartupMode;
}

/** Final slot carried through existing AT Protocol identity onboarding. */
export interface ExternalAtprotoDraft {
  /** Bluesky / AT Protocol handle or did:plc to LINK (resolved read-only). */
  identifier: string;
  /** Set when control was PROVEN via "Login with Bluesky" (OAuth). */
  verifiedLink?: { did: string; handle: string | null; pdsUrl: string };
  passphrase: string;
  startupMode: StartupMode;
  mnemonic: string[];
}

export type Step =
  | { kind: 'welcome' }
  | { kind: 'choose' }
  // Create path ----------------------------------------------------------
  | { kind: 'create_name'; draft: Partial<CreateDraft> }
  // `error` is set when provisioning bounced back here (e.g. the PDS
  // rejected the handle); the picker surfaces it inline.
  | { kind: 'create_handle'; draft: Partial<CreateDraft>; error?: string }
  | { kind: 'create_passphrase'; draft: Partial<CreateDraft> }
  | { kind: 'create_mnemonic_reveal'; draft: Partial<CreateDraft> }
  | { kind: 'create_mnemonic_verify'; draft: Partial<CreateDraft> }
  | { kind: 'provisioning_create'; draft: CreateDraft }
  // Recover path --------------------------------------------------------
  | { kind: 'recover_mnemonic'; draft: Partial<RecoverDraft> }
  | { kind: 'recover_handle'; draft: Partial<RecoverDraft> }
  | { kind: 'recover_passphrase'; draft: Partial<RecoverDraft> }
  | { kind: 'provisioning_recover'; draft: RecoverDraft }
  // Existing AT Protocol identity path -------------------------------
  | { kind: 'external_identity'; draft: Partial<ExternalAtprotoDraft> }
  | { kind: 'external_passphrase'; draft: Partial<ExternalAtprotoDraft> }
  | { kind: 'external_mnemonic_reveal'; draft: Partial<ExternalAtprotoDraft> }
  | { kind: 'external_mnemonic_verify'; draft: Partial<ExternalAtprotoDraft> }
  | { kind: 'provisioning_external'; draft: ExternalAtprotoDraft }
  // Shared mandatory AI-provider step -----------------------------------
  // Inserted before provisioning in every flow: the app is unusable
  // without a working LLM key, so onboarding requires one before the
  // vault unlocks. `next` is the provisioning step to run once a key is
  // connected; `back` + `location` are carried so this shared step renders
  // correctly regardless of which flow funnelled into it.
  | { kind: 'ai_provider'; next: Step; back: Step; location: StepLocation }
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
    // Recovery-phrase reveal/verify are no longer in the create path (the
    // phrase is generated silently + backed up later via the deferred prompt),
    // so the create flow is 5 steps: name, handle, passphrase, AI, setting up.
    case 'create_name':
      return { current: 1, total: 5, label: 'Your name' };
    case 'create_handle':
      return { current: 2, total: 5, label: 'Pick a handle' };
    case 'create_passphrase':
      return { current: 3, total: 5, label: 'Passphrase' };
    // Unreachable in the live flow (kept for the type union); the AI step
    // carries {4,5} and provisioning {5,5}.
    case 'create_mnemonic_reveal':
      return { current: 4, total: 5, label: 'Recovery phrase' };
    case 'create_mnemonic_verify':
      return { current: 4, total: 5, label: 'Confirm phrase' };
    case 'provisioning_create':
      return { current: 5, total: 5, label: 'Setting up' };
    case 'recover_mnemonic':
      return { current: 1, total: 5, label: 'Recovery phrase' };
    case 'recover_handle':
      return { current: 2, total: 5, label: 'Your handle' };
    case 'recover_passphrase':
      return { current: 3, total: 5, label: 'New passphrase' };
    case 'provisioning_recover':
      return { current: 5, total: 5, label: 'Restoring' };
    // External (link existing ATProto) is now 4 steps: identity, local vault,
    // AI, connecting — recovery-phrase reveal/verify removed (silent + deferred).
    case 'external_identity':
      return { current: 1, total: 4, label: 'Existing identity' };
    case 'external_passphrase':
      return { current: 2, total: 4, label: 'Local vault' };
    // Unreachable in the live flow; AI carries {3,4}, provisioning {4,4}.
    case 'external_mnemonic_reveal':
      return { current: 3, total: 4, label: 'Recovery phrase' };
    case 'external_mnemonic_verify':
      return { current: 3, total: 4, label: 'Confirm phrase' };
    case 'provisioning_external':
      return { current: 4, total: 4, label: 'Connecting' };
    // Shared AI step — carries the right "N of M" for whichever flow it's in.
    case 'ai_provider':
      return step.location;
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
      return null;
    case 'choose':
      return { kind: 'welcome' };
    case 'create_name':
      return { kind: 'choose' };
    case 'create_handle':
      return { kind: 'create_name', draft: step.draft };
    case 'create_passphrase':
      return { kind: 'create_handle', draft: step.draft };
    case 'create_mnemonic_reveal':
      return { kind: 'create_passphrase', draft: step.draft };
    case 'create_mnemonic_verify':
      return { kind: 'create_mnemonic_reveal', draft: step.draft };
    case 'provisioning_create':
      return null;
    case 'recover_mnemonic':
      return { kind: 'choose' };
    case 'recover_handle':
      return { kind: 'recover_mnemonic', draft: step.draft };
    case 'recover_passphrase':
      return { kind: 'recover_handle', draft: step.draft };
    case 'provisioning_recover':
      return null;
    case 'external_identity':
      return { kind: 'choose' };
    case 'external_passphrase':
      return { kind: 'external_identity', draft: step.draft };
    case 'external_mnemonic_reveal':
      return { kind: 'external_passphrase', draft: step.draft };
    case 'external_mnemonic_verify':
      return { kind: 'external_mnemonic_reveal', draft: step.draft };
    case 'provisioning_external':
      return null;
    case 'ai_provider':
      return step.back;
    case 'error':
      return step.retry;
  }
}
