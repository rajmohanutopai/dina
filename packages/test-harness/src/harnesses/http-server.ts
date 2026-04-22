/**
 * Minimal HTTP server for test harnesses — Node built-in `http` module.
 *
 * No Express, no Fastify — zero external dependencies. This is the smallest
 * possible real HTTP server that supports:
 * - JSON body parsing
 * - Route matching (method + path)
 * - Middleware chain (auth, rate limit, etc.)
 * - Async handlers
 * - Proper error responses
 *
 * Used by both CoreTestHarness and BrainTestHarness to boot real servers
 * that listen on localhost and process actual HTTP requests.
 */

import * as http from 'http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: Uint8Array;
  bodyJSON: unknown;
}

export interface RouteResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type RouteHandler = (req: ParsedRequest) => Promise<RouteResponse>;
export type Middleware = (
  req: ParsedRequest,
  next: () => Promise<RouteResponse>,
) => Promise<RouteResponse>;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface Route {
  method: string; // 'GET', 'POST', 'DELETE', etc.
  pathPattern: string; // exact match or ':param' patterns
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: Middleware[] = [];

  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  route(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), pathPattern: path, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.route('GET', path, handler);
  }
  post(path: string, handler: RouteHandler): void {
    this.route('POST', path, handler);
  }
  delete(path: string, handler: RouteHandler): void {
    this.route('DELETE', path, handler);
  }
  patch(path: string, handler: RouteHandler): void {
    this.route('PATCH', path, handler);
  }
  put(path: string, handler: RouteHandler): void {
    this.route('PUT', path, handler);
  }

  async handle(req: ParsedRequest): Promise<RouteResponse> {
    // Find matching route
    const route = this.routes.find(
      (r) => r.method === req.method && this.matchPath(r.pathPattern, req.path),
    );

    if (!route) {
      return { status: 404, body: { error: 'not found', path: req.path } };
    }

    // Build middleware chain with handler at the end
    const chain = this.buildChain(route.handler);
    return chain(req);
  }

  private matchPath(pattern: string, actual: string): boolean {
    // Exact match
    if (pattern === actual) return true;

    // Simple param matching: /v1/vault/item/:id matches /v1/vault/item/abc123
    const patternParts = pattern.split('/');
    const actualParts = actual.split('/');
    if (patternParts.length !== actualParts.length) return false;

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) continue; // wildcard
      if (patternParts[i] !== actualParts[i]) return false;
    }
    return true;
  }

  private buildChain(handler: RouteHandler): (req: ParsedRequest) => Promise<RouteResponse> {
    if (this.middlewares.length === 0) return handler;

    // Chain middlewares: each calls next() to continue
    let current = handler;
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      const next = current;
      current = (req: ParsedRequest) => mw(req, () => next(req));
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class TestHTTPServer {
  private server: http.Server | null = null;
  private router: Router;
  private port = 0;

  constructor(router: Router) {
    this.router = router;
  }

  /**
   * Start listening on a random available port (port 0 = OS-assigned).
   * Returns the actual port number.
   *
   * If socket binding fails (EPERM in sandboxed environments), throws
   * with a clear message. Tests using the harness should handle this
   * by skipping when the harness cannot boot.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          const parsed = await this.parseRequest(req);
          const result = await this.router.handle(parsed);

          res.writeHead(result.status, {
            'Content-Type': 'application/json',
            ...result.headers,
          });
          res.end(result.body !== undefined ? JSON.stringify(result.body) : '');
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'internal_error',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });

      // Port 0 = OS assigns a free port (no collision risk)
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
          reject(
            new Error(
              `Cannot bind socket (${err.code}). Harness-based tests require ` +
                `network access. In sandboxed environments, these tests will be skipped.`,
            ),
          );
        } else {
          reject(err);
        }
      });
    });
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Get the base URL (e.g., http://127.0.0.1:34567). */
  get baseURL(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async parseRequest(req: http.IncomingMessage): Promise<ParsedRequest> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const bodyChunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
      req.on('end', resolve);
      req.on('error', reject);
    });

    const bodyBuffer = Buffer.concat(bodyChunks);
    const body = new Uint8Array(bodyBuffer);

    let bodyJSON: unknown = undefined;
    if (bodyBuffer.length > 0) {
      try {
        bodyJSON = JSON.parse(bodyBuffer.toString('utf-8'));
      } catch {
        // Not JSON — leave as undefined
      }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }

    return {
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.search.slice(1), // remove leading '?'
      headers,
      body,
      bodyJSON,
    };
  }
}
