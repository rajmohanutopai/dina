/**
 * Plugin substrate — core-side barrel (docs/PLUGIN_ARCHITECTURE.md).
 * The wire contract lives in @dina/protocol; this package owns the
 * dynamic registry, grants, decisions, and (via workflow/) the
 * hardened execution lane.
 */

export {
  SQLitePluginInstallRepository,
  setPluginInstallRepository,
  getPluginInstallRepository,
} from './registry';
export type {
  PluginInstall,
  PluginInstallRepository,
  PluginInstallStatus,
  PluginPendingDecision,
} from './registry';

export {
  SQLitePluginGrantRepository,
  setPluginGrantRepository,
  getPluginGrantRepository,
  parseConstraints,
  hasMeaningfulConstraint,
  CONSTRAINT_CEILINGS,
} from './grants';
export type {
  PluginGrant,
  PluginGrantRepository,
  PluginGrantType,
  PluginGrantConstraints,
  GrantCheckResult,
  GrantDenialReason,
  AuthorizeArgs,
} from './grants';

export {
  SQLitePluginDecisionRepository,
  setPluginDecisionRepository,
  getPluginDecisionRepository,
} from './decisions';
export type { PluginDecision, PluginDecisionKind, PluginDecisionRepository } from './decisions';

// Round-5 #1: `beginInstallVerified` + `attestVerifiedRelease` are DELIBERATELY
// NOT re-exported on the package surface. A verification attestation is only
// provenance if the module that mints it is the one that verified — exporting
// the constructor to every `@dina/core` consumer would let any caller forge a
// `repo_proof` attestation without running the repo-proof verifier. The public
// install door is `beginInstall` (which runs the injected verifier). The
// "already-verified" entry stays internal to this package (tests + the future
// invite-bootstrap/debug caller import it directly from `install_service`).
export {
  beginInstall,
  confirmConsent,
  declineConsent,
  uninstall,
  sweepAbandonedInstalls,
  terminateInstallInFlight,
  setRepoProofVerifier,
  setPluginDeviceVerifier,
  NODE_SUPPORTED_FEATURES,
  PENDING_INSTALL_TTL_SEC,
} from './install_service';
export type {
  BeginInstallResult,
  InstallFailure,
  InstallPendingResult,
  PluginTeardownResult,
  VerifyPluginDevice,
} from './install_service';

export { claimPluginTask, STALE_AUTHORITY } from './claim_guard';
export type { PluginClaimResult } from './claim_guard';

export {
  assessParamsEgress,
  decideDispatch,
  buildPluginEnvelope,
  contextScopeViolation,
  validatePluginResult,
} from './dispatch';
export type {
  ParamsEgressAssessment,
  DispatchMode,
  DispatchDecision,
  PluginResultValidation,
} from './dispatch';
export { validateAgainstSchema } from './schema_validate';
export type { SchemaValidationResult } from './schema_validate';
