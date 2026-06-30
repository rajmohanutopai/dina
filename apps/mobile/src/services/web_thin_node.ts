/**
 * Web thin-client boot — the WEB build's replacement for `bootAppNode`.
 *
 * On web, Dina is a thin client of a home-node-lite brain-server (see
 * `docs/WEB_THIN_CLIENT_DESIGN.md`). The browser runs NO node: no
 * `createCoreRouter`, no SQLite, no in-memory repos, no in-browser Brain
 * subsystems (workflow sweepers, staging drain, MsgBox, MemoryService).
 * All of that lives on the server. The browser only needs a `CoreClient`
 * that proxies to the brain-server's `/api/v1/*` routes — that's
 * `BrowserCoreProxyClient`.
 *
 * `useNodeBootstrap` branches on `Platform.OS === 'web'` and calls this
 * instead of `bootAppNode`. The mobile-native boot path is completely
 * untouched (this module is never invoked on native).
 *
 * **Why a no-op subsystem shell.** `DinaNode` (the type the whole app
 * consumes via `getBootedNode()`) requires `workflowService`,
 * `orchestrator`, `handler`, `dispatcher`, and `runners`. On web those
 * are server-side, so the web node provides inert stubs that THROW if
 * ever invoked (a UI path reaching them on web is a bug — chat/ask are
 * proxied to the server, never run in-browser). Only `coreClient`,
 * `did`, and `role` are real; lifecycle methods (`start`/`stop`/
 * `drainOnce`/`dispose`) are no-ops because there is nothing to
 * start/poll/tear-down in the browser. This keeps `getBootedNode()`
 * returning a plain `DinaNode` so no consumer needs a web-specific type.
 *
 * **No degradations.** Because the browser composes no in-memory repos,
 * there is nothing to be "in-memory" → no degradation → the old "limited
 * mode / no SQLite" banner can never appear (design §4, principle 1).
 */

import { BrowserCoreProxyClient } from '@dina/core';

import {
  setServiceConfigCoreClient,
  resetServiceConfigCoreClient,
} from '../hooks/useServiceConfigForm';
import { setInboxCoreClient, resetInboxCoreClient } from '../hooks/useServiceInbox';

import type { BootResult } from './boot_service';
import type { DinaNode, NodeRole } from './bootstrap';

/** Default same-origin brain-server proxy base. */
const DEFAULT_API_BASE = '/api/v1';

export interface BootWebThinNodeOptions {
  /** Brain-server proxy base. Same-origin `/api/v1` by default. */
  baseUrl?: string;
  /** Injected fetch (tests stub it; production uses the global). */
  fetch?: typeof globalThis.fetch;
  /**
   * Node role for tab gating. The server does not yet expose its role via
   * `/api/v1/identity`, so web defaults to `'both'` (show every tab).
   * Provider/requester tab gating on web is a later refinement.
   */
  role?: NodeRole;
}

/**
 * A subsystem stub that throws on ANY access. Used for the Brain
 * machinery that only runs server-side; reaching it in the browser is a
 * bug, so fail loudly instead of silently no-op'ing.
 */
function unsupportedSubsystem<T>(label: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(
            `DinaNode.${label}.${String(prop)} is not available in the web thin-client — ` +
              `it runs on the brain-server. (web thin-client design §4)`,
          );
        };
      },
    },
  ) as unknown as T;
}

const noop = async (): Promise<void> => {
  /* nothing to start/stop/drain/dispose in the browser */
};

/**
 * Build a `DinaNode`-shaped thin shell around a `BrowserCoreProxyClient`.
 * Exported for unit tests; production goes through `bootWebThinNode`.
 */
export function makeWebThinNode(args: {
  did: string;
  role: NodeRole;
  coreClient: DinaNode['coreClient'];
  /**
   * Teardown hook invoked by `dispose()`. `bootWebThinNode` passes the
   * global-state reset here so re-booting (e.g. identity switch) doesn't
   * leave a stale `CoreClient` wired into the inbox / service-config
   * singletons. Default = no-op (direct test construction installs no
   * globals, so there is nothing to reset).
   */
  onDispose?: () => void;
}): DinaNode {
  const onDispose = args.onDispose;
  return {
    did: args.did,
    role: args.role,
    coreClient: args.coreClient,
    // Brain machinery — server-side only; inert in the browser.
    workflowService: unsupportedSubsystem<DinaNode['workflowService']>('workflowService'),
    orchestrator: unsupportedSubsystem<DinaNode['orchestrator']>('orchestrator'),
    handler: unsupportedSubsystem<DinaNode['handler']>('handler'),
    dispatcher: unsupportedSubsystem<DinaNode['dispatcher']>('dispatcher'),
    runners: {
      events: unsupportedSubsystem<DinaNode['runners']['events']>('runners.events'),
      approvals: unsupportedSubsystem<DinaNode['runners']['approvals']>('runners.approvals'),
      taskExpiry: unsupportedSubsystem<DinaNode['runners']['taskExpiry']>('runners.taskExpiry'),
      leaseExpiry: unsupportedSubsystem<DinaNode['runners']['leaseExpiry']>('runners.leaseExpiry'),
      bridgeRetry: unsupportedSubsystem<DinaNode['runners']['bridgeRetry']>('runners.bridgeRetry'),
      stagingDrain: null,
      localRunner: null,
    },
    start: noop,
    stop: noop,
    drainOnce: noop,
    dispose:
      onDispose !== undefined
        ? async (): Promise<void> => {
            onDispose();
          }
        : noop,
  };
}

/**
 * Boot the web thin client: discover the server node's identity via
 * `GET /api/v1/identity`, then wrap a `BrowserCoreProxyClient` in a thin
 * `DinaNode` shell. Throws when the brain-server is unreachable or the
 * node has no identity — the caller renders the "No Home Node reachable"
 * screen in that case (design D2).
 */
export async function bootWebThinNode(options: BootWebThinNodeOptions = {}): Promise<BootResult> {
  const coreClient = new BrowserCoreProxyClient({
    baseUrl: options.baseUrl ?? DEFAULT_API_BASE,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });

  // Liveness + identity probe. A network error (server down) or a null
  // DID (node has no identity yet) both mean "no Home Node reachable".
  const identity = await coreClient.identity();
  if (identity.did === null || identity.did === '') {
    throw new Error(
      'web thin-client: the Home Node has no identity yet ' +
        '(GET /api/v1/identity returned a null DID). Is the core-server provisioned?',
    );
  }

  // Install the app-layer CoreClient singletons the SPA reads through.
  // Native does this in `bootstrap.ts` (`installChatGlobals`); the web boot
  // composes no node, so it must wire them here or the service-listing
  // ("My Services") + approval-inbox screens fall back to their
  // not-configured error state even though the proxy routes exist.
  setInboxCoreClient(coreClient);
  setServiceConfigCoreClient(coreClient);

  const node = makeWebThinNode({
    did: identity.did,
    role: options.role ?? 'both',
    coreClient,
    // Clear the singletons on teardown so an identity switch / re-boot
    // never leaves the previous node's proxy client wired in.
    onDispose: () => {
      resetInboxCoreClient();
      resetServiceConfigCoreClient();
    },
  });

  // No in-memory repos were composed → nothing degraded → no banner.
  return { node, degradations: [] };
}
