/**
 * Storage initialization for core-server.
 *
 * Mirrors `apps/mobile/src/storage/init.ts` for the Node runtime:
 * derive identity + persona DEKs from the master seed, open the
 * SQLCipher identity database via `@dina/storage-node`, run identity
 * + persona migrations, then wire every identity-scoped repository
 * the Core HTTP surface reads/writes through.
 *
 * Called once at boot, after `loadOrGenerateSeed` returns the master
 * seed. Until this runs the in-memory inbox fallbacks accept writes
 * but lose them on restart — so a `/remember` chat round-trip
 * succeeds at the HTTP layer but its vault row never persists.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  createPersona,
  getNodeDID,
  getPersonaTier,
  hydratePersonas,
  listPersonas,
  personaExists,
  RunService,
  SQLiteClassificationJobRepository,
  SQLiteCommandReceiptRepository,
  ExtensionOperationRegistry,
  registerCommerceHostOperations,
  SQLiteDrainAuthorizationRepository,
  createCommerceRuntime,
  installHeldEvidenceReader,
  makeHeldEvidenceVerifier,
  makeHeldEvidenceReader,
  endpointsFromSupplierSettings,
  getCommerceRuntime,
  makeConnectorExecutors,
  installBuyerOrderSender,
  installBuyerAuthorityProvider,
  singleOwnerAuthority,
  installCommerceServiceQueryDispatch,
  installCatalogFeedTransport,
  makeServiceQueryBuyerSender,
  installCommerceRuntime,
  getCommerceEpochService,
  SQLiteCompletionReceiptRepository,
  SQLiteErasureKeyStore,
  SQLiteMessageRepository,
  SQLiteReservationRepository,
  SQLiteReviewPublishRepository,
  SQLiteRunRepository,
  SQLiteServiceConfigRepository,
  SQLiteD2DOutboxRepository,
  SQLiteAgentGrantRepository,
  SQLiteAgentGatingPolicyRepository,
  getAgentGrantRepository,
  getReasoningContextRepository,
  SessionRegistry,
  SQLiteSessionRepository,
  setSessionRegistry,
  revokeSessionApprovals,
  hydrateContactDirectory,
  hydrateServiceConfig,
  recoverOutboxOnBoot,
  reconcileDefaultAgentGatingPolicies,
  registerPersonaDEK,
  setAgentGrantRepository,
  setAgentGatingPolicyRepository,
  setAgentPersonaUnlockHook,
  setArchiveDataSource,
  SQLitePushSubscriptionRepository,
  setClassificationJobRepository,
  setCommandReceiptRepository,
  setDrainAuthorizationRepository,
  setUpdateRebindCoordinator,
  tier0TxRunner,
  UpdateRebindCoordinator,
  getDrainAuthorizationRepository,
  rebindListingsForUpdate,
  createPluginHostRuntime,
  gateCatalogForPublication,
  getPluginGrantRepository,
  getPluginInstallRepository,
  installPluginHostRuntime,
  makeConnectorBrokerOperation,
  makeD2DSendOperation,
  makePublicationCandidateOperation,
  permittedD2DRecipients,
  SUPPLIER_REFERENCE_MANIFEST,
  setExtensionOperationRegistry,
  setCommandTxRunner,
  setCompletionReceiptRepository,
  setD2DOutboxRepository,
  setPushSubscriptionRepository,
  setErasureKeyStore,
  setMessageRepository,
  setPluginDeviceVerifier,
  setReservationRepository,
  setReviewPublishRepository,
  setRunRepository,
  setRunService,
  setPersonaDescription,
  setServiceConfigRepository,
  setNotificationLogRepository,
  SqliteNotificationLogRepository,
  type ArchivePersonaSource,
  type PersonaTier,
} from '@dina/core';
import { getD2DSender } from '@dina/core/d2d';
import { getDeviceByDID, listActiveDevices } from '@dina/core/devices';
import { hydrateDeviceRegistry } from '@dina/core/runtime';
import {
  SQLiteAuditRepository,
  hydrateAuditState,
  sweepRetention,
  SQLiteChatMessageRepository,
  SQLiteContactRepository,
  SQLiteServiceOfferRepository,
  SQLiteServiceDecisionRepository,
  SQLiteServiceGrantRepository,
  SQLitePluginInstallRepository,
  SQLitePluginGrantRepository,
  SQLitePluginDecisionRepository,
  setPluginInstallRepository,
  setPluginGrantRepository,
  setPluginDecisionRepository,
  SQLiteDeviceRepository,
  SQLiteKVRepository,
  SQLitePeopleRepository,
  SQLitePersonaRepository,
  SQLiteReminderRepository,
  SQLiteReasoningBackendRepository,
  SQLiteReasoningContextRepository,
  SQLiteStagingRepository,
  SQLiteTopicRepository,
  SQLiteVaultRepository,
  bootstrapPersistence,
  hydrateRemindersFromRepo,
  hydrateStagingFromRepository,
  openPersonaVault,
  setAuditRepository,
  setChatMessageRepository,
  setContactRepository,
  setServiceOfferRepository,
  setServiceDecisionRepository,
  setServiceGrantRepository,
  setDeviceRepository,
  setKVRepository,
  setPeopleRepository,
  setPersonaRepository,
  setReminderRepository,
  setReasoningBackendRepository,
  setReasoningContextRepository,
  setStagingRepository,
  setTopicRepository,
  setVaultRepository,
  type DatabaseAdapter,
} from '@dina/core/storage';
import { NodeDBProvider } from '@dina/storage-node';

import { nodeAuthedTransport } from '../commerce/connector_transport';

import type { Logger } from '../logger';
import type { ServiceQueryBody } from '@dina/protocol';

/**
 * Default personas seeded on first boot. Mirrors
 * `apps/mobile/src/onboarding/default_personas.ts` so the LLM-driven
 * persona classifier sees the same descriptions on either runtime.
 */
const DEFAULT_PERSONAS: readonly {
  name: string;
  tier: 'default' | 'standard' | 'sensitive' | 'locked';
  description: string;
}[] = [
  {
    name: 'general',
    tier: 'default',
    description:
      'Personal facts, preferences, family, relationships, hobbies, recipes, pets, birthdays, daily life, opinions',
  },
  {
    name: 'work',
    tier: 'standard',
    description:
      'Professional context, meetings, colleagues, deadlines, projects, office logistics, career',
  },
  {
    name: 'health',
    tier: 'sensitive',
    description:
      'Medical records, diagnoses, prescriptions, lab results, doctor visits, symptoms, allergies, medications, vital signs',
  },
  {
    name: 'finance',
    tier: 'sensitive',
    description:
      'Bank accounts, investments, bills, rent, salary, tax, loans, insurance, financial planning',
  },
];

const RESTORE_VALID_TIERS: ReadonlySet<string> = new Set([
  'default',
  'standard',
  'sensitive',
  'locked',
]);

function restoreTier(tier: string): PersonaTier {
  return (RESTORE_VALID_TIERS.has(tier) ? tier : 'locked') as PersonaTier;
}

export interface StorageInitResult {
  /** The provider instance — callers such as the archive tool also close it. */
  provider: NodeDBProvider;
  /** The identity DB adapter — needed for any future identity-scoped wiring. */
  identityDB: DatabaseAdapter;
  /** Personas that were opened (default + standard tier). */
  openedPersonas: string[];
}

/**
 * Initialize SQLite persistence + wire every identity-scoped
 * repository. Idempotent for the personas that already exist.
 *
 * Identity DEK and per-persona DEKs are derived from `masterSeed`
 * via HKDF-SHA256 with a constant zero-salt:
 *
 *   identityDEK = HKDF(sha256, masterSeed[:32], 0, "dina:vault:identity:v1", 32)
 *   personaDEK  = HKDF(sha256, masterSeed[:32], 0, "dina:vault:<name>:v1",  32)
 *
 * The lite stack is single-tenant; the per-install salt that mobile's
 * `derivePersonaDEK(masterSeed, persona, userSalt)` requires would
 * mostly be a constant here, so we collapse that to a zero salt.
 * Identical seed → identical DEKs across restarts (the desired
 * property — restart must open the same vault).
 */
export async function initializeStorage(
  masterSeed: Uint8Array,
  vaultDir: string,
  logger: Logger,
): Promise<StorageInitResult> {
  if (masterSeed.length < 32) {
    throw new Error(`initializeStorage: master seed too short (${masterSeed.length}, need ≥32)`);
  }
  const seed32 = masterSeed.slice(0, 32);

  const encoder = new TextEncoder();
  const identityDekHex = bytesToHex(
    hkdf(sha256, seed32, new Uint8Array(32), encoder.encode('dina:vault:identity:v1'), 32),
  );
  const resolvePersonaDekHex = async (persona: string): Promise<string> => {
    const dek = hkdf(
      sha256,
      seed32,
      new Uint8Array(32),
      encoder.encode(`dina:vault:${persona}:v1`),
      32,
    );
    // ISVC-10/R5-01 — register the DEK with the orchestrator so the run
    // plane's persona-open predicate (`hasDEK`) and payload cipher
    // (`wrapWithPersonaDEK`) see this vault as open. The registry takes
    // ownership of a copy (zeroed on release); the hex string feeds SQLCipher.
    registerPersonaDEK(persona, dek.slice());
    return bytesToHex(dek);
  };

  const provider = new NodeDBProvider({
    vaultDir,
    identityDekHex,
    resolvePersonaDekHex,
  });

  const identityDB = await bootstrapPersistence(provider);
  logger.info({ vaultDir }, 'identity SQLite opened + migrated');

  // Wire every identity-scoped repository the Core HTTP surface uses.
  setKVRepository(new SQLiteKVRepository(identityDB));
  // User-created personas are part of the durable identity catalog. Hydrate
  // them before seeding/opening the built-ins below so custom vaults survive
  // process restarts and participate in archive export.
  setPersonaRepository(new SQLitePersonaRepository(identityDB));
  hydratePersonas();
  setContactRepository(new SQLiteContactRepository(identityDB));
  setServiceOfferRepository(new SQLiteServiceOfferRepository(identityDB));
  setServiceDecisionRepository(new SQLiteServiceDecisionRepository(identityDB));
  setServiceGrantRepository(new SQLiteServiceGrantRepository(identityDB));
  // Plugin dynamic registry (PLUGIN_ARCHITECTURE.md §6): installs +
  // grants (constraints, per-execution consumption) + owner-private
  // decision log.
  setPluginInstallRepository(new SQLitePluginInstallRepository(identityDB));
  setPluginGrantRepository(new SQLitePluginGrantRepository(identityDB));
  setPluginDecisionRepository(new SQLitePluginDecisionRepository(identityDB));
  setReminderRepository(new SQLiteReminderRepository(identityDB));
  // R4-03 — the durable notification log (identity.sqlite). On the split server
  // Core owns it; Brain reaches it over the `/v1/notifications` routes so its
  // inbox dual-write survives restart here too.
  setNotificationLogRepository(new SqliteNotificationLogRepository(identityDB));
  const auditRepository = new SQLiteAuditRepository(identityDB);
  setAuditRepository(auditRepository);
  hydrateAuditState(auditRepository);
  sweepRetention();
  setDeviceRepository(new SQLiteDeviceRepository(identityDB));
  // Round-8 #2: wire the agent-grant repo BEFORE hydrating devices —
  // `hydrateDeviceRegistry` runs the boot reconciler, which must be able to
  // revoke a crash-orphaned revoked device's AGENT persona grants (not only its
  // plugin authority). Wiring it after hydrate left that half unreconciled.
  setAgentGrantRepository(new SQLiteAgentGrantRepository(identityDB));
  setAgentGatingPolicyRepository(new SQLiteAgentGatingPolicyRepository(identityDB));
  setReasoningBackendRepository(new SQLiteReasoningBackendRepository(identityDB));
  setReasoningContextRepository(new SQLiteReasoningContextRepository(identityDB));
  // Item D — durable coding-agent sessions. Back the SessionRegistry with the
  // identity SQLite store and reconcile on boot so a session (Claude Code /
  // Codex) survives a Core restart, and any session whose lease lapsed while
  // Core was down is reaped. `setSessionRegistry` replaces the auto-provisioned
  // in-memory global that every /v1/session route + the coding gate read.
  const sessionRegistry = new SessionRegistry(
    undefined,
    (session) => {
      const now = Date.now();
      try {
        getAgentGrantRepository()?.revokeForSession(session.agentDid, session.sessionId, now);
      } catch {
        // The durable session tombstone is already committed, so this grant is
        // inert even if cleanup fails. Keep boot/runtime available and surface a
        // PII-safe diagnostic rather than logging the DID or host-session name.
        logger.error({ sessionId: session.sessionId }, 'session grant cleanup failed');
      } finally {
        try {
          getReasoningContextRepository()?.revokeTicketsForSession(session.sessionId, now);
        } catch {
          logger.error({ sessionId: session.sessionId }, 'reasoning ticket cleanup failed');
        }
        revokeSessionApprovals(session.agentDid, session.sessionId);
      }
    },
    new SQLiteSessionRepository(identityDB),
  );
  sessionRegistry.reconcile();
  setSessionRegistry(sessionRegistry);
  // Pull every previously-paired device back into the in-memory
  // registry. Without this, every signed call from a paired agent
  // (workflow claim, service.query) lands as caller-type 'unknown'
  // and 403s. Matches mobile's boot_capabilities.ts.
  await hydrateDeviceRegistry();
  const ownerDid = getNodeDID();
  if (ownerDid === null) {
    logger.warn('coding-agent Standard profile reconciliation skipped: owner identity unavailable');
  } else {
    const policies = reconcileDefaultAgentGatingPolicies(ownerDid, listActiveDevices());
    if (policies.created > 0) {
      logger.info({ count: policies.created }, 'created missing coding-agent Standard profiles');
    }
    if (policies.failed > 0) {
      // Missing/corrupt rows continue to resolve as Full Supervision.
      logger.warn({ count: policies.failed }, 'coding-agent profile reconciliation failed');
    }
  }

  // PLG-29 #7: a runner plugin can only activate on a device that is a REAL,
  // unrevoked, role='plugin' registry entry. install_service can't import the
  // device registry (cycle), so the verifier is WIRED here at boot. Fail-closed:
  // if this is never wired, no runner install can activate.
  setPluginDeviceVerifier((did) => {
    const device = getDeviceByDID(did);
    return device !== null && !device.revoked && device.role === 'plugin';
  });

  // Service-config repo + hydrate. Without hydration, `getServiceConfig()`
  // returns null at boot even when a config was previously persisted —
  // and `isCapabilityConfigured` (consulted by D2D ingress for the
  // service-query bypass) reads that null and denies every inbound
  // service.query at the contact gate.
  setServiceConfigRepository(new SQLiteServiceConfigRepository(identityDB));
  await hydrateServiceConfig();
  setStagingRepository(new SQLiteStagingRepository(identityDB));
  hydrateStagingFromRepository();
  // Interactive-run control store + service (INTERACTIVE_SERVICES §5/§12.5).
  const runRepository = new SQLiteRunRepository(identityDB);
  setRunRepository(runRepository);
  setRunService(new RunService({ repository: runRepository }));
  // Per-payload leaf erasure-key store (§13). Tier-0 backend ⇒ honest
  // `logical_deletion` crypto-shred on the shipping stack; a hardened
  // non-backed backend upgrades this to `backup_resistant` later.
  setErasureKeyStore(new SQLiteErasureKeyStore(identityDB));
  // Reservation store — the atomic bounded-queue admission slot (§7).
  setReservationRepository(new SQLiteReservationRepository(identityDB));
  // PeerLens writes from coding agents and the web client share the same
  // durable, lease-fenced publish queue used by mobile.
  setReviewPublishRepository(new SQLiteReviewPublishRepository(identityDB));
  // Per-message lifecycle + Brain-classify job stores (§6.3/§12.6).
  setMessageRepository(new SQLiteMessageRepository(identityDB));
  setClassificationJobRepository(new SQLiteClassificationJobRepository(identityDB));
  // Completion-receipt store — two-step idempotent-CAS advancement (§6.2).
  setCompletionReceiptRepository(new SQLiteCompletionReceiptRepository(identityDB));
  // Durable owner-command idempotency receipts (§12.5). The tx runner makes each
  // owner command's mutation + its receipt write ONE atomic identity.sqlite
  // commit (§5), so a crash can never lose a receipt and let a replayed old
  // command re-execute.
  setCommandReceiptRepository(new SQLiteCommandReceiptRepository(identityDB));
  setCommandTxRunner((fn) => identityDB.transaction(fn));
  // Commerce Pack stores (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md §15.5/§16.2):
  // order-reference/idempotency with effect phases, quote head CAS + use holds,
  // status head CAS, durable receipts, counterparty epoch watermarks.
  // Composed ONCE, here. Production code receives aggregate stores and
  // cannot reach the raw mutators (ARCH-0). Identity and the commerce epoch
  // are read through thunks because both boot after storage;
  // `currentEpoch()` throws until the epoch record is published, which is
  // the §16.2 fail-closed posture rather than an oversight.
  installCommerceRuntime(
    createCommerceRuntime({
      adapter: identityDB,
      supplierDid: () => {
        const did = getNodeDID();
        if (did === null) {
          throw new Error('commerce: business identity not established — signing is fail-closed');
        }
        return did;
      },
      // §12.7/§16.2 — the supplier half of held evidence. Built in Core so
      // both boots run the same check; unwired, EVERY presented receipt fails
      // to verify and `never_received` stays legal against real proof.
      verifyHeldEvidence: makeHeldEvidenceVerifier(),
      currentEpoch: () => {
        const service = getCommerceEpochService();
        if (service === null) {
          throw new Error('commerce: epoch service not installed — signing is fail-closed (§16.2)');
        }
        return service.currentEpoch();
      },
      // §8.3/WS-9.1 — what the credential broker may actually do. The table is
      // derived from the OWNER's connector settings on every call, so adding a
      // connector works without a restart and removing one stops working at
      // once. The transport is `node:https` because §10.3 re-checks the
      // address actually connected to, and `fetch` cannot report it.
      credentialExecutors: makeConnectorExecutors({
        endpoints: endpointsFromSupplierSettings(() => {
          const runtime = getCommerceRuntime();
          // Read through the INSTALLED runtime rather than a second settings
          // repository over the same table: two readers is two chances for one
          // of them to skip the validation the other runs.
          return runtime === null ? { ok: false } : runtime.settings.readSupplier();
        }),
        transport: nodeAuthedTransport,
      }),
    }),
  );

  // §12.7/§16.2 (WS-X-11) — WHAT THIS BUYER HOLDS, so a supplier that lost
  // state must re-adopt rather than deny.
  //
  // Installed AFTER the runtime, because the reader reads the runtime's own
  // stores. Before this, `installHeldEvidenceReader` was called from tests
  // and nowhere else: a real buyer presented no evidence, which made a
  // supplier's `never_received` legal — and that is the one answer
  // authorising a resubmission, i.e. a duplicate order.
  //
  // Read through the INSTALLED runtime for the same reason the connector
  // settings are: a second set of repositories over the same tables is a
  // second chance for one of them to disagree with the other.
  installHeldEvidenceReader(
    makeHeldEvidenceReader({
      orders: {
        get: (supplierDid, purchaseOrderId) =>
          getCommerceRuntime()?.buyerOrders.get(supplierDid, purchaseOrderId) ?? null,
      },
      statuses: {
        evidenceChain: (supplierDid, purchaseOrderId) =>
          getCommerceRuntime()?.buyerStatus.evidenceChain(supplierDid, purchaseOrderId) ?? [],
      },
    }),
  );

  // §10.2/WS-5.1 — how this node FETCHES a supplier's catalog feed.
  //
  // The same transport the connectors use, with NO headers, and the empty
  // object is the decision rather than an oversight: a catalog is a public
  // publication, so there is nothing to authenticate with and a credential
  // sent to a supplier's feed URL would simply be a credential given away.
  //
  // Core still owns every decision about what comes back — pointer advance,
  // snapshot digest, per-page proof, the §10.3 connected-address re-check.
  // This half only speaks HTTPS and reports what it reached.
  installCatalogFeedTransport((url) => nodeAuthedTransport(url, {}));

  // §12.7/WS-3.7 — the buyer order sender. Built over the SAME `service.query`
  // egress every other outbound capability uses, so the four gates, signing and
  // MsgBox apply without a second path to keep in step. A throw is reported as
  // AMBIGUOUS rather than "not sent": the wrapper cannot prove nothing left,
  // and claiming it would authorize a duplicate order.
  const serviceQueryDispatch = async ({
    toDid,
    body,
  }: {
    toDid: string;
    body: ServiceQueryBody;
  }): Promise<{ sent: boolean; deniedAt?: string }> => {
    const send = getD2DSender();
    if (send === null) {
      // No transport at all is the one case we CAN prove: nothing left.
      return { sent: false, deniedAt: 'no_d2d_sender' };
    }
    await send(toDid, 'service.query', { ...body });
    return { sent: true };
  };
  // Installed as well as used here, because §12.7's re-poll runs on a tick
  // started in `boot.ts` and must reach a supplier the SAME way an order does.
  installCommerceServiceQueryDispatch(serviceQueryDispatch);
  installBuyerOrderSender(makeServiceQueryBuyerSender({ dispatch: serviceQueryDispatch }));

  // §7.2/§7.3 (DR-1) — WHO may commit this business. Without a provider the
  // order routes fail closed, which is the intended posture: a node that
  // cannot say who is allowed to spend its money does not spend it. The
  // single-approver pilot is a CONFIGURATION with one grant in it, evaluated
  // by the same code as a category buyer or a delegated signer — not a branch
  // that skips §7.3, because that branch is exactly what left staff authority
  // dead on the money path.
  installBuyerAuthorityProvider(({ order, context, serviceRkey }) => {
    // NULL IS A REFUSAL, not a default. A node with no identity cannot say who
    // is committing its business, and the route turns this into a 403 rather
    // than committing under an empty principal — an empty `principalDid` would
    // pass the chain-completeness check while naming nobody.
    const ownerDid = getNodeDID();
    if (ownerDid === null || ownerDid === '') return null;
    return singleOwnerAuthority({ ownerDid, order, context, serviceRkey });
  });
  // Extension-operation registry (§3.4): code-shipped adapter
  // registrations land here at boot; empty until a pack ships — the
  // gate then denies every declared-but-unshipped operation.
  // §3.4 host-operation plane: the durable proposal broker + the dispatcher
  // that executes permitted proposals. Composed through ONE helper so both
  // boots get the same object — an option each root must remember to pass
  // is an option one of them forgets.
  const extensionRegistry = new ExtensionOperationRegistry();
  setExtensionOperationRegistry(extensionRegistry);
  // §3.4 — the operations a capability may DECLARE. The registry was built
  // empty and only the DISPATCHER was populated, so every declared operation
  // was refused `operation_unregistered` and the executors below were
  // unreachable: the lane was open on the doing side and closed on the
  // declaring one. Code-shipped, never data-driven (§3.4).
  registerCommerceHostOperations(extensionRegistry);
  const hostRuntime = createPluginHostRuntime({ db: identityDB, registry: extensionRegistry });
  installPluginHostRuntime(hostRuntime);
  // §3.4 / WS-3.5 — the typed host operations a runner may ask Core to
  // perform. REGISTERED HERE because each needs a boundary Core does not own:
  // the credential broker for the connector lane, the leakage gate for a
  // publication candidate. A dispatcher with no executor answers
  // `no_executor`, which is the honest failure for an operation this build
  // cannot do — but it is the WRONG answer for one it can, and until this
  // block existed every operation but the AppView search got it.
  hostRuntime.dispatcher.register(
    'connector_broker',
    makeConnectorBrokerOperation({ broker: () => getCommerceRuntime()?.broker ?? null }),
  );
  hostRuntime.dispatcher.register(
    'd2d_send',
    makeD2DSendOperation({
      send: async ({ toDid, body }) => {
        const sender = getD2DSender();
        if (sender === null) {
          // A throw, not a silent success: the dispatcher settles it
          // `outcome_unknown`, and a node with no transport that reported
          // `completed` would tell a runner its message left.
          throw new Error('d2d_send: this node has no D2D sender');
        }
        // The installed sender's own signature: (recipient, type, body).
        // Going through it rather than `sendD2D` directly is what keeps the
        // four egress gates, the signing identity and the outbox on this
        // path — a second call site would be a second thing to keep in step.
        await sender(toDid, 'plugin.message', body as Record<string, unknown>);
      },
      // §8's grant constraints, not a second allowlist. A D2D recipient IS a
      // resource the grant names, and inventing a parallel policy would drift
      // from the one the owner sees on the consent screen.
      permittedRecipients: permittedD2DRecipients({
        listGrants: (installId) => getPluginGrantRepository()?.listByInstall(installId) ?? [],
        capability: 'com.dinakernel.plugin.d2d_send',
        nowSec: () => Math.floor(Date.now() / 1000),
      }),
    }),
  );
  hostRuntime.dispatcher.register(
    'publication_candidate',
    makePublicationCandidateOperation({
      supplierDid: () => getNodeDID(),
      // §12.1 step 10: the SUPPLIER install may offer a candidate. Any
      // install is refused rather than trusted, so a buyer-side runner cannot
      // propose a catalog under this business's name.
      mayPublish: (installId) =>
        getPluginInstallRepository()?.getById(installId)?.pluginId ===
        SUPPLIER_REFERENCE_MANIFEST.plugin_id,
      validateCandidate: ({ candidate }) => {
        const items = Array.isArray(candidate)
          ? candidate
          : ((candidate as { items?: unknown }).items ?? null);
        if (!Array.isArray(items)) {
          return [{ refusal: 'not_a_catalog', detail: 'the candidate carries no item list' }];
        }
        const verdict = gateCatalogForPublication(items);
        // The leakage gate's own findings, verbatim. Restating them here
        // would be a second vocabulary for one rule.
        return verdict.clean
          ? []
          : verdict.findings.map((f) => ({ refusal: f.refusal, detail: f.detail }));
      },
    }),
  );
  // §9.13 drain authorizations: rebind drain + lifecycle continuity.
  setDrainAuthorizationRepository(new SQLiteDrainAuthorizationRepository(identityDB));
  // §9.13/§16.5 (WS-3.7) — the update-rebind coordinator, and the owner-facing
  // flow that is its only caller. Built here because the composition root is the
  // only place that knows the Tier-0 runner and the listing store; the
  // coordinator itself resolves its repositories PER USE, so wiring order
  // between this and the stores above cannot leave it holding a null.
  setUpdateRebindCoordinator(
    new UpdateRebindCoordinator({
      installs: () => getPluginInstallRepository(),
      drains: () => getDrainAuthorizationRepository(),
      rebindListings: (rebindArgs) => rebindListingsForUpdate(identityDB, rebindArgs),
      // §9.13 — a prior manifest's lifecycle lane stays open while it still
      // serves an order. Absent commerce reads as zero, so a node that never
      // traded can still release a lane it could never have used.
      //
      // UNFINISHED, not merely RESERVED: an accepted order is decided the
      // moment the supplier answers, and its status chain runs on for days.
      // Counting only reservations would release the lane while every one of
      // those still needs it.
      countOpenOrders: (cid) =>
        // §9.11 — a delivered order stops being work once its dispute window
        // passes, and the count needs a clock to know that. Without one every
        // delivered order blocked continuity release and uninstall for ever.
        getCommerceRuntime()?.orders.countUnfinishedByServingManifest(cid, Date.now()) ?? 0,
      tx: tier0TxRunner(identityDB),
      now: () => Date.now(),
    }),
  );
  // Push subscription store — the default-deny authorization gate + rate/cry-wolf
  // counters (PUSH_SERVICES_ARCHITECTURE.md §6/§15).
  setPushSubscriptionRepository(new SQLitePushSubscriptionRepository(identityDB));
  setChatMessageRepository(new SQLiteChatMessageRepository(identityDB));
  setPeopleRepository(new SQLitePeopleRepository(identityDB));
  hydrateContactDirectory();
  await hydrateRemindersFromRepo();

  // issues.txt §1 — durable D2D outbox (shared egress path with mobile).
  // Lite is a long-running process but still restarts; a queued service-
  // query/response that couldn't deliver immediately must survive. The
  // re-delivery fn + periodic drainer are wired in wire_workflow_plane
  // (where the signing identity + sendD2D live); here we just install the
  // SQL repo and reclaim crash-orphaned 'sending' rows.
  setD2DOutboxRepository(new SQLiteD2DOutboxRepository(identityDB));
  recoverOutboxOnBoot();

  // (agent persona grant repo — issues.txt §2 — is now wired ABOVE, before
  // hydrateDeviceRegistry, so the boot reconciler can reach it. Round-8 #2.)

  // Seed default personas, then open EVERY one via the shared
  // lifecycle helper. The lite stack's only client is the owner's own
  // app (SPA / mobile); locked tiers (health, finance) are protections
  // against external agents, not against the owner of the home node
  // (memory: `user-vs-agent-persona-access`). Leaving them closed at
  // boot would silently break cross-domain synthesis ("Emma birthday
  // → finance budget") for the in-app user.
  //
  // `openAllPersonasForInAppUser` is the same helper mobile's
  // `useUnlock` calls — one place to evolve the rule, one suite to
  // test it (`packages/home-node/__tests__/persona_lifecycle.test.ts`).
  // The `openVaultDB` callback wires the per-persona SQLite vault
  // handle + the topic repo after the registry marks it open.
  const { openAllPersonasForInAppUser } = await import('@dina/home-node');
  for (const spec of DEFAULT_PERSONAS) {
    if (!personaExists(spec.name)) {
      createPersona(spec.name, spec.tier, spec.description);
      setPersonaDescription(spec.name, spec.description);
    }
  }
  const openVaultDB = async (persona: string): Promise<void> => {
    const personaDB = await openPersonaVault(provider, persona);
    setVaultRepository(persona, new SQLiteVaultRepository(personaDB));
    setTopicRepository(persona, new SQLiteTopicRepository(personaDB));
  };
  const opened = await openAllPersonasForInAppUser({ openVaultDB });
  logger.info({ openedPersonas: opened }, 'persona vaults opened');

  // issues.txt §2 — approving an agent locked-persona request also opens
  // that persona's vault (DEK into RAM) so the agent's retry can decrypt.
  setAgentPersonaUnlockHook(openVaultDB);

  // Encrypted .dina backup/restore. The one-shot Home Node archive tool invokes
  // this same initializer offline, so export/import stays inside Core and no
  // vault dump or passphrase is exposed over HTTP.
  setArchiveDataSource({
    identityAdapter: () => identityDB,
    personaSources: async (): Promise<ArchivePersonaSource[]> => {
      const sources: ArchivePersonaSource[] = [];
      for (const persona of listPersonas()) {
        const adapter = await openPersonaVault(provider, persona.name);
        sources.push({
          name: persona.name,
          tier: getPersonaTier(persona.name),
          adapter,
        });
      }
      return sources;
    },
    openPersonaForRestore: async (name, tier) => {
      if (!personaExists(name)) {
        // Restoring only the in-memory registration would make this vault
        // disappear from the catalog at the next process boot.
        createPersona(name, restoreTier(tier), undefined, { persist: true });
      }
      const adapter = await openPersonaVault(provider, name);
      setVaultRepository(name, new SQLiteVaultRepository(adapter));
      setTopicRepository(name, new SQLiteTopicRepository(adapter));
      return adapter;
    },
    hasExistingUserData: async () => {
      const identityTables = [
        'reminders',
        'contacts',
        'people',
        'person_identities',
        'chat_messages',
        'service_configs',
        'contact_service_offers',
        'service_grants',
        'plugin_installs',
        'plugin_grants',
        'paired_devices',
        'agent_persona_grants',
      ];
      for (const table of identityTables) {
        try {
          if (identityDB.query(`SELECT 1 FROM ${table} LIMIT 1`).length > 0) {
            return true;
          }
        } catch {
          // An absent table on an older schema contains no user data.
        }
      }
      for (const persona of listPersonas()) {
        try {
          const adapter = await openPersonaVault(provider, persona.name);
          if (adapter.query('SELECT 1 FROM vault_items LIMIT 1').length > 0) {
            return true;
          }
        } catch {
          // Opening creates a missing file, so an error here means an unreadable
          // existing vault or storage failure. Treat that as occupied; a
          // non-force restore must never overwrite uncertainty.
          return true;
        }
      }
      return false;
    },
    appVersion: 'home-node-lite',
  });

  return { provider, identityDB, openedPersonas: opened };
}
