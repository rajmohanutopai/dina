/**
 * OpenRouter provisioning adapter — the real `KeyProvisioner`.
 *
 * Uses the management ("provisioning") API to mint runtime keys with a
 * hard spend cap. The provisioning key is THE crown-jewel secret of
 * this service: it never leaves this module's Authorization header and
 * is never logged.
 *
 * NOTE (build-plan step 1): the exact response field names below follow
 * OpenRouter's documented key-management API; the live-verification
 * pass with a real provisioning key must confirm them before prod
 * deploy. The adapter is deliberately tolerant: it accepts both the
 * documented `{ key, data: { hash } }` shape and flat variants, and
 * fails CLOSED (throws → pipeline returns provisioning_unavailable).
 */

import type { KeyProvisioner } from './ports';

export interface OpenRouterProvisionerOptions {
  provisioningKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class OpenRouterProvisioner implements KeyProvisioner {
  private readonly opts: Required<Pick<OpenRouterProvisionerOptions, 'baseUrl'>> &
    OpenRouterProvisionerOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenRouterProvisionerOptions) {
    this.opts = { baseUrl: 'https://openrouter.ai/api/v1', ...opts };
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createCappedKey(args: { limitUsd: number; label: string }): Promise<{
    key: string;
    orKeyId: string;
  }> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.provisioningKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: args.label, limit: args.limitUsd }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`openrouter key creation failed: HTTP ${res.status}`);
    }
    const raw: unknown = await res.json();
    const parsed = extractKey(raw);
    if (parsed === null) {
      throw new Error('openrouter key creation: unrecognized response shape');
    }
    return parsed;
  }
}

/** Tolerant response extraction — exported for tests. */
export function extractKey(raw: unknown): { key: string; orKeyId: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const key =
    typeof r.key === 'string' && r.key !== ''
      ? r.key
      : typeof (r.data as Record<string, unknown> | undefined)?.key === 'string'
        ? ((r.data as Record<string, unknown>).key as string)
        : null;
  if (key === null || key === '') return null;
  const data = (r.data ?? {}) as Record<string, unknown>;
  const orKeyId =
    typeof data.hash === 'string' && data.hash !== ''
      ? data.hash
      : typeof r.hash === 'string' && r.hash !== ''
        ? r.hash
        : typeof data.id === 'string' && data.id !== ''
          ? data.id
          : null;
  // FAIL CLOSED on a missing key id: the ledger's or_key_id is the ONLY
  // handle the abuse response has to disable a key (review P3). A grant
  // we can't later revoke must not be minted.
  if (orKeyId === null) return null;
  return { key, orKeyId };
}
