/**
 * Boot capability composer — assembles `BootServiceInputs` from live app
 * state (persisted DID, keychain BYOK key, role preference, open identity
 * DB). The Expo layout calls `buildBootInputs()` once after unlock;
 * whatever is ready at that moment is forwarded to `bootAppNode` and
 * everything else surfaces as a `BootDegradation` the banner renders.
 *
 * The composer is intentionally side-effect-light: it only reads from
 * keychain / Core globals / module-level getters, never writes. That way
 * re-running it on identity change or role change yields a deterministic
 * result, and the useNodeBootstrap lifecycle never sees a half-mutated
 * world.
 *
 * What this helper fixes (review findings #3, #4, #5, #6, #7, #8, #18):
 *   #3 — loads a persisted DID from `identity_record` before deriving
 *        did:key; a did:plc persisted by onboarding takes effect on
 *        next boot.
 *   #4 — reuses the open identity DatabaseAdapter (if persistence was
 *        initialised pre-boot) so workflow + service config persist.
 *   #5 — builds the Bus Driver tool registry + AISDK LLM provider so
 *        `/ask` runs the multi-turn agentic loop when a BYOK key is set.
 *   #6 — supplies `AppViewStub` seeded with the demo profile so public
 *        lookups don't bottom out in no_candidate.
 *   #7 — MsgBox stays unconfigured by design in the demo build (there's
 *        no relay to connect to); the degradation remains, but the
 *        INPUT shape the caller provides is explicit, not forgotten.
 *   #8 — pulls role from the persisted preference so the Service
 *        Sharing screen can flip to provider / both.
 *   #18 — the AppView stub from #6 uses `busDriverDemoProfile()` so the
 *         Bus 42 demo is actually runnable from the current app shell.
 */

import { loadOrGenerateSeeds } from './identity_store';
import { loadPersistedDid } from './identity_record';
import { loadRolePreference } from './role_preference';
import { AppViewStub, busDriverDemoProfile } from './appview_stub';
import { getIdentityAdapter } from '../storage/init';
import { getPublicKey } from '@dina/core/src/crypto/ed25519';
import { deriveDIDKey } from '@dina/core/src/identity/did';
import { createLLMProvider, getConfiguredProviders } from '../ai/provider';
import { loadActiveProvider } from '../ai/active_provider';
import type { ProviderType } from '../ai/provider';
import type { ToolRegistry } from '@dina/brain/src/reasoning/tool_registry';
// Needed only as `typeof` sources for the lazy proxy type signatures
// below. The runtime assembly lives in the Brain composition module.
import type {
  createQueryServiceTool,
  createFindPreferredProviderTool,
} from '@dina/brain/src/reasoning/bus_driver_tools';
import { createGeminiClassifier } from '@dina/brain/src/routing/gemini_classify';
import {
  registerPersonaSelector,
  resetPersonaSelector,
} from '@dina/brain/src/routing/persona_selector';
import {
  LLMRouter,
  RoutedLLMProvider,
} from '@dina/brain/src/llm/router_dispatch';
import type { ProviderName } from '@dina/brain/src/llm/router';
import { buildAgenticAskPipeline } from '@dina/brain/src/composition/agentic_ask';
import { setReviewDraftStarter } from '@dina/brain/src/reasoning/draft_review_tool';
import { startReviewDraft } from '../trust/review_draft';
import {
  buildAgenticExecuteFn,
  createAskCoordinator,
} from '@dina/brain/src/composition/ask_coordinator';
import { DEFAULT_ASK_SYSTEM_PROMPT } from '@dina/brain/src/reasoning/ask_handler';
import { getApprovalManager } from '@dina/core/src/approval/manager';
import { installApprovalInboxBridge } from '@dina/brain/src/notifications/bridges';
import type { BootServiceInputs } from './boot_service';
import type { NodeRole } from './bootstrap';
import type { IdentityKeypair } from '@dina/core/src/identity/keypair';
import {
  DEFAULT_MSGBOX_URL,
  makeResolveSender,
  makeWSFactory,
  resolveMsgBoxURL,
} from './msgbox_wiring';
import { DIDResolver } from '@dina/core/src/d2d/resolver';
import { multibaseToPublicKey } from '@dina/core/src/identity/did';
import { sendD2D as coreSendD2D } from '@dina/core/src/d2d/send';
import type { ServiceType } from '@dina/core/src/transport/delivery';
import {
  addContactIfNotExists,
  hydrateContactDirectory,
} from '@dina/core/src/contacts/directory';

/**
 * Dev-only seed: EXPO_PUBLIC_DINA_DEV_CONTACT=`did:method:id|Display Name`.
 * Pipe-separated so the pipe isn't valid inside a DID. No-op when unset
 * or the format is malformed. Uses `addContactIfNotExists` so a contact
 * persisted from a previous run (SQL UNIQUE on `contacts.did`) doesn't
 * bubble up as an "uncaught in promise" op-sqlite error — the helper
 * returns `{ created: false }` instead of throwing. When the row
 * already exists we still call `addEgressGateContact` / `addKnownContact`
 * via addContactIfNotExists's internal sync path — see the directory
 * module.
 */
function seedDevContact(): void {
  const raw = process.env.EXPO_PUBLIC_DINA_DEV_CONTACT ?? '';
  if (raw === '') return;
  const [didStr, name] = raw.split('|');
  if (didStr === undefined || !didStr.startsWith('did:')) return;
  try {
    addContactIfNotExists(didStr, name?.trim() || 'Dev Peer', 'verified');
  } catch {
    /* malformed params — silent */
  }
}

export interface BuiltBootInputs extends BootServiceInputs {
  // Identity fields become required after composition — the caller no
  // longer needs to supply them separately.
  did: string;
  signingKeypair: IdentityKeypair;
}

export interface BuildBootInputsOptions {
  /**
   * Override the active BYOK provider. When omitted the helper reads
   * `loadActiveProvider()` (the durable Settings-side selection) and
   * falls back to the first keychain-ordered configured provider only
   * if nothing was persisted. Tests pass `'none'` to opt out entirely.
   */
  activeProvider?: ProviderType | 'none';
  /**
   * Override the persisted role preference. Tests use this to exercise
   * provider-side code paths deterministically.
   */
  roleOverride?: NodeRole;
  /**
   * Override the persisted DID. Tests or onboarding screens use this
   * to inject a known did:plc without touching keychain state.
   */
  didOverride?: string;
  /**
   * Supply a pre-built AppView client. When omitted the helper either
   * returns an `AppViewStub` seeded with the Bus 42 demo profile (when
   * `demoMode` is true), or leaves the field unset so `bootAppNode`
   * records the `discovery.no_appview` degradation — the shipped app
   * no longer silently boots against fake discovery data (findings
   * #1, #15).
   */
  appViewClient?: BootServiceInputs['appViewClient'];
  /**
   * Enable demo-mode affordances: Bus 42 AppView seeding, demo-friendly
   * role/identity fallbacks. Off by default so a production install
   * never picks up demo state by accident. The Expo entrypoint flips
   * this on only when `process.env.EXPO_PUBLIC_DINA_DEMO === '1'`.
   */
  demoMode?: boolean;
  /** Additional logger sink — layered on top of the default. */
  logger?: BootServiceInputs['logger'];
}

/**
 * Compose a full `BootServiceInputs` bundle from the current app state.
 * Safe to call once per boot; safe to re-call on identity / role change.
 */
export async function buildBootInputs(
  options: BuildBootInputsOptions = {},
): Promise<BuiltBootInputs> {
  const { did, signingKeypair } = await resolveIdentity(options.didOverride);
  const role = options.roleOverride ?? (await loadRolePreference());

  // Restore persisted contacts from SQL so a restart doesn't silently
  // drop every peer. hydrateContactDirectory also mirrors into the
  // D2D egress gate + trust classifier so the `/chat/[did]` send path
  // accepts them on first tap (no re-add required across sessions).
  // Safe when no SQL repo is wired (returns 0).
  hydrateContactDirectory();

  // Dev-only contact seed: when EXPO_PUBLIC_DINA_DEV_CONTACT is set,
  // pre-populate the in-memory directory at boot so end-to-end smoke
  // runs don't depend on clean keyboard input through the Add Contact
  // form. Format: `did:plc:...:DisplayName` (single colon-separated
  // pair). Off in production because the env var is bundle-time only.
  seedDevContact();
  // AppView client: explicit caller-supplied > demo-mode stub > undefined
  // (which makes bootAppNode emit `discovery.no_appview`).
  const appViewClient =
    options.appViewClient ?? (options.demoMode === true ? demoAppView() : undefined);
  const databaseAdapter = getIdentityAdapter() ?? undefined;

  const agenticAskBundle = await tryBuildAgenticAsk({
    activeProvider: options.activeProvider,
    appViewClient,
    logger: options.logger,
  });

  // Pattern A wins over the simpler agenticAsk path when we have a
  // pipeline in hand: the pipeline already has `approvalManager` wired
  // (via `tryBuildAgenticAsk` below), so we can construct an
  // `AskCoordinator` and ride the full suspend/resume chain.
  // `agenticAsk` is left undefined when `askCoordinator` is set —
  // bootstrap.ts routes coordinator-first.
  const agenticAsk: BootServiceInputs['agenticAsk'] =
    agenticAskBundle !== undefined && agenticAskBundle.askCoordinator === undefined
      ? {
          provider: agenticAskBundle.provider,
          tools: agenticAskBundle.tools,
          options: agenticAskBundle.handlerOptions,
        }
      : undefined;
  const askCoordinator: BootServiceInputs['askCoordinator'] =
    agenticAskBundle?.askCoordinator !== undefined
      ? {
          coordinator: agenticAskBundle.askCoordinator,
          requesterDid: did,
        }
      : undefined;

  // LLM-backed persona classifier — byte-parity with Python's staging
  // pipeline. When a provider is configured, the drain routes
  // `/remember` items through the SAME `LLMRouter` the agentic `/ask`
  // handler uses — just bound to `taskType: 'classify'` so the router
  // picks the `lite` tier per-call. That gives us: PII scrub → cloud
  // consent gate → lite-tier model → `PERSONA_CLASSIFY` prompt → vault
  // write, end-to-end. Without a provider we reset the selector so
  // the drain falls back to keyword `classifyPersonas`.
  if (agenticAskBundle !== undefined) {
    const classifierProvider = new RoutedLLMProvider({
      router: agenticAskBundle.router,
      taskType: 'classify',
      label: 'routed:classify',
    });
    registerPersonaSelector(createGeminiClassifier(classifierProvider));
  } else {
    resetPersonaSelector();
  }

  // GAP-RT-02: wire the staging drain's topic-touch + preference
  // binder by default whenever we have an LLM provider in hand.
  // Reuses the same provider instance `agenticAsk` captured, so
  // production ingest goes through TopicExtractor + PreferenceExtractor
  // → core.memoryTouch / updateContact out of the box. Without this,
  // every default Expo boot silently records a `staging.no_enrichment`
  // degradation and runs without the pipeline — the review path
  // this commit addresses.
  //
  // When no provider is wired (`activeProvider === 'none'` or the
  // adapter couldn't construct one) we still pass a bundle with
  // `llm: undefined` so the regex-based preference binder runs on
  // its own. That's a deliberate "reduced mode" rather than a full
  // disable — preference binding is LLM-free, and the topic
  // extractor degrades to a no-op (see staging_enrichment.ts).
  const stagingEnrichment: BootServiceInputs['stagingEnrichment'] = {
    llm: agenticAsk?.provider,
  };

  // MsgBox transport — wire the shared Dina relay so outbound D2D
  // actually reaches a peer (issue #1). Without `sendD2D`, `wsFactory`,
  // and `resolveSender`, boot records `transport.sendd2d.noop` +
  // `transport.msgbox.missing` degradations and every send goes to
  // /dev/null. All three share one relay session so peer messages
  // travel the same path as service-query traffic.
  const msgboxURL = resolveMsgBoxURL();
  const wsFactory = makeWSFactory();
  // Share one DIDResolver instance between resolveSender (inbound key
  // lookups) and sendD2D (outbound endpoint + pubkey lookups) so the
  // 10-minute cache on first fetch carries into subsequent sends —
  // every chat bubble would otherwise trigger a PLC round-trip.
  const didResolver = new DIDResolver();
  const resolveSender = makeResolveSender({
    selfDID: did,
    selfPublicKey: signingKeypair.publicKey,
    resolver: didResolver,
  });

  /**
   * Outbound D2D egress for the iOS app. Resolves the recipient via
   * the shared DIDResolver (PLC directory for did:plc, local derive
   * for did:key), extracts the Ed25519 signing key + `#dina-messaging`
   * service endpoint, and hands off to Core's `sendD2D` pipeline —
   * which seals, signs, and (once MsgBox is bootstrapped) routes the
   * envelope onto the WebSocket via `sendD2DViaWS`.
   *
   * When the peer has no `#dina-messaging` service yet (did:key peers
   * that haven't published a DID doc), we fall through to the direct
   * HTTPS delivery path with the relay as the endpoint. Core's
   * delivery module will still prefer the WS path when MsgBox has
   * installed `sendD2DViaWS` via `setWSDeliverFn`.
   */
  // Same heuristic msgbox_wiring uses: prefer an id ending `#dina_signing`,
  // else any 32-byte Multikey (Ed25519). Kept here (not imported) because
  // msgbox_wiring's helper is private to that module.
  const pickPeerSigningKey = (
    vms: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>,
  ): { publicKeyMultibase?: string } | null => {
    for (const vm of vms) {
      if (typeof vm.id === 'string' && vm.id.endsWith('#dina_signing')) return vm;
    }
    for (const vm of vms) {
      if (vm.type !== 'Multikey' || typeof vm.publicKeyMultibase !== 'string') continue;
      try {
        if (multibaseToPublicKey(vm.publicKeyMultibase).length === 32) return vm;
      } catch {
        /* malformed — skip */
      }
    }
    return null;
  };

  const sendD2D: BootServiceInputs['sendD2D'] = async (to, type, body) => {
    const resolved = await didResolver.resolve(to);
    // ATProto PLC docs list the secp256k1 rotation key first
    // (#atproto); we need the Ed25519 signing key (#dina_signing / any
    // 32-byte Multikey) for sealMessage's `recipientEd25519Pub`.
    const vm = pickPeerSigningKey(resolved.document.verificationMethod);
    if (vm === null) {
      throw new Error(`sendD2D: recipient ${to} has no Ed25519 signing key in its DID doc`);
    }
    const recipientPublicKey = multibaseToPublicKey(vm.publicKeyMultibase as string);

    // Prefer the `#dina-messaging` endpoint published in the peer's
    // DID doc so each peer can advertise its own relay. Fall back to
    // our shared relay when the peer's doc doesn't carry one.
    const endpoint = resolved.messagingService?.endpoint ?? msgboxURL;
    // DID docs carry either "DinaMsgBox" (WS relay) or "DinaDirectHTTPS"
    // (direct HTTPS). Default to DinaMsgBox when the doc doesn't
    // advertise a service since the fallback endpoint IS the relay.
    const serviceType: ServiceType =
      resolved.messagingService?.type === 'DinaDirectHTTPS' ? 'DinaDirectHTTPS' : 'DinaMsgBox';

    const result = await coreSendD2D({
      recipientDID: to,
      messageType: type,
      body: JSON.stringify(body),
      senderDID: did,
      senderPrivateKey: signingKeypair.privateKey,
      recipientPublicKey,
      serviceType,
      endpoint,
    });

    if (!result.sent) {
      throw new Error(
        `sendD2D: ${type} to ${to} denied at ${result.deniedAt ?? 'unknown'}: ${result.error ?? 'no detail'}`,
      );
    }
  };

  return {
    did,
    signingKeypair,
    role,
    appViewClient,
    databaseAdapter,
    agenticAsk,
    askCoordinator,
    stagingEnrichment,
    logger: options.logger,
    msgboxURL,
    wsFactory,
    resolveSender,
    sendD2D,
    // PDS publisher stays unset — only providers that need discoverable
    // profiles need one; the boot service records `publisher.stub` if
    // role === 'provider' and it's missing.
  };
}

// ---------------------------------------------------------------------------
// Identity (issue #3)
// ---------------------------------------------------------------------------

async function resolveIdentity(
  didOverride: string | undefined,
): Promise<{ did: string; signingKeypair: IdentityKeypair }> {
  const seedsResult = await loadOrGenerateSeeds();
  const privateKey = seedsResult.seeds.signingSeed;
  const publicKey = getPublicKey(privateKey);
  const signingKeypair: IdentityKeypair = { privateKey, publicKey };

  if (didOverride !== undefined && didOverride !== '') {
    return { did: didOverride, signingKeypair };
  }

  const persisted = await loadPersistedDid();
  if (persisted !== null) {
    return { did: persisted, signingKeypair };
  }

  // Fallback: derive a did:key. `bootAppNode` still records the
  // identity.did_key degradation so the banner flags the missing
  // publishable identity.
  return { did: deriveDIDKey(publicKey), signingKeypair };
}

// ---------------------------------------------------------------------------
// AppView stub seeded with the demo profile (issues #6, #18)
// ---------------------------------------------------------------------------

function demoAppView(): AppViewStub {
  return new AppViewStub({
    profiles: [
      busDriverDemoProfile({
        // Pin the demo lat/lng so `search_provider_services` lat/lng ranking
        // returns a deterministic distance for the walk-through scenario.
        lat: 37.7749,
        lng: -122.4194,
      } as Parameters<typeof busDriverDemoProfile>[0]),
    ],
  });
}

// ---------------------------------------------------------------------------
// Agentic /ask (issue #5)
// ---------------------------------------------------------------------------

/**
 * Bundle `tryBuildAgenticAsk` returns. `BootServiceInputs['agenticAsk']`
 * carries `{provider, tools, options?}` — we extend that internally so
 * the outer boot code can reuse the live `LLMRouter` to build the
 * persona classifier's `RoutedLLMProvider` (bound to
 * `taskType: 'classify'`). Keeping the router outside
 * `BootServiceInputs` keeps the boot-service surface stable; nothing
 * above this file needs it.
 */
interface AgenticAskBundle {
  provider: RoutedLLMProvider;
  tools: ToolRegistry;
  router: LLMRouter;
  /** Forwarded verbatim to `makeAgenticAskHandler` — carries the
   *  intent classifier (and, as we port them, guard scan + anti-Her
   *  hooks) so the production `/ask` path always gets the full
   *  Python-parity pipeline. */
  handlerOptions: Omit<
    import('@dina/brain/src/reasoning/ask_handler').AgenticAskHandlerOptions,
    'provider' | 'tools'
  >;
  /**
   * Pattern A coordinator — produced when the pipeline was built with
   * an `approvalManager` (which it always is in production today).
   * Bootstrap routes through this when set, falling back to the
   * `provider`+`tools` legacy `agenticAsk` path only when undefined
   * (e.g. degraded boot where pipeline construction failed).
   */
  askCoordinator?: import('@dina/brain/src/composition/ask_coordinator').AskCoordinator;
}

/**
 * Resolve mobile-specific dependencies, then delegate to the shared
 * `buildAgenticAskPipeline`. This thin wrapper is the only difference
 * between mobile's composition and home-node-lite brain-server's — the
 * server version will resolve `provider` via env, `appViewClient` via
 * configured URL, and `orchestratorHandle`/`coreClient` via direct HTTP
 * references instead of the lazy module-globals mobile uses.
 *
 * Task cleanup #490 extracted everything Brain-owned into
 * `packages/brain/src/composition/agentic_ask.ts`. What remains here is
 * mobile-specific:
 *   - `pickProvider()` reads the keychain (mobile-only).
 *   - `createLLMProvider()` builds the AI-SDK language model using the
 *     stored API key (mobile-only).
 *   - `emptyAppView()` stub used when no AppView is wired (demo/dev).
 *   - `lazyOrchestratorHandle()` / `lazyCoreClient()` proxy to
 *     module-globals populated by `createNode` (mobile `bootstrap.ts`).
 */
async function tryBuildAgenticAsk(opts: {
  activeProvider: ProviderType | 'none' | undefined;
  appViewClient: BootServiceInputs['appViewClient'];
  /** Forwarded to `createQueryServiceTool` so WM-BRAIN-06d auto-fetch
   *  failures surface in production telemetry. */
  logger?: BootServiceInputs['logger'];
}): Promise<AgenticAskBundle | undefined> {
  if (opts.activeProvider === 'none') return undefined;

  const provider = await pickProvider(opts.activeProvider);
  if (provider === null) return undefined;

  const llm = await createLLMProvider(provider);
  if (llm === null) return undefined;

  // Resolve the shared AppView for all tools — explicit > empty stub.
  // Mobile doesn't accept a separate AppView for the trust/search tools;
  // `opts.appViewClient` is the same handle the demo AppView feeds.
  const searchClient = opts.appViewClient ?? emptyAppView();

  // Hand the shared builder fully-resolved handles. It assembles the
  // router + routed providers + intent classifier + guard scanner +
  // tool registry + registers post-publish LLM hooks — end-to-end
  // Python parity. See `packages/brain/src/composition/agentic_ask.ts`.
  // Both concrete AppView types (real `AppViewClient` + `AppViewStub`)
  // implement `searchServices` + `isDiscoverable`, so the caller-
  // supplied client satisfies the builder's typed surface directly —
  // no runtime cast needed.
  //
  // **Pattern A**: pass the singleton `ApprovalManager` so the
  // pipeline exposes `buildToolsForAsk` and the coordinator can
  // mint per-ask persona guards. The same singleton backs the
  // mobile chat UI's approval cards (`useChatApprovals`), so an
  // approval the LLM bails on shows up in the same operator surface.
  const approvalManager = getApprovalManager();

  // Mirror approval requests into the unified notifications inbox
  // (5.66). The bridge listens for every `requestApproval` and posts
  // an `'approval'`-kind item — the Notifications screen + tab badges
  // (5.67 / 5.69) read from the same store. Disposer is intentionally
  // unused: the approval-manager singleton outlives the boot scope and
  // a re-boot replaces the listener via `resetApprovalManager`.
  installApprovalInboxBridge(approvalManager);

  // Wire the brain's `draft_review` tool to the mobile-side
  // `startReviewDraft` runner. The agentic loop's LLM picks the tool
  // when the user asks to write / draft / publish a review of a
  // subject — no regex pre-empt, no English-only intent block-list.
  // The starter posts the inline lifecycle card into the main chat
  // thread, runs the inferer, and patches the card to `'ready'` when
  // the draft is done. The tool returns the draftId to the agent so
  // its narrative reply can stay short ("the draft is ready in the
  // chat") without re-stating the drafted text.
  setReviewDraftStarter(async (subjectPhrase: string) => {
    const { draftId } = await startReviewDraft({
      subjectPhrase,
      threadId: 'main',
    });
    return { draftId };
  });

  const pipeline = buildAgenticAskPipeline({
    llm,
    providerName: provider as ProviderName,
    appViewClient: searchClient,
    orchestratorHandle: lazyOrchestratorHandle(),
    coreClient: lazyCoreClient(),
    logger: opts.logger,
    approvalManager,
  });

  // Produce the AskCoordinator only when `buildToolsForAsk` is
  // populated (i.e. approvalManager was wired). Defensive — an
  // earlier construction failure in the pipeline shouldn't fault
  // the legacy `agenticAsk` path; bootstrap can still install
  // `makeAgenticAskHandler` with the static tools registry.
  let askCoordinator: AgenticAskBundle['askCoordinator'];
  if (pipeline.buildToolsForAsk !== undefined) {
    askCoordinator = createAskCoordinator({
      pipeline,
      approvalManager,
      executeFn: buildAgenticExecuteFn({ pipeline, systemPrompt: DEFAULT_ASK_SYSTEM_PROMPT }),
      systemPrompt: DEFAULT_ASK_SYSTEM_PROMPT,
    });
  }

  return { ...pipeline, askCoordinator };
}

// `buildLightweightLLMCall` + `buildIntentClassifier` moved to
// `packages/brain/src/composition/agentic_ask.ts` during cleanup #490
// so the home-node-lite brain-server reuses them instead of
// duplicating. The legacy mobile versions that used to live here
// are now internal details of `buildAgenticAskPipeline`.

/** Empty AppView used by the agentic tools when no real client is
 *  supplied — lets the tool report "no candidates" rather than throw. */
function emptyAppView(): AppViewStub {
  return new AppViewStub();
}

async function pickProvider(override: ProviderType | undefined): Promise<ProviderType | null> {
  if (override !== undefined) return override;
  // Durable Settings-side selection wins (finding #5) — BUT only when
  // the user's selected provider STILL has an API key stored. Without
  // the key check, a persisted provider whose key was deleted (manual
  // keychain reset, user removed it elsewhere) would be treated as
  // active and the agentic loop would boot with no usable credential
  // (review #9). In that case we fall through to the first-configured
  // provider — the same behaviour as a first-run boot.
  const configured = await getConfiguredProviders();
  const persisted = await loadActiveProvider();
  if (persisted !== null && configured.includes(persisted)) {
    return persisted;
  }
  return configured[0] ?? null;
}

/**
 * Lazy handle to the orchestrator.
 *
 * The tool needs to call `issueQueryToDID`, but the orchestrator
 * instance is owned by the `DinaNode` returned from `createNode()`
 * which doesn't exist at tool-construction time. We return a thin
 * proxy that resolves the handle on first call via the module-level
 * singleton installed by `useNodeBootstrap`.
 *
 * Design tradeoff (finding #9): this uses a `require()` at call time
 * to avoid a real import cycle (`boot_capabilities → useNodeBootstrap
 * → boot_capabilities`). The alternatives are strictly worse:
 *   - Build tools AFTER `createNode` returns: requires a second
 *     wiring pass inside useNodeBootstrap for every provider change,
 *     duplicating the composer's work and making agenticAsk a live
 *     mutable state instead of an immutable boot input.
 *   - Pass a resolver closure in from the bootstrap hook: same
 *     problem — the hook becomes the authority on tool construction
 *     instead of this composer, splitting the logic.
 * The lazy proxy is the least-bad option: one module-global read,
 * guaranteed to be populated by the time the agentic loop runs (the
 * loop only fires inside `handleChat`, which runs post-start).
 */
function lazyOrchestratorHandle(): Parameters<typeof createQueryServiceTool>[0]['orchestrator'] {
  return {
    async issueQueryToDID(args) {
      // Deferred import to avoid a cycle: useNodeBootstrap → boot_capabilities
      // → useNodeBootstrap. At *call* time the bootstrap module is already
      // loaded because a query was only possible after the node started.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getBootedNode } =
        require('../hooks/useNodeBootstrap') as typeof import('../hooks/useNodeBootstrap');
      const node = getBootedNode();
      if (node === null) {
        throw new Error('query_service: DinaNode is not booted yet');
      }
      return node.orchestrator.issueQueryToDID(args);
    },
  };
}

/**
 * Lazy handle to the core client (PC-BRAIN-11). Same tradeoff as
 * `lazyOrchestratorHandle` — the client is owned by the DinaNode,
 * which doesn't exist at tool-construction time. The
 * `find_preferred_provider` tool only needs
 * `findContactsByPreference`, so we expose a minimal surface.
 */
function lazyCoreClient(): Parameters<typeof createFindPreferredProviderTool>[0]['core'] {
  return {
    async findContactsByPreference(category) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getBootedNode } =
        require('../hooks/useNodeBootstrap') as typeof import('../hooks/useNodeBootstrap');
      const node = getBootedNode();
      if (node === null) {
        // Returning [] here keeps the tool on its fail-soft rails —
        // the LLM will fall back to search_provider_services. A
        // throw would force a defensive branch for a cold path.
        return [];
      }
      return node.coreClient.findContactsByPreference(category);
    },
  };
}
