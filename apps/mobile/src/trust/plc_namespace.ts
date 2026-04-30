/**
 * Mobile facade for the PLC namespace-update composer (TN-IDENT-005).
 *
 * The implementation lives in `@dina/core/identity/plc_namespace_update`
 * — pure, runtime-agnostic, zero mobile-specific concerns. This file
 * re-exports the public surface so mobile callers (compose flows, the
 * Trust Network namespace screen) have a single, mobile-scoped import
 * path:
 *
 *     import { composeAndSignNamespaceUpdate } from '@/trust/plc_namespace';
 *
 * Submission to the PLC directory (network I/O, retry + backoff) is
 * the concern of TN-IDENT-006 and lives in a sibling module.
 *
 * Why a facade rather than a direct `@dina/core` import at every
 * call site: the trust UI grows several mobile-specific helpers
 * around the pure composer (e.g. resolving the user's current PLC op
 * via the local AppView client, displaying a confirm-then-sign sheet
 * before invoking `composeAndSignNamespaceUpdate`). Co-locating those
 * with the re-exports keeps the ergonomics one import deep.
 */

export {
  cidForOperation,
  namespaceFragment,
  composeNamespaceUpdate,
  composeAndSignNamespaceUpdate,
  composeNamespaceDisable,
  composeAndSignNamespaceDisable,
  submitPlcOperation,
  computePLCBackoff,
  PLCSubmitError,
  DEFAULT_MAX_ATTEMPTS as PLC_DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_BASE_MS as PLC_DEFAULT_BACKOFF_BASE_MS,
  createNamespace,
  nextAvailableNamespaceIndex,
} from '@dina/core';
export type {
  ComposeNamespaceUpdateParams,
  ComposedNamespaceUpdate,
  ComposeAndSignNamespaceUpdateParams,
  SignedNamespaceUpdate,
  ComposeNamespaceDisableParams,
  ComposedNamespaceDisable,
  ComposeAndSignNamespaceDisableParams,
  SignedNamespaceDisable,
  SubmitPlcOperationParams,
  SubmitPlcOperationConfig,
  SubmitPlcOperationResult,
  CreateNamespaceFlowParams,
  CreateNamespaceFlowResult,
} from '@dina/core';
