/**
 * `/api/v1/providers/status` — the SPA's AI-provider status (D7).
 *
 * In thin-client mode the LLM runs SERVER-SIDE: the brain-server holds the
 * provider key (env / deploy config), the web chat is proxied. So the
 * provider key must NEVER live in the browser (no IndexedDB key). Mirroring
 * D3 (change-passphrase hidden on web because the server owns the seed),
 * the web AI-providers screen is read-only on web: it reads the server's
 * provider status here instead of managing a browser-local key.
 *
 *   GET /api/v1/providers/status → { provider, configured, source, model, last4 }
 *
 * Strictly redacted: the API key itself is NEVER returned — only the
 * provider name, whether one is configured, where it came from, the model,
 * and the last 4 chars for "Gemini ••••1234"-style display. Gated by the
 * D4 web access gate (this is under /api/v1).
 *
 * D7 RESOLVED (the design's only open decision — "where does the provider key
 * live so web + mobile BYOK don't fork?"). Resolution: **the key lives with the
 * LLM that uses it.** Mobile runs the LLM ON-DEVICE → key in the device keychain
 * (hardware-backed). The server (and therefore the web thin client) runs the LLM
 * SERVER-SIDE → key in the brain's resolved LLM config — ONE server-side location
 * (env today; Core's encrypted keystore once the BYOK write path lands, with
 * `source` already able to flip to `'byok'`). The browser, having NO LLM, holds
 * NO key — so there is no fork to reconcile, and a stolen browser session can at
 * worst *use* the node's model budget, never *exfiltrate* the key.
 *
 * Deferred (follow-up, NOT part of the D7 decision): the BYOK WRITE path
 * (POST/DELETE a key → Core's encrypted store) + dynamic LLM-runtime reload
 * (invasive — the runtime is built once at boot from `config.apiKey`, so a
 * runtime key change needs the ask-coordinator rebuilt). The web AI-providers
 * SCREEN should consume this status read-only (not offer browser-local key
 * entry) when the write path lands.
 */

import type { BrainServerConfig } from '../config';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RegisterProviderApiRoutesOptions {
  /** The brain's resolved LLM config (provider + key + model). */
  llm: BrainServerConfig['llm'];
  /** Route prefix override (defaults to `/api/v1`). */
  prefix?: string;
}

export interface ProviderStatus {
  /** Provider name: `'none'` when unconfigured. */
  provider: string;
  /** True when a usable provider + key is configured server-side. */
  configured: boolean;
  /** Where the key came from. `'env'` today; `'byok'` once the write path lands. */
  source: 'env' | 'none';
  /** Default model, when the provider sets one. */
  model: string | null;
  /** Last 4 chars of the key for redacted display, or null. NEVER the key. */
  last4: string | null;
}

export function registerProviderApiRoutes(
  app: FastifyInstance,
  opts: RegisterProviderApiRoutesOptions,
): void {
  const prefix = opts.prefix ?? '/api/v1';
  const { llm } = opts;

  app.get(`${prefix}/providers/status`, async (_req: FastifyRequest, reply: FastifyReply) => {
    if (llm.provider === 'none') {
      const status: ProviderStatus = {
        provider: 'none',
        configured: false,
        source: 'none',
        model: null,
        last4: null,
      };
      return reply.status(200).send(status);
    }
    const status: ProviderStatus = {
      provider: llm.provider,
      configured: true,
      source: 'env',
      model: llm.model ?? null,
      last4: llm.apiKey.length >= 4 ? llm.apiKey.slice(-4) : null,
    };
    return reply.status(200).send(status);
  });
}
