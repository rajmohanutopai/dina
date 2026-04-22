/**
 * @dina/test-harness — public API
 *
 * Everything tests need to import from a single package:
 * - Port interfaces (contracts for mocks and real implementations)
 * - Test constants (byte arrays, strings, params from Go fixtures.go)
 * - Fixture loader (loads JSON test vectors from packages/fixtures/)
 * - Byte/hex utilities (conversion for fixture comparison)
 * - Custom assertions (domain-specific test helpers)
 * - Factory functions (create valid test data with overrides)
 * - Mock implementations (record calls, configurable returns)
 * - HTTP test harnesses (in-memory Core and Brain servers)
 */

// Port interfaces
export * from './ports';

// Domain errors (shared by production code and mocks)
export {
  NotImplementedError,
  PersonaLockedError,
  NotFoundError,
  ForbiddenError,
  ApprovalRequiredError,
  PIIScrubError,
  CoreUnreachableError,
} from './errors';

// Test constants (Go fixtures.go equivalents)
export * from './fixtures/constants';

// Fixture loader
export {
  loadFixture,
  loadVectors,
  hasFixture,
  describeWithFixture,
  assertFixtureExists,
} from './fixtures/loader';
export type {
  FixtureFile,
  FixtureVector,
  CryptoDerivationInput,
  CryptoDerivationExpected,
  HKDFInput,
  HKDFExpected,
  Argon2idInput,
  Argon2idExpected,
  AESGCMInput,
  AESGCMExpected,
  Ed25519SignInput,
  Ed25519SignExpected,
  CanonicalPayloadInput,
  CanonicalPayloadExpected,
  PIIPatternInput,
  PIIPatternExpected,
  GatekeeperIntentInput,
  GatekeeperIntentExpected,
  StagingTransitionInput,
  StagingTransitionExpected,
  AuditChainInput,
  AuditChainExpected,
} from './fixtures/loader';

// Byte/hex utilities
export {
  hexToBytes,
  bytesToHex,
  bytesEqual,
  isAllZero,
  stringToBytes,
  bytesToString,
} from './helpers/bytes';

// Custom assertions (standalone functions — work without Jest setup)
export {
  expectBytesEqual,
  expectBytesNotEqual,
  expectBytesLength,
  expectHexEqual,
  expectPrefix,
  expectContains,
  expectAsyncThrows,
  expectNotAllZero,
} from './helpers/assertions';

// Jest custom matchers (register with expect.extend(dinaMatchers))
export { dinaMatchers } from './helpers/matchers';

// Unhandled-promise-rejection guard (task 11.8)
export {
  UnhandledRejectionBuffer,
  installUnhandledRejectionGuard,
} from './helpers/unhandled-rejection';

// Factory functions
export {
  makeVaultItem,
  makeVaultItems,
  makeStagingItem,
  makeTask,
  makeReminder,
  makeContact,
  makeOutboxMessage,
  makeApprovalRequest,
  makeSafeIntent,
  makeRiskyIntent,
  makeBlockedIntent,
  makeDinaMessage,
  makeTrustEntry,
  makeEvent,
  makeFiduciaryEvent,
  makeSolicitedEvent,
  makeEngagementEvent,
  makeSearchQuery,
  makePIIText,
  makeScrubResult,
  makePairedDevice,
  resetFactoryCounters,
} from './factories';
export type { GuardianEvent } from './factories';

// Mock implementations
export {
  MockSigner,
  MockHDKeyDeriver,
  MockVaultDEKDeriver,
  MockEncryptor,
  MockDIDManager,
  MockPersonaManager,
  MockVaultManager,
  MockVaultReader,
  MockVaultWriter,
  MockGatekeeper,
  MockSignatureValidator,
  MockRateLimiter,
  MockPIIScrubber,
  MockBrainClient,
  MockOutboxManager,
  MockTaskQueue,
  MockCrashLogger,
  MockTrustCache,
  MockWSHub,
  MockKeyWrapper,
  MockKEKDeriver,
  MockKeyConverter,
  MockInboxManager,
  MockScratchpadManager,
  MockVaultAuditLogger,
  MockStagingInbox,
  MockReminderScheduler,
  MockContactDirectory,
  MockContactAliasStore,
  MockDeviceRegistry,
  MockApprovalManager,
  MockSharingPolicyManager,
  MockScenarioPolicyManager,
  MockPIIDeSanitizer,
  MockServiceKeyRegistrar,
  MockDeviceKeyRegistrar,
  MockCoreClient,
} from './mocks';
export type { RecordedCall, CoreClientMethodName } from './mocks';

// HTTP test harnesses
// HTTP test harnesses (real servers on localhost)
export { TestHTTPServer, Router } from './harnesses/http-server';
export { CoreTestHarness } from './harnesses/core';
export type {
  CoreTestHarnessConfig,
  RequestOptions,
  TestResponse,
  RequestSigner,
  RouteRegistrar,
} from './harnesses/core';
export { BrainTestHarness } from './harnesses/brain';
export type {
  BrainTestHarnessConfig,
  BrainRequestOptions,
  BrainTestResponse,
  BrainCallerRole,
  BrainRouteRegistrar,
} from './harnesses/brain';
