import type { DrizzleDB } from '@/db/connection.js'
import { readBoolFlag } from '@/db/queries/appview-config.js'

/**
 * `trust_v1_enabled` kill-switch gate for the xRPC surface (TN-FLAG-003 /
 * Plan §13.10).
 *
 * The trust feature ships ON by default; an operator flips OFF with
 * `dina-admin trust disable` (TN-FLAG-002) to roll back a problematic
 * deploy. When OFF:
 *   - Ingester drops `com.dina.trust.*` records (TN-FLAG-004 / TN-ING-004)
 *   - Scorer cron jobs become no-ops (TN-SCORE-010)
 *   - **xRPC handlers return 503** (this module)
 *
 * Without this gate, an operator could disable ingestion + scoring but
 * AppView would still serve stale data from before the flag flip — that
 * defeats the kill-switch. The 503 forces clients to back off and
 * surfaces the disabled state to ops dashboards (5xx error rate spikes).
 *
 * **Scope = trust namespace only**. `com.dina.service.*` is the service
 * registry (provider discovery, capability schemas) — independent of
 * the trust V1 ramp and should keep working when trust is disabled.
 * The gate is a prefix check on the methodId, not a global block.
 *
 * **Direct DB read, no caching**. The xRPC layer is much lower volume
 * than the ingester firehose (10²–10³ req/min vs 10⁵+ events/sec); a
 * single PK lookup against `appview_config` is ~0.1ms. Caching would
 * delay kill-switch propagation by the cache TTL — unacceptable for a
 * surface whose entire purpose is incident response. The cached reader
 * (`feature-flag-cache.ts`) explicitly documents this policy.
 *
 * **Closed-default on DB error**. If the flag read throws (transient
 * pg error, connection blip), we return 503 — same posture as the
 * scorer (TN-SCORE-010). Failing open would risk serving trust data
 * the operator just disabled. Failing closed costs us a few seconds
 * of unnecessary 503s during a blip; failing open could leak data
 * during a deliberate disable. Asymmetric — pick the safer side.
 */

const TRUST_NAMESPACE_PREFIX = 'com.dina.trust.'

export interface GateAllowed {
  readonly ok: true
}

export interface GateDenied {
  readonly ok: false
  readonly status: number
  readonly body: { readonly error: string; readonly message: string }
}

export type GateResult = GateAllowed | GateDenied

/**
 * Check whether the given xRPC method is permitted under the current
 * `trust_v1_enabled` flag state. Methods outside `com.dina.trust.*` are
 * always permitted — this gate only applies to the trust surface.
 *
 * Returns `{ ok: true }` if the request should proceed to the handler;
 * `{ ok: false, status, body }` if the dispatcher should write the
 * given HTTP status + JSON body and stop.
 */
export async function gateTrustNamespace(
  db: DrizzleDB,
  methodId: string,
): Promise<GateResult> {
  if (!methodId.startsWith(TRUST_NAMESPACE_PREFIX)) {
    return { ok: true }
  }
  let enabled: boolean
  try {
    enabled = await readBoolFlag(db, 'trust_v1_enabled')
  } catch {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'ServiceUnavailable',
        message: 'Trust V1 status unavailable',
      },
    }
  }
  if (!enabled) {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'ServiceUnavailable',
        message: 'Trust V1 is currently disabled',
      },
    }
  }
  return { ok: true }
}
