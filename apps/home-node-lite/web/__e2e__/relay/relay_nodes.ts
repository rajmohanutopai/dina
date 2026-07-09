/**
 * Relay-tier node helper — the two-human `dina-nodes/` setup (§3.2, §9.5).
 *
 * The relay tier drives two REAL Home Node Lite nodes (alonso, sancho) that run
 * out-of-process via `dina-nodes/` (provision + start + connect) against the
 * cloud test relay. Each node = a `did:plc`, a Core (debug-dispatch enabled), a
 * Brain, and a web SPA. This helper wraps: per-node backstage dispatch, a
 * reachability probe (so relay flows SKIP LOUDLY when the nodes aren't running,
 * never silently pass — §10.5), and DID resolution.
 */

export interface RelayNode {
  name: string;
  web: string; // SPA URL
  core: string; // Core (debug-dispatch) URL
  brain: string; // Brain URL (SPA API + healthz)
}

export const NODES: Record<'alonso' | 'sancho', RelayNode> = {
  alonso: { name: 'alonso', web: 'http://127.0.0.1:8401/web/', core: 'http://127.0.0.1:8301', brain: 'http://127.0.0.1:8401' },
  sancho: { name: 'sancho', web: 'http://127.0.0.1:8402/web/', core: 'http://127.0.0.1:8302', brain: 'http://127.0.0.1:8402' },
};

/**
 * Debug-channel headers. Attaches the fenced `x-debug-token` when the relay
 * stack requires one (`DINA_DEBUG_TOKEN` in env). Without it a token-gated Core
 * returns 403 and any backstage step would fail mid-flow — `relayReachable`
 * probes with these same headers and treats a 403 as NOT reachable, so the
 * tier skips LOUD instead. Shared by every debug-endpoint caller (dispatch, the
 * reachability probe, spec-level seeds like quarantine-seed).
 */
export function debugHeaders(): Record<string, string> {
  const token = process.env.DINA_DEBUG_TOKEN;
  return {
    'content-type': 'application/json',
    ...(token !== undefined && token !== '' ? { 'x-debug-token': token } : {}),
  };
}

/** Run any Core route as the in-process owner (debug-dispatch, §8). */
export async function dispatch(
  node: RelayNode,
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${node.core}/v1/debug/dispatch`, {
    method: 'POST',
    headers: debugHeaders(),
    body: JSON.stringify({ method, path, query: opts.query ?? {}, body: opts.body }),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: number; body?: unknown };
  return { status: body.status ?? res.status, body: body.body ?? body };
}

/**
 * True when BOTH nodes are fully reachable for relay flows — the gate for
 * `test.skip`. Every relay flow drives the browser (Brain/web) AND backstage
 * via Core's `/v1/debug/dispatch`, so a Brain-only healthz probe is
 * insufficient: a node whose Brain is up but whose Core is down — or whose
 * debug-dispatch is disabled (DINA_DEBUG_MODE off) — would pass the gate and
 * then FAIL mid-flow instead of skipping LOUD. So probe, per node: Brain
 * healthz, Core healthz, AND that debug-dispatch actually answers (a disabled
 * route returns 404 through the dispatch wrapper).
 */
export async function relayReachable(): Promise<boolean> {
  const nodeReachable = async (node: RelayNode): Promise<boolean> => {
    try {
      const [brainOk, coreOk] = await Promise.all([
        fetch(`${node.brain}/healthz`).then((r) => r.ok).catch(() => false),
        fetch(`${node.core}/healthz`).then((r) => r.ok).catch(() => false),
      ]);
      if (!brainOk || !coreOk) return false;
      // Debug-dispatch must be ENABLED — relay backstage runs through it. Probe
      // ROUTE-AGNOSTICALLY (different relay flows dispatch different routes on
      // different nodes, and node builds vary in which feature routes they
      // carry): POST the dispatch endpoint with a bogus wrapped path. An ENABLED
      // dispatch processes it and reports the WRAPPED path missing ("no route
      // for GET /__relay…"); a DISABLED one 404s the dispatch ENDPOINT itself,
      // whose error names `/v1/debug/dispatch`. So dispatch is up iff the error
      // is NOT about the dispatch endpoint.
      const res = await fetch(`${node.core}/v1/debug/dispatch`, {
        method: 'POST',
        headers: debugHeaders(),
        body: JSON.stringify({
          method: 'GET',
          path: '/__relay_reachable_probe__',
          query: {},
          body: null,
        }),
      });
      // Token-gated debug channel with no/invalid DINA_DEBUG_TOKEN → 403. We
      // CAN'T run backstage without it, so treat it as NOT reachable → skip
      // LOUD rather than fail mid-flow on the first dispatch.
      if (res.status === 403) return false;
      const text = await res.text().catch(() => '');
      return !text.includes('/v1/debug/dispatch');
    } catch {
      return false;
    }
  };
  const [a, s] = await Promise.all([nodeReachable(NODES.alonso), nodeReachable(NODES.sancho)]);
  return a && s;
}

/**
 * Resolve `node`'s own `did:plc` by reading `peer`'s contact directory (which
 * lists `node` by the mutual `connect.sh` link). Uses the F4 brain contacts
 * proxy — so it also exercises that fix. `connect.sh` is a relay prerequisite.
 */
export async function nodeDid(node: RelayNode, peer: RelayNode): Promise<string> {
  const r = await fetch(`${peer.brain}/api/v1/contacts`);
  if (!r.ok) throw new Error(`relay: cannot read ${peer.name} contacts (${r.status})`);
  const body = (await r.json()) as { contacts?: { displayName: string; did: string }[] };
  const match = (body.contacts ?? []).find(
    (c) => c.displayName.toLowerCase() === node.name.toLowerCase(),
  );
  if (match === undefined) {
    throw new Error(`relay: ${peer.name} has no contact for ${node.name} (run connect.sh)`);
  }
  return match.did;
}
