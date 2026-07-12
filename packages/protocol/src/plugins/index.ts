/**
 * Plugin wire layer — barrel (docs/PLUGIN_ARCHITECTURE.md).
 */

export {
  PLUGIN_NSIDS,
  PLUGIN_KINDS,
  PLUGIN_OPS,
  PLUGIN_CAPS,
  PLUGIN_BANNED_CATEGORIES,
  PLUGIN_LANE_PREFIX,
  pluginLane,
  isPluginLane,
  installIdFromLane,
} from './types';
export type {
  PluginExecutionMode,
  PluginKind,
  PluginInteraction,
  PluginIdempotency,
  PluginAdvisorySeverity,
  PluginOp,
  PluginRuntimeArtifacts,
  PluginRuntimeIssuer,
  PluginSelfHost,
  PluginRuntime,
  PluginExecution,
  PluginMachineTransition,
  PluginMachine,
  PluginEffects,
  PluginDataScope,
  PluginCapabilityDecl,
  PluginManifest,
  PluginIdentityRecord,
  PluginAdvisory,
} from './types';

export {
  normalizeStringSet,
  normalizePluginManifest,
  normalizePluginAdvisory,
} from './normalize';

export {
  validatePluginManifest,
  schemaDepth,
  hasRecursiveRef,
  findSecretFields,
} from './validate';
export type {
  PluginValidationError,
  PluginValidationOk,
  PluginValidationFail,
  PluginValidationResult,
  ValidatePluginManifestOptions,
} from './validate';

export {
  canonicalJson,
  scopeHashInput,
  behaviorHashInput,
  presentationHashInput,
  computePluginDigests,
} from './digests';
export type { Sha256Fn, PluginDigests } from './digests';

export {
  base32Encode,
  base32Decode,
  sha256DigestFromCid,
  releaseRkeyFromCid,
  isValidReleaseRkey,
} from './release_rkey';

export {
  repoProofFailure,
  checkIdentityPointer,
  checkReleaseIntegrity,
  parseAtUri,
} from './verifier';
export type {
  PluginTrustAnchor,
  RepoProofFailureCode,
  RepoProofRequest,
  RepoProofSuccess,
  RepoProofFailure,
  RepoProofResult,
  RepoProofVerifier,
  IdentityPointerCheckInput,
  IdentityPointerViolation,
  ParsedAtUri,
} from './verifier';
