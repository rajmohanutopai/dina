/**
 * Task 5.1 — ordered boot sequence for the Brain server.
 *
 * Current scaffold: config → logger → signed Core client when a Brain
 * service key is provisioned → hosted AppView client → Fastify (with
 * /healthz and /readyz) → staging drain scheduler when Core is configured
 * → optional ask coordinator/route composition when LLM runtime is supplied
 * → listen.
 *
 * Canonical target sequence (tasks 5.1 – 5.49, filled in progressively):
 *
 *   1. `config`         — env → typed config (this task)
 *   2. `logger`         — pino root logger (this task)
 *   3. `adapter_wire`   — @dina/adapters-node: crypto, fs, keystore, net
 *   4. `core_client`    — HttpCoreTransport wired to Core's HTTP endpoint
 *   5. `appview_client` — shared AppView client from hosted endpoint config
 *   6. `brain_compose`  — @dina/brain pure package receives the injected
 *                         CoreClient + platform adapters
 *   7. `fastify_start`  — route bindings (api + admin), listen
 *   8. `ready`          — flip /readyz to green
 *
 * Steps past configured Core/AppView clients land in tasks 5.3 – 5.49.
 * The current scaffold proves the env → listen path end-to-end with
 * health/readiness probes and constructs the Core/AppView clients that
 * Brain composition reuses.
 */

import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  AppViewClient,
  StagingDrainScheduler,
  buildRememberRuntime,
  createCoordinatorAskHandler,
  resetAskCommandHandler,
  setAccessiblePersonas,
  setAskCommandHandler,
  setContactReadBackend,
  setPeopleReadBackend,
  setReminderBackend,
  setVaultReadBackend,
} from '@dina/brain';
import {
  registerEngagementProvider,
  collectNotificationBriefingItems,
} from '@dina/brain/briefing';
import { installNodeTraceScopeStorage } from '@dina/brain/node-trace-storage';
import { hydrateNotifications, mergeNotifications } from '@dina/brain/notifications';
import { createPersona, getPersona, setNotificationLogRepository } from '@dina/core';
import {
  buildHomeNodeAskRuntime,
  type HomeNodeAskRuntime,
  type HomeNodeAskRuntimeOptions,
} from '@dina/home-node/ask-runtime';
import {
  wireChatRememberRuntime,
  type ChatRememberRuntimeHandle,
} from '@dina/home-node/chat-runtime';
import {
  buildHomeNodeServiceRuntime,
  type HomeNodeServiceRuntime,
  type HomeNodeServiceRuntimeOptions,
} from '@dina/home-node/service-runtime';

import { loadConfig, type BrainServerConfig } from './config';
import { buildCoreClient, type CoreClientStatus } from './core_client';
import { registerHostAllowlistGuard } from './host_guard';
import { postInboundD2DToMainChat } from './inbound_d2d_chat';
import { buildBrainServerLLMRuntime } from './llm_provider';
import { createLogger, type Logger } from './logger';
import { CoreClientNotificationLogRepository } from './notifications/core_client_repository';
import { registerAskRoutes } from './routes/ask';
import { registerCapabilityRoutes } from './routes/capability';
import { registerChatRoutes } from './routes/chat';
import { registerContactApiRoutes } from './routes/contacts';
import { registerNotificationApiRoutes } from './routes/notifications';
import { registerOwnerProxyRoutes } from './routes/owner_proxy';
import { registerPeerlensProxyRoutes } from './routes/peerlens_proxy';
import { registerQuarantineApiRoutes } from './routes/quarantine';
import { registerReminderApiRoutes, startReminderFireLoop } from './routes/reminders';
import { registerServiceConfigProxyRoutes } from './routes/service_config_proxy';
import { registerServiceSearchRoutes } from './routes/service_search';
import { registerWebRoutes } from './routes/web';
import { registerWorkflowApiRoutes } from './routes/workflow';

/**
 * Per-persona hints used by the agentic /remember loop's system prompt.
 * Helps the LLM disambiguate (e.g. routing a "$25 toy budget" memory to
 * `finance` rather than `general` because finance is described as the
 * money/budget vault). Add entries here as new default personas land.
 */
const PERSONA_DESCRIPTIONS: Record<string, string> = {
  general: "Everyday notes — anything that doesn't clearly fit a more specific vault.",
  work: 'Job, projects, colleagues, work calendar items, professional context.',
  health: 'Medical, fitness, symptoms, medications, doctors, allergies.',
  finance: 'Money, budgets, spending, income, bills, debt, investments, taxes.',
};

/**
 * Loopback check for the bind-host guard. The brain HTTP surface is
 * unauthenticated localhost-only by design, so it must only bind to a
 * loopback interface unless an operator explicitly opts in.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.startsWith('127.');
}

import type { AskCoordinator } from '@dina/brain';
import type { CoreClient, PersonaTier } from '@dina/core';
import type { HomeNodeRuntime } from '@dina/home-node';

export interface BrainServerClients {
  appView: AppViewClient;
  core?: CoreClient;
}

export interface BrainServerDependencyStatus {
  appView: 'configured';
  core: CoreClientStatus;
  askRoutes: 'configured' | 'disabled';
  reminderRoutes: 'configured' | 'disabled';
  serviceRuntime: 'configured' | 'disabled';
  stagingDrain: 'running' | 'disabled';
  /**
   * Web SPA serving status.
   *   - `'disabled'`  — `DINA_BRAIN_WEB_UI` is unset/false (production default).
   *   - `'configured'` — flag is set and the bundle was found + mounted.
   *   - `'missing_bundle'` — flag is set but `web/dist/index.html` is missing.
   *      Boot does NOT crash; the rest of the brain server stays up so an
   *      operator can run `npm run web:export` and re-enable on the next
   *      restart. The status is surfaced via `/readyz` so they can see why
   *      `/web/` is 404'ing.
   */
  webUI: 'configured' | 'disabled' | 'missing_bundle';
  /**
   * `'pending'` while `bootServer` is mid-flight (route handler also
   * sees this if `/readyz` is hit before listen returns). Flips to
   * `'ok'` after Fastify is listening and schedulers/compositions have
   * been started — the overall `/readyz` status keys off this and
   * `core`.
   */
  runtime: 'pending' | 'ok';
}

export interface BrainServerSchedulers {
  stagingDrain?: StagingDrainScheduler;
}

export interface BrainServerCompositions {
  ask?: HomeNodeAskRuntime;
  service?: HomeNodeServiceRuntime;
}

export interface BootedServer {
  app: FastifyInstance;
  logger: Logger;
  config: BrainServerConfig;
  clients: BrainServerClients;
  schedulers: BrainServerSchedulers;
  compositions: BrainServerCompositions;
  dependencyStatus: BrainServerDependencyStatus;
  /** Present once server boot is wired to the shared Home Node runtime. */
  runtime?: HomeNodeRuntime;
  /** The socket address Fastify is listening on (e.g. "127.0.0.1:18200"). */
  boundAddress: string;
}

export interface BrainServerBootOptions {
  /** Already-composed ask coordinator. When supplied, boot registers /api/v1/ask routes. */
  askCoordinator?: AskCoordinator;
  /**
   * Server-resolved ask runtime dependencies. When supplied with a
   * configured Core client, boot builds the real Pattern A coordinator
   * from Core/AppView/LLM/approval dependencies and registers routes.
   * Explicit `askCoordinator` wins when both are supplied.
   */
  askRuntime?: HomeNodeAskRuntimeOptions;
  /**
   * Server-resolved service runtime dependencies. When supplied with a
   * configured Core client, boot composes the same shared Brain service
   * primitives mobile uses. Omit to keep service handling explicitly disabled.
   */
  serviceRuntime?: HomeNodeServiceRuntimeOptions;
  /** Route prefix for ask routes. Defaults to /api/v1. */
  askRoutePrefix?: string;
  /** Test hook for the staging-drain cadence timer. Production uses Node globals. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** Test hook paired with `setInterval`. */
  clearInterval?: (handle: unknown) => void;
}

export async function bootServer(
  env: NodeJS.ProcessEnv = process.env,
  options: BrainServerBootOptions = {},
): Promise<BootedServer> {
  installNodeTraceScopeStorage();

  // 1. config.
  const config = loadConfig(env);

  // 2. logger.
  const logger = createLogger(config);
  logger.info({ host: config.network.host, port: config.network.port }, 'brain-server boot');

  // The node owner's DID. Used as BOTH the ask command handler's
  // `requesterDid` AND the ask pipeline's `ownerDid` so the persona guard's
  // owner shortcut fires (requesterDid === ownerDid ⇒ no vault approval). The
  // SPA user IS the owner — the gatekeeper protects against external agents
  // only (memory: user-vs-agent-persona-access). Without passing `ownerDid`
  // here, the owner's own /ask hit `approval_required` on the first
  // vault_search and the agentic turn bailed before it could discover/dispatch
  // a service query.
  const ownerDid =
    process.env.DINA_OWNER_DID && process.env.DINA_OWNER_DID.trim() !== ''
      ? process.env.DINA_OWNER_DID.trim()
      : 'did:key:dina-lite-owner';

  // 4. core_client. Missing key material keeps readiness red; it does
  // not install a dummy signer or fake Core client.
  const coreResult = await buildCoreClient(config.core);
  if (coreResult.status === 'configured') {
    logger.info(
      { did: coreResult.did, keyFingerprint: coreResult.keyFingerprint },
      'brain-server Core client configured',
    );
  } else {
    logger.warn(
      { status: coreResult.status, detail: coreResult.detail },
      'brain-server Core client not configured',
    );
  }

  // 5. appview_client. Constructing the client is side-effect-free; it
  // stores the endpoint and fetch handle but does not touch the network
  // until Brain tools ask it to search/resolve.
  const clients: BrainServerClients = {
    appView: new AppViewClient({
      appViewURL: config.endpoints.appViewBaseUrl,
    }),
  };
  if (coreResult.core !== undefined) {
    clients.core = coreResult.core;
  }
  const schedulers: BrainServerSchedulers = {};
  const compositions: BrainServerCompositions = {};
  let chatRememberRuntime: ChatRememberRuntimeHandle | undefined;
  // Hoisted so both the staging drain (which builds rememberRuntime
  // from these descriptors) and the askRuntime path further down
  // (which feeds them into the pre-flight retrieval planner) can
  // share one source of truth. Populated inside the
  // `clients.core !== undefined` block below.
  let personaDescriptors: { name: string; description: string }[] = [];
  const dependencyStatus: BrainServerDependencyStatus = {
    appView: 'configured',
    core: coreResult.status,
    askRoutes: 'disabled',
    reminderRoutes: 'disabled',
    serviceRuntime: 'disabled',
    stagingDrain: 'disabled',
    webUI: 'disabled',
    runtime: 'pending',
  };

  if (clients.core !== undefined) {
    const core = clients.core;
    // Route brain's vault reads through Core HTTP. Mobile leaves this
    // unset so it uses the in-process queryVault fast-path; lite must
    // route through `core.vaultQuery` because vault SQLite lives in
    // core-server's process.
    setVaultReadBackend({
      vaultQuery: (persona, query) => core.vaultQuery(persona, query),
      vaultGet: (persona, itemId) => core.vaultGet(persona, itemId),
      vaultList: (persona, opts) => core.vaultList(persona, opts),
      vaultItemsForPerson: (persona, personId, limit) =>
        core.vaultItemsForPerson(persona, personId, limit),
    });

    // People-graph read backend — parallel to the vault backend. The
    // reasoning agent's `find_person` tool uses these handles to
    // resolve named individuals (Emma → daughter) without keyword-
    // guessing through vault items. Mobile leaves the backend null
    // and reads `getPeopleRepository()` in-process.
    setPeopleReadBackend({
      peopleList: () => core.peopleList(),
      peopleFindByName: (surface) => core.peopleFindByName(surface),
      peopleResolveByDid: (did) => core.peopleResolveByDid(did),
    });

    // Contact-directory read backend — the `contact_lookup` reasoning tool
    // resolves trust/sharing policy through Core (the directory lives in
    // core-server's process). Mobile reads the in-process directory.
    setContactReadBackend({
      contactLookup: (query) => core.contactLookup(query),
    });

    // Reminder backend — the reminder service's authoritative store
    // (in-memory Map + SQLiteReminderRepository) lives in core-server's
    // process. Route brain's create + read through Core so reminders
    // actually persist + fire. Mobile leaves this unset and calls the
    // in-process reminder service directly.
    setReminderBackend({
      reminderCreate: (input) => core.reminderCreate(input),
      reminderListByPersona: (persona) => core.reminderListByPersona(persona),
      reminderListPending: (now) => core.reminderListPending(now),
    });

    // Build the LLM runtime early so the staging drain can use it
    // for the per-item agentic loop (rememberRuntime below). The
    // ask coordinator further down reuses the same instance.
    const llmRuntime = options.askRuntime ?? buildBrainServerLLMRuntime(config.llm);

    // Mirror Core's persona registry into Brain's `accessiblePersonas`
    // state. Brain runs in a separate Node process from Core in lite,
    // so its in-process `listPersonas()` returns []. Without this
    // mirror, `vault_search` has no personas to fan out across.
    //
    // ALL personas are exposed to the in-app chat path, regardless of
    // tier or lock state — the SPA/mobile user is the owner and has
    // full access by definition. The gatekeeper's tier protections
    // exist only for external agents reaching Core via dina-agent CLI;
    // they don't apply to the user's own chat (see memory:
    // `user-vs-agent-persona-access`). The hardcoded
    // `['general', 'work']` this replaces was leaving `health` +
    // `finance` invisible to multi-domain synthesis (e.g. budget
    // context for a "what to buy" question).
    //
    // Failure to fetch is non-fatal — the boot continues with an empty
    // persona list and the operator sees the warning. Re-mirroring on
    // a schedule (or on persona-create push) is a future polish.
    let remotePersonas: { name: string; tier: string; isOpen: boolean }[] = [];
    try {
      remotePersonas = await core.personasList();
      const names = remotePersonas.map((p) => p.name);
      setAccessiblePersonas(names);
      // SECURITY: mirror persona TIERS into Brain's local persona
      // registry too — not just the accessible-names set. The agent
      // vault-read gate (`persona_guard` / `vault_tool`) reads tiers via
      // `getPersona` / `listPersonas`; in this split-process Brain that
      // registry is otherwise empty, so the gate would fail OPEN — every
      // sensitive/locked persona treated as not requiring approval. An
      // unrecognised tier is mirrored as `locked` (fail-closed).
      const VALID_TIERS = new Set<PersonaTier>(['default', 'standard', 'sensitive', 'locked']);
      for (const p of remotePersonas) {
        if (getPersona(p.name) !== null) continue; // already mirrored this process
        const tier: PersonaTier = VALID_TIERS.has(p.tier as PersonaTier)
          ? (p.tier as PersonaTier)
          : 'locked';
        try {
          createPersona(p.name, tier);
        } catch {
          // Invalid name / duplicate race — skip. `setAccessiblePersonas`
          // above still constrains what `vault_search` can reach.
        }
      }
      logger.info(
        { count: names.length, personas: names },
        'brain-server accessible personas + tiers mirrored from Core',
      );
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'brain-server persona mirror failed; vault_search will see no personas',
      );
      setAccessiblePersonas([]);
    }

    // Build the per-item remember runtime from the configured LLM. The
    // staging drain uses the agentic loop for every drained item (persona
    // routing, reminders, people links, preferences) — one LLM round-trip
    // per item. Dina is LLM-driven: when no LLM is configured the drain
    // stays unwired (below); there is NO non-LLM fallback.
    personaDescriptors = remotePersonas.map((p) => ({
      name: p.name,
      description: PERSONA_DESCRIPTIONS[p.name] ?? '',
    }));
    const rememberRuntime =
      llmRuntime !== undefined
        ? buildRememberRuntime({
            llm: llmRuntime.llm,
            personas: personaDescriptors,
            defaultPersona: 'general',
          })
        : undefined;
    if (rememberRuntime === undefined) {
      // Dina is LLM-driven: the staging drain REQUIRES the agentic
      // runtime (it throws per item without one — no non-LLM fallback).
      // With no LLM configured, leave the drain unwired so it never
      // claims items and marks them failed; staged items wait until a
      // provider is configured and the server restarts.
      logger.warn(
        {},
        'brain-server staging drain disabled — no LLM configured (Dina is LLM-driven; staged items stay queued until a provider is set up)',
      );
    } else {
      logger.info(
        { personaCount: personaDescriptors.length },
        'brain-server remember runtime configured (agentic /remember)',
      );

      const stagingDrain = new StagingDrainScheduler({
        core,
        drain: {
          // Out-of-process people-graph writer. Core owns SQLite in lite;
          // Brain's post-publish extractor POSTs the structured result
          // through the signed Core HTTP surface.
          peopleGraphApply: (result, persona) => core.peopleApplyExtraction(result, persona),
          rememberRuntime,
          // Surface a received peer message as a left-aligned bubble in the
          // main chat the moment it lands (known contacts only; unknown
          // senders go through the quarantine card). See inbound_d2d_chat.ts.
          onD2DMessage: postInboundD2DToMainChat,
        },
        logger: (entry) => logger.info(entry, 'brain-server staging drain'),
        onError: (err) => {
          logger.warn(
            { error: err instanceof Error ? err.message : String(err) },
            'brain-server staging drain tick failed',
          );
        },
        ...(options.setInterval !== undefined ? { setInterval: options.setInterval } : {}),
        ...(options.clearInterval !== undefined ? { clearInterval: options.clearInterval } : {}),
      });
      schedulers.stagingDrain = stagingDrain;

      // Wire the chat orchestrator's Core + drain hook through the
      // shared runtime so /remember replies on `/api/v1/chat` arrive
      // sub-second instead of waiting for a periodic tick. Same
      // helper mobile's bootstrap uses — one source of truth for the
      // run-tick + status-poll behaviour. We omit `lookupPendingApproval`
      // because the staging service lives in another process (Core);
      // the orchestrator falls back to a generic parked-row reply.
      chatRememberRuntime = wireChatRememberRuntime({
        core: clients.core,
        stagingDrain,
        maxAttempts: 8,
      });
    }
  }

  // fastify_start (scaffold — full route binding in tasks 5.3 – 5.49).
  const app = Fastify({ logger: false }); // we manage our own logger

  // Anti-DNS-rebinding Host allowlist (runs before every route). Guards the
  // whole unauthenticated /api/v1/* surface — including the state-mutating
  // agent-approval gate (approve/cancel) and owner-private reads (contacts,
  // workflow tasks) — from a browser tricked into treating an attacker
  // hostname as 127.0.0.1. See host_guard.ts.
  registerHostAllowlistGuard(app);

  app.addHook('onClose', async () => {
    schedulers.stagingDrain?.stop();
    chatRememberRuntime?.dispose();
    await compositions.service?.dispose();
  });
  // Freshness stamp — the epoch ms this Brain process booted. Relay E2E
  // uses it to detect a dina-node running STALE code (started before the
  // latest source edit) and skip LOUD instead of failing mid-flow, rather
  // than only probing liveness. A node on old code that lacks this field
  // is likewise treated as stale.
  const brainStartedAt = Date.now();
  app.get('/healthz', async () => ({ status: 'ok', role: 'brain', startedAt: brainStartedAt }));
  registerServiceSearchRoutes(app, { appView: clients.appView });

  if (options.serviceRuntime !== undefined) {
    if (clients.core === undefined) {
      logger.warn(
        { core: dependencyStatus.core },
        'brain-server service runtime disabled because Core client is not configured',
      );
    } else {
      const serviceSetInterval = options.serviceRuntime.setInterval ?? options.setInterval;
      const serviceClearInterval = options.serviceRuntime.clearInterval ?? options.clearInterval;
      compositions.service = buildHomeNodeServiceRuntime({
        ...options.serviceRuntime,
        core: clients.core,
        appView: clients.appView,
        ...(serviceSetInterval !== undefined ? { setInterval: serviceSetInterval } : {}),
        ...(serviceClearInterval !== undefined ? { clearInterval: serviceClearInterval } : {}),
        logger: (entry) => {
          options.serviceRuntime?.logger?.(entry);
          logger.info(entry, 'brain-server service');
        },
      });
      dependencyStatus.serviceRuntime = 'configured';
      logger.info('brain-server service runtime configured');
    }
  }

  const askRuntime = options.askRuntime ?? buildBrainServerLLMRuntime(config.llm);
  let askCoordinator = options.askCoordinator;
  if (askCoordinator === undefined && askRuntime !== undefined) {
    if (clients.core === undefined) {
      logger.warn(
        { core: dependencyStatus.core },
        'brain-server ask coordinator disabled because Core client is not configured',
      );
    } else {
      // Pre-flight retrieval planner — turns each `/ask` question
      // into a structured cross-domain plan before the agentic loop
      // runs. Mirrors the planner the mobile app wires; same router,
      // same prompt. Lite's fetchers route through Core's HTTP
      // surface (CoreClient.vaultQuery / peopleFindByName) because
      // Brain runs in a separate process and never opens SQLite
      // directly. Fail-soft at every step — any planner error /
      // empty plan / fetch failure falls back to the legacy
      // tools-only loop.
      const lookupPersonas = personaDescriptors;
      const liteCoreClient = clients.core;
      const retrievalFetchers = {
        async vaultSearch(persona: string, query: string) {
          const result = await liteCoreClient.vaultQuery(persona, {
            mode: 'fts5',
            text: query,
            limit: 5,
          });
          return result.items.map((item) => ({
            id: String(item.id ?? ''),
            content_l0: String(item.content_l0 ?? item.summary ?? ''),
            ...(typeof item.body === 'string' ? { body: item.body } : {}),
            persona,
          }));
        },
        async findPerson(name: string) {
          const matches = await liteCoreClient.peopleFindByName(name);
          return matches.map((p) => ({
            canonicalName: p.canonicalName,
            ...(p.relationshipHint !== '' ? { relationshipHint: p.relationshipHint } : {}),
            surfaceSummary: (p.surfaces ?? [])
              .filter((s) => s.status !== 'rejected')
              .map((s) => s.surface)
              .slice(0, 3)
              .join(', '),
          }));
        },
      };

      const ask = buildHomeNodeAskRuntime({
        ...askRuntime,
        core: clients.core,
        appView: clients.appView,
        logger: (entry) => logger.info(entry, 'brain-server ask'),
        installedPersonas: () => lookupPersonas,
        retrievalFetchers,
        // Owner shortcut for the vault persona guard — the SPA user is the
        // owner, so their /ask must never hit `approval_required` on vault_search.
        ownerDid,
        // Default fastPathMs (3 s). Async overflow is no longer a
        // problem: the SPA's chat_transport.web.ts subscribes to
        // `/api/v1/chat/stream` (SSE) and reflects every server-side
        // thread mutation — including late-arriving lifecycle
        // patches — into its local thread store via
        // `applyRemoteMessage`. Long-running queries (multi-Dina
        // service calls, multi-minute agent loops) deliver their
        // answer through the stream, not by holding the POST open.
      });
      compositions.ask = ask;
      askCoordinator = ask.coordinator;
      logger.info(
        { providerName: askRuntime.providerName },
        'brain-server ask coordinator configured',
      );
    }
  }
  if (askCoordinator !== undefined) {
    registerAskRoutes(app, {
      coordinator: askCoordinator,
      ...(options.askRoutePrefix !== undefined ? { prefix: options.askRoutePrefix } : {}),
    });
    dependencyStatus.askRoutes = 'configured';

    // Install the chat orchestrator's /ask command handler. Without
    // this, /ask falls through to a context-only template
    // (`buildContextOnlyAnswer` in chat_reasoning.ts) that just lists
    // vault items verbatim — no LLM synthesis. Mobile wires this in
    // its `globalWiring` step; we mirror that here so /ask through
    // the chat HTTP surface uses the agentic Gemini-backed pipeline.
    // requesterDid MUST equal the pipeline's `ownerDid` (above) so the persona
    // guard's owner shortcut fires for the SPA user's own /ask.
    const askCommandHandler = createCoordinatorAskHandler({
      coordinator: askCoordinator,
      requesterDid: ownerDid,
    });
    setAskCommandHandler(askCommandHandler.handler);
    app.addHook('onClose', async () => {
      askCommandHandler.dispose();
      resetAskCommandHandler();
    });
    logger.info('brain-server /ask command handler wired (agentic LLM)');
  }

  // Chat orchestrator routes — wraps `handleChat` from the brain
  // chat module so a browser dev UI can drive `/remember` + `/ask`
  // without a mobile build. Zero code duplication: the orchestrator
  // is the same one mobile uses in-process.
  //
  // `/dev` UI is opt-in via `DINA_BRAIN_DEV_UI=1` so production
  // operators don't accidentally expose it to the public listener.
  registerChatRoutes(app, {
    exposeDevUI: process.env.DINA_BRAIN_DEV_UI === '1',
  });

  // Tier-1 capability execution endpoint. The lite Core's reserved
  // `dina.local` runner posts claimed service-query executions here because
  // Core has no LLM. Runs the SHARED `makeTier1CapabilityRunner` — the same
  // runtime mobile runs in-process; vault_search + the persona registry it
  // needs are the module globals wired above (setVaultReadBackend + the
  // persona mirror). Core resolves + passes the listing config in the request,
  // so this route needs no Core round-trip.
  const capabilityLLM = buildBrainServerLLMRuntime(config.llm);
  registerCapabilityRoutes(app, {
    getLLM: () => capabilityLLM?.llm ?? null,
    // Core client → an APPROVED capability can persist its outcome to the
    // provider's vault (record_to_vault write tool) over Core HTTP.
    ...(clients.core !== undefined ? { core: clients.core } : {}),
    logger: (entry) => logger.info(entry, 'capability'),
  });

  // Reminder data layer for the SPA — proxies to core-server (which owns
  // the reminder store) via the CoreClient. The web reminder UI hits
  // these; mobile calls the in-process reminder service directly.
  if (clients.core !== undefined) {
    // Approval-inbox data layer for the SPA — proxies workflow-task reads +
    // the owner approve/cancel decisions to core-server. The web Activity →
    // Needs-action inbox hits these; mobile calls Core in-process. Without
    // this the SPA reads the empty in-browser store (F4 — "All caught up"
    // despite Core having pending agent-approval tasks).
    registerWorkflowApiRoutes(app, { core: clients.core });

    // Contact-directory data layer for the SPA's People/Talk screen (F4).
    registerContactApiRoutes(app, { core: clients.core });

    // Service-config (My Services publish) data layer for the SPA. `/v1/service/*`
    // is brain-allowed, so the Brain forwards the provider's own listing
    // read/write here; the web My-Services form (useServiceConfigForm) targets it.
    registerServiceConfigProxyRoutes(app, { core: clients.core });

    // Quarantine-review data layer for the SPA's InlineQuarantineCard (F4).
    registerQuarantineApiRoutes(app, { core: clients.core });

    const reminderHub = registerReminderApiRoutes(app, { core: clients.core });
    // Server-side fire loop: the browser can't run a reliable background
    // timer, so the server fires due reminders + pushes them to the SPA
    // over the SSE stream. Mobile fires in-process and ignores all this.
    const stopFireLoop = startReminderFireLoop({
      core: clients.core,
      hub: reminderHub,
      onError: (err) =>
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'reminder fire loop tick failed',
        ),
    });
    app.addHook('onClose', async () => stopFireLoop());
    dependencyStatus.reminderRoutes = 'configured';

    // R4-03 — the durable notification inbox on the split server. Brain's inbox
    // dual-writes THROUGH Core's `/v1/notifications` routes (identity.sqlite) so
    // watch/push notifications survive restart here too; hydrate replays them into
    // the in-process inbox at boot. The SPA reads them over `/api/v1/notifications`
    // + SSE (the proper silence-tiered surface, not chat), and Tier-3 items reach
    // the daily briefing via the notification-backed engagement provider.
    // Round-A A-07 — the owner run/watch byte-pipe: forwards the SPA's owner
    // calls (with the browser-presented capability header) verbatim to Core.
    // Brain holds no owner authority; Core validates every request. Round-B
    // B-02: OFF by default so no owner credential transits Brain unless an
    // operator opts in (`DINA_BRAIN_OWNER_PROXY=1`) — the credential-safe path
    // is the Core-served owner console (`DINA_CORE_OWNER_CONSOLE=1`). Opting in
    // accepts that a compromised Brain could skim the reusable bearer.
    if (process.env.DINA_BRAIN_OWNER_PROXY === '1') {
      registerOwnerProxyRoutes(app, { coreBaseUrl: config.core.baseUrl });
      logger.info(
        {},
        'owner run/watch proxy enabled (DINA_BRAIN_OWNER_PROXY=1) — the owner capability transits Brain; prefer the Core-served owner console for strict isolation',
      );
    }

    const notificationRepo = new CoreClientNotificationLogRepository(clients.core);
    setNotificationLogRepository(notificationRepo);
    registerEngagementProvider(collectNotificationBriefingItems);
    registerNotificationApiRoutes(app);
    try {
      await hydrateNotifications();
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'notification hydrate failed',
      );
    }
    // Round-A A-06 — CONTINUOUS Core→Brain reconciliation. On the split server
    // the CORE process appends run notifications (classified actions,
    // response_lost) to the durable log in ITS process; without this poll they
    // reached Brain's inbox — and therefore the SPA's list + SSE stream — only
    // after a Brain restart. The merge upserts by id (idempotent) and fires
    // `appended` for each NEW row, so connected SSE clients get it live.
    // 15s keeps a pending run decision from sitting invisible; a failed poll is
    // logged and retried next tick.
    const notificationReconcile = setInterval(() => {
      void notificationRepo
        .listAll()
        .then((rows) => {
          mergeNotifications(rows);
        })
        .catch((err: unknown) => {
          logger.debug(
            { error: err instanceof Error ? err.message : String(err) },
            'notification reconcile poll failed (retrying next tick)',
          );
        });
    }, 15_000);
    notificationReconcile.unref();
  }

  // SPA bundle serving. Opt-in via `DINA_BRAIN_WEB_UI=1` — same gate
  // philosophy as `/dev`. The bundle is produced by `npx expo export
  // --platform web` from `apps/mobile/`; default location is the
  // sibling `apps/home-node-lite/web/dist/` directory so a `git pull`
  // of a freshly built tree just works without env overrides.
  //
  // We swallow "bundle missing" rather than crash boot: the brain
  // server has plenty of value (chat API, ask API) without the UI,
  // and the operator's first signal that something's wrong is the
  // `webUI: 'missing_bundle'` flag in `/readyz`.
  if (process.env.DINA_BRAIN_WEB_UI === '1') {
    const bundleDir =
      process.env.DINA_BRAIN_WEB_BUNDLE_DIR ?? path.resolve(__dirname, '..', '..', 'web', 'dist');
    try {
      const result = await registerWebRoutes(app, { bundleDir });
      dependencyStatus.webUI = 'configured';
      logger.info(
        { bundleDir: result.bundleDir, urlPrefix: result.urlPrefix },
        'brain-server web UI configured',
      );
    } catch (err) {
      dependencyStatus.webUI = 'missing_bundle';
      logger.warn(
        { bundleDir, error: err instanceof Error ? err.message : String(err) },
        'brain-server web UI requested but bundle is missing — /web/ will 404 until built',
      );
    }
    // The web thin-client can't call the AppView directly (sovereignty + CORS),
    // so it fetches PeerLens reads at this same-origin path and we forward them
    // to the AppView server-side. Web-only: registered under the same web-UI
    // gate. Native keeps calling the AppView directly.
    registerPeerlensProxyRoutes(app, {
      appViewURL: config.endpoints.appViewBaseUrl,
      logger,
    });
    logger.info(
      { appViewURL: config.endpoints.appViewBaseUrl, path: '/api/peerlens/xrpc/*' },
      'brain-server PeerLens read proxy configured (web thin-client)',
    );
  }

  app.get('/readyz', async (_req, reply) => {
    const checks = {
      appView: 'ok' as const,
      core: dependencyStatus.core === 'configured' ? ('ok' as const) : ('fail' as const),
      askRoutes:
        dependencyStatus.askRoutes === 'configured' ? ('ok' as const) : ('disabled' as const),
      serviceRuntime:
        dependencyStatus.serviceRuntime === 'configured' ? ('ok' as const) : ('disabled' as const),
      stagingDrain:
        dependencyStatus.stagingDrain === 'running' ? ('ok' as const) : ('disabled' as const),
      webUI:
        dependencyStatus.webUI === 'configured'
          ? ('ok' as const)
          : dependencyStatus.webUI === 'missing_bundle'
            ? ('missing_bundle' as const)
            : ('disabled' as const),
      runtime: dependencyStatus.runtime === 'ok' ? ('ok' as const) : ('fail' as const),
    };
    // Ready when boot completed (`runtime === 'ok'`) AND Core is wired.
    // Without Core the server is a stub: no vault, no D2D, no ask path
    // worth exposing. AppView/askRoutes/service/staging are tracked for
    // diagnostics but only Core+runtime gate readiness.
    const ready = checks.runtime === 'ok' && checks.core === 'ok';
    await reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'not_ready',
      role: 'brain',
      checks,
    });
  });

  // SECURITY: the brain HTTP surface (api / chat / ask / reminder / web) is
  // UNAUTHENTICATED — a localhost-only analyst API by design (mobile drives it
  // in-process; the SPA proxies through loopback). Binding it to a non-loopback
  // interface would expose vault-write paths (e.g. /remember) + the LLM to the
  // network with no auth. Fail closed: refuse a non-loopback bind unless an
  // operator explicitly opts in (e.g. a trusted authenticating reverse proxy
  // fronts it). The default host is 127.0.0.1, so normal deployments are
  // unaffected.
  if (!isLoopbackHost(config.network.host) && process.env.DINA_BRAIN_ALLOW_NONLOOPBACK !== '1') {
    throw new Error(
      `brain-server refuses to bind to non-loopback host "${config.network.host}": its HTTP API is ` +
        `unauthenticated and localhost-only by design. Front it with an authenticating proxy and set ` +
        `DINA_BRAIN_ALLOW_NONLOOPBACK=1 to override.`,
    );
  }

  const boundAddress = await app.listen({
    host: config.network.host,
    port: config.network.port,
  });
  if (schedulers.stagingDrain !== undefined) {
    schedulers.stagingDrain.start();
    dependencyStatus.stagingDrain = 'running';
  }
  compositions.service?.start();
  // Boot finished — `/readyz` now reflects "runtime ok" rather than
  // "pending". The overall ready/not-ready code still depends on Core,
  // so a Core-less boot stays 503 (with runtime: 'ok', core: 'fail').
  dependencyStatus.runtime = 'ok';
  logger.info({ boundAddress }, 'brain-server listening');

  return { app, logger, config, clients, schedulers, compositions, dependencyStatus, boundAddress };
}
