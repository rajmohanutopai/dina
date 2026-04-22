/**
 * HTTP harness for remote-implementation pass/fail reports (task 10.16).
 *
 * Stands up a minimal HTTP server so an external Dina implementation
 * can fetch the reference's conformance state (index, vectors, report)
 * without checking out this repo or running Jest. External runners
 * (in Go, Rust, Python, Swift…) pull from this server, run their own
 * verifiers against the same vectors, and compare outputs.
 *
 * **Endpoints**:
 *
 *   GET /healthz
 *     → 200 `{status:"ok"}` — liveness probe.
 *
 *   GET /vectors
 *     → 200 index.json.
 *
 *   GET /vectors/:name
 *     → 200 the named vector JSON (:name matches the `slot` minus the
 *       `.json` extension, e.g. `ed25519_sign_verify`).
 *     → 404 if absent or non-frozen.
 *
 *   GET /report
 *     → 200 the full ConformanceReport — re-runs the suite on each call.
 *     → query param `?format=text` returns the human-readable rendering.
 *
 *   GET /features
 *     → 200 list of feature names covered by frozen vectors — a shortcut
 *       for implementations deciding what they claim L1/L2/L3 against.
 *
 * **Zero runtime deps** at the module boundary. Uses `node:http` only;
 * the verifiers themselves already depend on `@noble/hashes`,
 * `@scure/base`, and `libsodium-wrappers` (devDeps of this package).
 *
 * **CORS**: every response carries `Access-Control-Allow-Origin: *`.
 * External runners may be running in another process / another host;
 * relaxing CORS here is safe because this harness only SERVES frozen
 * public test data. There's no authentication, no mutable state.
 *
 * **No listeners at module load.** Importing this file does NOT bind
 * a port — `createHarness` + `server.listen(port)` are the side-effects
 * callers opt into. Keeps the Jest test importable without eating a port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatReport, runConformance, type ConformanceReport } from './suite';

interface Index {
  version: string;
  updated: string;
  vectors: Array<{
    name: string;
    slot: string;
    level: string;
    task: string;
    status: string;
  }>;
}

export interface HarnessOptions {
  /** Directory containing `index.json` + `<name>.json` vectors. */
  vectorsDir: string;
}

export interface Harness {
  server: Server;
  /** Tear down the HTTP server — `await close()` to rebind the port. */
  close(): Promise<void>;
}

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

const TEXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string>): void {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), JSON_HEADERS);
}

function handle(req: IncomingMessage, res: ServerResponse, opts: HarnessOptions): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  // Only GET is supported. Reject everything else.
  if (req.method !== 'GET') {
    sendJSON(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
    return;
  }

  if (pathname === '/healthz') {
    sendJSON(res, 200, { status: 'ok', service: '@dina/protocol-conformance-harness' });
    return;
  }

  if (pathname === '/vectors') {
    try {
      const index = readFileSync(join(opts.vectorsDir, 'index.json'), 'utf8');
      res.writeHead(200, JSON_HEADERS);
      res.end(index);
    } catch (err) {
      sendJSON(res, 500, { error: 'index_read_failed', detail: (err as Error).message });
    }
    return;
  }

  const vectorMatch = pathname.match(/^\/vectors\/([a-z0-9_]+)$/);
  if (vectorMatch) {
    const name = vectorMatch[1]!;
    try {
      const index = JSON.parse(readFileSync(join(opts.vectorsDir, 'index.json'), 'utf8')) as Index;
      const entry = index.vectors.find((v) => v.name === name);
      if (!entry) { sendJSON(res, 404, { error: 'unknown_vector', name }); return; }
      if (entry.status !== 'frozen') {
        sendJSON(res, 404, { error: 'vector_not_frozen', name, status: entry.status });
        return;
      }
      const body = readFileSync(join(opts.vectorsDir, entry.slot), 'utf8');
      res.writeHead(200, JSON_HEADERS);
      res.end(body);
    } catch (err) {
      sendJSON(res, 500, { error: 'vector_read_failed', detail: (err as Error).message });
    }
    return;
  }

  if (pathname === '/report') {
    const format = url.searchParams.get('format');
    try {
      const report: ConformanceReport = runConformance(opts.vectorsDir);
      if (format === 'text') {
        send(res, 200, formatReport(report), TEXT_HEADERS);
      } else {
        sendJSON(res, 200, report);
      }
    } catch (err) {
      sendJSON(res, 500, { error: 'report_failed', detail: (err as Error).message });
    }
    return;
  }

  if (pathname === '/features') {
    try {
      const index = JSON.parse(readFileSync(join(opts.vectorsDir, 'index.json'), 'utf8')) as Index;
      const features = index.vectors
        .filter((v) => v.status === 'frozen')
        .map((v) => ({ name: v.name, task: v.task, level: v.level }));
      sendJSON(res, 200, { count: features.length, features });
    } catch (err) {
      sendJSON(res, 500, { error: 'features_read_failed', detail: (err as Error).message });
    }
    return;
  }

  sendJSON(res, 404, {
    error: 'not_found',
    available_paths: ['/healthz', '/vectors', '/vectors/:name', '/report', '/features'],
  });
}

/**
 * Stand up the HTTP harness. The returned `server` has not yet listened —
 * call `server.listen(port, host?)` to bind. `close()` tears down.
 */
export function createHarness(opts: HarnessOptions): Harness {
  const server = createServer((req, res) => handle(req, res, opts));
  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
